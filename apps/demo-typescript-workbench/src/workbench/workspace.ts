// Node compiler and module-loader calls are the native boundary; VFS workflows retain Effect contracts.
/* eslint-disable effecttsgo/node-builtin-import, effecttsgo/schema-sync */
import { BytePath, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { NodeVirtualProvider } from "@effect-vfs/node"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as ByteSize from "effect/ByteSize"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Scope from "effect/Scope"
import assert from "node:assert/strict"
import { Console } from "node:console"
import * as fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { Writable } from "node:stream"
import { create } from "node:vfs"
import type * as TS from "typescript-js"
import { type Diagnostic, type InternalCommand, type Reply, type View, WorkbenchError } from "./domain.ts"

const require = createRequire(import.meta.url)

const compilerPath = require.resolve("typescript-js")

export const initialSources = {
  "/src/index.ts":
    "import { summarize } from \"./format\";\n\nconst tasks = [\"Edit TypeScript\", \"Compile in memory\", \"Run with Node\"];\nconsole.log(summarize(tasks));\nconsole.log(\"Everything above ran from the mounted VFS.\");\n",
  "/src/format.ts":
    "export function summarize(items: string[]): string {\n  return items.map((item, index) => `${index + 1}. ${item}`).join(\"\\n\");\n}\n"
}

const limits = {
  maxEncodedBytes: ByteSize.mebibytes(80),
  maxDecodedBytes: ByteSize.mebibytes(60),
  maxEntries: 10000,
  maxRecords: 10000
}

const identity = (uid: number) => ({ identity: { uid, gid: uid, groups: [], privileged: false }, umask: 0o022 })

const failure = (cause: unknown) => new WorkbenchError({ message: String(cause) })

type Routing = ReturnType<typeof create> & { mount(): string; unmount(): void }

function fixture() {
  const entries: Array<Vfs.Fixture["entries"][number]> = [
    { kind: "directory", path: "/src", metadata: { uid: 1000, gid: 1000, mode: 0o755 } },
    { kind: "directory", path: "/dist", metadata: { uid: 2000, gid: 2000, mode: 0o755 } },
    { kind: "directory", path: "/compiler", metadata: { mode: 0o555 } },
    { kind: "file", path: "/compiler/typescript.cjs", bytes: fs.readFileSync(compilerPath), metadata: { mode: 0o444 } },
    ...Object.entries(initialSources).map(([entry, text]) => ({
      kind: "file" as const,
      path: entry,
      bytes: Buffer.from(text),
      metadata: { uid: 1000, gid: 1000, mode: 0o644 }
    }))
  ]

  for (const name of fs.readdirSync(path.dirname(compilerPath)).filter((name) => /^lib\..*\.d\.ts$/.test(name))) {
    entries.push({
      kind: "file",
      path: `/compiler/${name}`,
      bytes: fs.readFileSync(path.join(path.dirname(compilerPath), name)),
      metadata: { mode: 0o444 }
    })
  }

  entries.push({ kind: "directory", path: "/node_modules", metadata: { mode: 0o555 } }, {
    kind: "directory",
    path: "/node_modules/@types",
    metadata: { mode: 0o555 }
  })

  const copyTypes = (host: string, virtual: string) => {
    entries.push({ kind: "directory", path: virtual, metadata: { mode: 0o555 } })

    for (const item of fs.readdirSync(host, { withFileTypes: true })) {
      const source = path.join(host, item.name)
      const target = `${virtual}/${item.name}`

      if (item.isDirectory()) copyTypes(source, target)
      else if (item.isFile() && /\.(ts|json)$/.test(item.name)) {
        entries.push({ kind: "file", path: target, bytes: fs.readFileSync(source), metadata: { mode: 0o444 } })
      }
    }
  }

  copyTypes(path.dirname(require.resolve("@types/node/package.json")), "/node_modules/@types/node")
  copyTypes(path.dirname(require.resolve("undici-types/package.json")), "/node_modules/undici-types")

  return { entries, rootMetadata: { mode: 0o755 } }
}

export const makeWorkspace = Effect.gen(function*() {
  let volume: Vfs.OverlayVolume | undefined
  let generation = 0
  let revision = 0
  let checkpoint = 0
  let build: View["build"] = null
  let output: View["output"] = []
  let runRevision: number | null = null
  let truncated = false
  let notice = "Ready. Edit a source file, then compile and run."

  const withMount = <A>(uid: number, use: (root: string) => Effect.Effect<A, WorkbenchError>) =>
    Effect.scoped(Effect.gen(function*() {
      const scope = yield* Scope.make()
      let routing: Routing | undefined
      let root: string | undefined

      const acquire = Effect.gen(function*() {
        if (!volume) return yield* new WorkbenchError({ message: "Workspace has not started" })

        const provider = yield* NodeVirtualProvider.bind(volume, { caller: identity(uid) }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(failure)
        )

        return yield* Effect.try({
          try: () => {
            // SAFETY: mount/unmount are present in the qualified Node 26.11.1 runtime, but omitted by its types.
            routing = create(provider) as Routing
            root = routing.mount()

            return root
          },
          catch: failure
        })
      }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))

      const mounted = yield* Effect.acquireRelease(
        acquire,
        () =>
          Scope.close(scope, Exit.void).pipe(Effect.ensuring(Effect.sync(() => {
            routing?.unmount()

            if (root) {
              assert.equal(fs.existsSync(`${root}/src/index.ts`), false)
              assert.equal(Object.keys(require.cache).some((entry) => entry.startsWith(`${root}/`)), false)
            }
          })))
      )

      return yield* use(mounted)
    }))

  const view = Effect.gen(function*() {
    if (!volume) return yield* new WorkbenchError({ message: "Workspace has not started" })
    const viewer = yield* volume.caller(identity(3000)).pipe(Effect.mapError(failure))
    const files: Array<{ path: string; text: string }> = []

    for (const file of ["/src/index.ts", "/src/format.ts", "/dist/index.js", "/dist/format.js"]) {
      const bytes = yield* viewer.readFile(file).pipe(
        Effect.asSome,
        Effect.catchIf((error) => error.code === "NotFound", () => Effect.succeed(Option.none<Uint8Array>())),
        Effect.mapError(failure)
      )

      if (Option.isSome(bytes)) files.push({ path: file, text: Buffer.from(bytes.value).toString() })
    }

    const changes: Array<{ kind: string; path: string }> = []

    for (const change of yield* volume.changes().pipe(Effect.mapError(failure))) {
      const entry = Predicate.isTagged(change, "Renamed") ? change.to : change.path
      changes.push({ kind: change._tag, path: yield* BytePath.toString(entry).pipe(Effect.mapError(failure)) })
    }

    return {
      generation,
      revision,
      files,
      changes,
      build,
      output,
      runRevision,
      truncated,
      notice,
      checkpoint
    } satisfies View
  })

  const execute = Effect.fn("Workspace.execute")(function*(command: InternalCommand) {
    if (command.action === "boot") {
      const base = command.snapshot
        ? yield* Vfs.decodeSnapshot(command.snapshot, limits).pipe(Effect.mapError(failure))
        : yield* Vfs.fromFixture(fixture(), { execution: "sync" }).pipe(
          Effect.flatMap((seed) => seed.snapshot),
          Effect.mapError(failure)
        )

      volume = yield* Vfs.makeOverlay(base, { execution: "sync" }).pipe(Effect.mapError(failure))
      generation = command.generation
      revision = 0
      build = null
      output = []
      runRevision = null
      notice = command.snapshot
        ? "Save point restored. Compile before running."
        : "Ready. Edit a source file, then compile and run."
      const snapshot = yield* Vfs.encodeSnapshot(base, limits).pipe(Effect.mapError(failure))

      return { view: yield* view, snapshot } satisfies Reply
    }

    if (!volume) return yield* new WorkbenchError({ message: "Workspace has not started" })

    if (command.generation !== generation || command.revision !== revision) {
      return yield* new WorkbenchError({ message: "The workspace changed. Refresh before applying this action." })
    }

    if (command.edits.length > 0 && command.action === "run") {
      return yield* new WorkbenchError({ message: "Compile your edited files before running." })
    }

    const editor = yield* volume.caller(identity(1000)).pipe(Effect.mapError(failure))
    let edited = false

    for (const edit of command.edits) {
      const bytes = yield* editor.readFile(edit.path).pipe(Effect.mapError(failure))

      if (Buffer.from(bytes).toString() === edit.text) continue

      if (!edited) {
        revision++
        edited = true
      }

      yield* editor.writeFile(edit.path, Buffer.from(edit.text), { access: "write", truncate: true }).pipe(
        Effect.mapError(failure)
      )
    }

    if (command.action === "compile") {
      const diagnostics: Array<typeof Diagnostic.Type> = []
      const pending = { revision, status: "failed" as const, diagnostics, inputs: 0 }
      build = pending

      const checked = yield* Effect.exit(
        withMount(command.role === "viewer" ? 3000 : 2000, (root) =>
          Effect.try({
            try: () => {
              const ts: typeof TS = require(`${root}/compiler/typescript.cjs`)

              const program = ts.createProgram([`${root}/src/index.ts`], {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
                moduleResolution: ts.ModuleResolutionKind.Node10,
                strict: true,
                noEmitOnError: true,
                types: ["node"],
                typeRoots: [`${root}/node_modules/@types`],
                lib: ["lib.es2022.d.ts"],
                rootDir: `${root}/src`,
                outDir: `${root}/dist`
              })

              const pre = ts.getPreEmitDiagnostics(program)
              const emitted = program.emit()
              const inputs = program.getSourceFiles()
              assert.ok(
                inputs.length > 2 && inputs.every((file) => file.fileName.startsWith(`${root}/`)),
                "Compiler input escaped mount"
              )
              pending.inputs = inputs.length
              const seen = new Set<string>()

              for (const diagnostic of [...pre, ...emitted.diagnostics]) {
                const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n").replaceAll(root, "")
                const key = `${diagnostic.code}:${diagnostic.file?.fileName}:${diagnostic.start}:${message}`

                if (seen.has(key)) continue
                seen.add(key)
                pending.diagnostics.push({
                  code: diagnostic.code,
                  message,
                  file: diagnostic.file?.fileName.replace(root, "") ?? "",
                  line: diagnostic.file
                    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1
                    : 0
                })
              }

              return !emitted.emitSkipped &&
                ![...pre, ...emitted.diagnostics].some((item) => item.category === ts.DiagnosticCategory.Error)
            },
            catch: failure
          }))
      )

      if (Exit.isSuccess(checked) && checked.value) build = { ...pending, status: "success" }
      else if (Exit.isFailure(checked)) {
        pending.diagnostics.push({ code: 0, file: "", line: 0, message: Cause.pretty(checked.cause) })
      }

      notice = build.status === "success"
        ? "Compiled through the mounted VFS. Ready to run."
        : "Compilation failed. Previous JavaScript is not current."
    } else if (command.action === "run") {
      if (!build || build.status !== "success" || build.revision !== revision) {
        return yield* new WorkbenchError({ message: "Compile the current source before running." })
      }

      output = []
      truncated = false
      runRevision = null
      let size = 0

      const stream = (channel: "stdout" | "stderr") =>
        new Writable({
          write(chunk, _encoding, done) {
            const text = Buffer.from(chunk).toString()
            const remaining = Math.max(0, 32000 - size)

            if (remaining) output = [...output, { channel, text: text.slice(0, remaining) }]
            size += text.length

            if (size > 32000) truncated = true
            done()
          }
        })

      const result = yield* Effect.exit(withMount(3000, (root) =>
        Effect.scoped(Effect.gen(function*() {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = globalThis.console
              const stdout = stream("stdout")
              const stderr = stream("stderr")
              globalThis.console = new Console({ stdout, stderr })

              return { previous, stdout, stderr }
            }),
            ({ previous, stdout, stderr }) =>
              Effect.sync(() => {
                globalThis.console = previous
                stdout.destroy()
                stderr.destroy()
              })
          )
          yield* Effect.try({
            try: () => {
              require(`${root}/dist/index.js`)
            },
            catch: failure
          })
        }))))

      if (Exit.isFailure(result)) {
        const message = Cause.pretty(result.cause)
        const remaining = Math.max(0, 32000 - size)

        if (message.length > remaining) truncated = true

        if (remaining) output = [...output, { channel: "stderr", text: message.slice(0, remaining) }]
      } else runRevision = revision
      notice = Exit.isSuccess(result) ? "Executed emitted JavaScript with Node." : "Node execution failed."
    } else if (command.action === "save") {
      const captured = yield* volume.capture().pipe(Effect.mapError(failure))
      const snapshot = yield* Vfs.encodeSnapshot(captured.snapshot, limits).pipe(Effect.mapError(failure))
      volume = yield* Vfs.makeOverlay(captured.snapshot, { execution: "sync" }).pipe(Effect.mapError(failure))
      generation++
      revision = 0
      checkpoint++
      build = null
      runRevision = null
      notice = "Save point captured. Compile before running this workspace generation."

      return { view: yield* view, snapshot } satisfies Reply
    }

    return { view: yield* view } satisfies Reply
  })

  return { execute: (command: InternalCommand) => execute(command).pipe(Effect.provide(NodeCrypto.layer)) }
})
