import { BytePath, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { CodeMode, Tool as CodeTool } from "@opencode/codemode"
import { ByteSize, Cause, Crypto, Effect, Predicate, Schema, Semaphore } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { handlersFor, ToolFailure, VolumeTools } from "./tools.js"
import { makeBaseSnapshot, projectRoot } from "./workspace.js"

export const maxSourceBytes = 8 * 1024

export const maxRetainedRuns = 8

const encoder = new TextEncoder()

const infrastructureFailure = (error: Vfs.VfsError) =>
  Effect.fail({ code: error.code, operation: error.operation, message: error.message })

const outcome = <S extends Schema.Top>(success: S) =>
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value: success }),
    Schema.Struct({ ok: Schema.Literal(false), error: ToolFailure })
  ])

const workspaceOutcome = <A>(operation: string, effect: Effect.Effect<A, typeof ToolFailure.Type>) =>
  effect.pipe(
    Effect.match({
      onSuccess: (value) => ({ ok: true as const, value }),
      onFailure: (error) => ({ ok: false as const, error })
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.succeed({
          ok: false as const,
          error: { code: "InternalToolError", operation, message: "Workspace operation failed." }
        })
    )
  )

const guestTools = (caller: Vfs.Caller) => {
  const handlers = handlersFor(caller, caller)

  return {
    workspace: {
      read_file: CodeTool.make({
        description: "Read project-relative UTF-8 text, at most 64 KiB.",
        input: VolumeTools.tools.read_file.parametersSchema,
        output: outcome(VolumeTools.tools.read_file.successSchema),
        execute: (input) => workspaceOutcome("read_file", handlers.read_file(input))
      }),
      write_file: CodeTool.make({
        description: "Create or replace project-relative UTF-8 text, at most 64 KiB. Parent must exist.",
        input: VolumeTools.tools.write_file.parametersSchema,
        output: outcome(VolumeTools.tools.write_file.successSchema),
        execute: (input) => workspaceOutcome("write_file", handlers.write_file(input))
      }),
      list_directory: CodeTool.make({
        description: "List at most 200 project-relative entries. Use '.' for the root.",
        input: VolumeTools.tools.list_directory.parametersSchema,
        output: outcome(VolumeTools.tools.list_directory.successSchema),
        execute: (input) => workspaceOutcome("list_directory", handlers.list_directory(input))
      }),
      stat: CodeTool.make({
        description: "Read project-relative metadata. Size and nanosecond timestamp are decimal strings.",
        input: VolumeTools.tools.stat.parametersSchema,
        output: outcome(VolumeTools.tools.stat.successSchema),
        execute: (input) => workspaceOutcome("stat", handlers.stat(input))
      })
    }
  }
}

const Change = Schema.Struct({
  _tag: Schema.Literals(["Added", "Removed", "Replaced", "Renamed", "Updated"]),
  path: Schema.String,
  from: Schema.optionalKey(Schema.String),
  kind: Vfs.OverlayNodeKind,
  differences: Schema.Array(Vfs.OverlayDifference)
})

export const RunResult = Schema.Struct({
  runId: Schema.String,
  execution: CodeMode.Result,
  changes: Schema.Array(Change)
})

const EntryResult = Schema.Union([
  VolumeTools.tools.read_file.successSchema,
  VolumeTools.tools.list_directory.successSchema,
  VolumeTools.tools.stat.successSchema
])

const Inspect = Schema.Struct({ path: Schema.String, action: Schema.Literals(["read", "list", "stat"]) })

const Execute = Tool.make("execute", {
  description:
    `Run a supported JavaScript script with top-level await and return. Each call starts from the unchanged ` +
    `base in a fresh overlay. No imports, TypeScript syntax, shell, network, or extensions. Await intended writes. ` +
    `Tools return { ok: true, value } or { ok: false, error }. Program diagnostics are execution.ok=false, not MCP ` +
    `transport errors. Results and changes remain inspectable by runId. Source limit: 8 KiB. ` +
    `Use tools.workspace.read_file({path}) for value {path,content}, write_file({path,content}) for ` +
    `value {path,message}, list_directory({path}) for value {path,entries:[{name,kind}]}, and stat({path}) ` +
    `for value {path,kind,size,mode,mtimeNs}. Paths are project-relative; '.' is the root. ` +
    `search({query}) discovers their exact signatures.`,
  parameters: Schema.Struct({ code: Schema.String }),
  success: RunResult,
  failure: ToolFailure,
  failureMode: "return"
}).annotate(Tool.Destructive, false).annotate(Tool.OpenWorld, false)

const InspectRun = Tool.make("inspect_run", {
  description: "Read, list, or stat a captured execution workspace and return its result and change summary.",
  parameters: Schema.Struct({ runId: Schema.String, ...Inspect.fields }),
  success: Schema.Struct({ ...RunResult.fields, entry: EntryResult }),
  failure: ToolFailure,
  failureMode: "return"
}).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.OpenWorld, false)

const InspectBase = Tool.make("inspect_base", {
  description: "Read, list, or stat the unchanged project base. Paths are project-relative.",
  parameters: Inspect,
  success: EntryResult,
  failure: ToolFailure,
  failureMode: "return"
}).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.OpenWorld, false)

export const CodeModeTools = Toolkit.make(Execute, InspectRun, InspectBase)

const summarize = Effect.fnUntraced(function*(changes: ReadonlyArray<Vfs.OverlayChange>) {
  const relative = Effect.fnUntraced(function*(path: BytePath.BytePath) {
    const text = yield* BytePath.toString(path)

    return text === projectRoot ? "." : text.slice(projectRoot.length + 1)
  })

  return yield* Effect.forEach(
    changes,
    Effect.fnUntraced(function*(change) {
      const summary = {
        _tag: change._tag,
        path: yield* relative(Predicate.isTagged(change, "Renamed") ? change.to : change.path),
        kind: Predicate.isTagged(change, "Replaced") ? change.afterKind : change.kind,
        differences: "differences" in change ? change.differences : []
      }

      if (Predicate.isTagged(change, "Renamed")) return { ...summary, from: yield* relative(change.from) }

      return summary
    })
  ).pipe(Effect.catchTag("VfsError", infrastructureFailure))
})

const inspect = Effect.fnUntraced(function*(snapshot: Vfs.Snapshot, request: typeof Inspect.Type) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const volume = yield* Vfs.fromSnapshot(snapshot)
    const caller = yield* (yield* volume.caller()).withRoot(projectRoot)
    const handlers = handlersFor(caller, caller)

    if (request.action === "read") return yield* handlers.read_file(request)

    if (request.action === "list") return yield* handlers.list_directory(request)

    return yield* handlers.stat(request)
  })).pipe(Effect.catchTag("VfsError", infrastructureFailure))
})

export const makeCodeModeHandlers = Effect.fn("CodeMode.make")(function*() {
  const base = yield* makeBaseSnapshot()
  const crypto = yield* Crypto.Crypto
  const gate = yield* Semaphore.make(1)
  const runs = new Map<string, { readonly snapshot: Vfs.Snapshot; readonly result: typeof RunResult.Type }>()
  let sequence = 0

  return CodeModeTools.of({
    execute: Effect.fn("CodeMode.execute")(function*({ code }) {
      if (encoder.encode(code).byteLength > maxSourceBytes) {
        return yield* Effect.fail({
          code: "SourceLimitExceeded",
          operation: "execute",
          message: "Source exceeds the 8 KiB limit."
        })
      }

      return yield* gate.withPermit(Effect.scoped(Effect.gen(function*() {
        if (runs.size >= maxRetainedRuns) {
          return yield* Effect.fail({
            code: "RunLimitExceeded",
            operation: "execute",
            message: "Eight runs retained. Restart to clear them."
          })
        }

        const overlay = yield* Vfs.makeOverlay(base, {
          maxBytes: ByteSize.kilobytes(256),
          maxFileBytes: ByteSize.kilobytes(64),
          maxEntries: 128,
          maxPendingOperations: 16
        })

        const caller = yield* (yield* overlay.caller()).withRoot(projectRoot)

        const runtime = CodeMode.make({
          tools: guestTools(caller),
          limits: { timeoutMs: 5_000, maxToolCalls: 32, maxOutputBytes: 16_384 }
        })

        const execution = yield* runtime.execute(code)
        const captured = yield* overlay.capture()
        const result = { runId: String(++sequence), execution, changes: yield* summarize(captured.changes) }
        runs.set(result.runId, { snapshot: captured.snapshot, result })

        return result
      }))).pipe(Effect.catchTag("VfsError", infrastructureFailure))
    }, Effect.provideService(Crypto.Crypto, crypto)),
    inspect_run: Effect.fn("CodeMode.inspectRun")(function*(request) {
      const run = runs.get(request.runId)

      if (run === undefined) {
        return yield* Effect.fail({ code: "RunNotFound", operation: "inspect_run", message: "Unknown run ID." })
      }

      return { ...run.result, entry: yield* inspect(run.snapshot, request) }
    }, Effect.provideService(Crypto.Crypto, crypto)),
    inspect_base: Effect.fn("CodeMode.inspectBase")((request) =>
      inspect(base, request).pipe(Effect.provideService(Crypto.Crypto, crypto))
    )
  })
})
