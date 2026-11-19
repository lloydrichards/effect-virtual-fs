import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
// Native subprocess I/O keeps the test client independent of the server’s BunStdio implementation.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import { CodeModeTools, RunResult } from "../src/codemode.js"
import { ToolFailure } from "../src/tools.js"
import { makeBaseSnapshot, projectRoot } from "../src/workspace.js"

const ResultSchema = Schema.Struct({
  protocolVersion: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String }))),
  structuredContent: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  isError: Schema.optionalKey(Schema.Boolean),
  tools: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, annotations: Schema.Record(Schema.String, Schema.Boolean) }))
  )
})

const ReplySchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Finite),
  result: Schema.optionalKey(ResultSchema),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Finite }))
})

type Result = typeof ResultSchema.Type

type Reply = typeof ReplySchema.Type

class ClientError extends Schema.TaggedError<ClientError>()("ClientError", { message: Schema.String }) {}

const WireJson = Schema.fromJsonString(Schema.Json)

const awaitExit = (child: ChildProcessWithoutNullStreams) =>
  Effect.callback<number | null>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(child.exitCode))

      return
    }

    const exited = (code: number | null) => resume(Effect.succeed(code))
    child.once("exit", exited)

    return Effect.sync(() => {
      child.removeListener("exit", exited)
    })
  })

const stop = Effect.fnUntraced(function*(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  const exited = yield* awaitExit(child).pipe(Effect.timeoutOption("3 seconds"))

  if (Option.isNone(exited)) {
    child.kill("SIGKILL")
    yield* awaitExit(child).pipe(Effect.timeout("3 seconds"), Effect.orDie)
  }
})

const connect = Effect.fnUntraced(function*(protocolVersion = "2025-11-25", entry = "mcp.ts") {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawn("bun", [fileURLToPath(new URL(`../src/${entry}`, import.meta.url))], {
        stdio: "pipe"
      })
    ),
    stop
  )

  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")

  let buffer = ""
  let sequence = 0
  const waiting = new Map<number, (reply: Effect.Effect<Reply, ClientError>) => void>()

  const rejectPending = (error: ClientError) => {
    for (const pending of waiting.values()) pending(Effect.fail(error))
  }

  const context = yield* Effect.context()

  child.stdout.on("data", (chunk) => {
    buffer += String(chunk)

    for (;;) {
      const end = buffer.indexOf("\n")

      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      Effect.runForkWith(context)(
        Schema.decodeEffect(Schema.fromJsonString(ReplySchema))(line).pipe(
          Effect.match({
            onSuccess: (reply) => {
              if (reply.id !== undefined) waiting.get(reply.id)?.(Effect.succeed(reply))
            },
            onFailure: (error) => rejectPending(new ClientError({ message: `Invalid server reply: ${String(error)}` }))
          })
        )
      )
    }
  })
  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  child.on("error", (error) => rejectPending(new ClientError({ message: String(error) })))
  child.on("exit", () => rejectPending(new ClientError({ message: `Server exited: ${stderr}` })))

  const send = Effect.fnUntraced(function*(message: Schema.Json) {
    const line = yield* Schema.encodeEffect(WireJson)(message)
    yield* Effect.sync(() => {
      child.stdin.write(`${line}\n`)
    })
  })

  const request = Effect.fnUntraced(function*(method: string, params: Schema.Json) {
    const id = ++sequence
    const line = yield* Schema.encodeEffect(WireJson)({ jsonrpc: "2.0", id, method, params })

    return yield* Effect.callback<Reply, ClientError>((resume) => {
      waiting.set(id, resume)
      child.stdin.write(`${line}\n`)

      return Effect.sync(() => {
        waiting.delete(id)
      })
    }).pipe(Effect.timeout("5 seconds"))
  })

  const initialize = yield* request("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "example-tests", version: "1" }
  })

  expect(initialize.error).toBeUndefined()
  expect(initialize.result!.protocolVersion).toBe(protocolVersion)
  const initialized = yield* Schema.encodeEffect(WireJson)({ jsonrpc: "2.0", method: "notifications/initialized" })
  child.stdin.write(`${initialized}\n`)

  const call = Effect.fnUntraced(function*(name: string, args: Record<string, Schema.Json>) {
    const reply = yield* request("tools/call", { name, arguments: args })
    expect(reply.error).toBeUndefined()

    return reply.result!
  })

  return { child, request, call, send }
})

const failure = Effect.fnUntraced(function*(result: Result) {
  expect(result.isError).toBe(true)
  expect(result.structuredContent).toBeUndefined()

  return yield* Schema.decodeEffect(Schema.fromJsonString(ToolFailure))(result.content![0]!.text)
})

it.live("should preserve the base and reset the workspace when the stdio walkthrough edits an overlay", () =>
  Effect.gen(function*() {
    const { call, request, child } = yield* connect()
    const tools = (yield* request("tools/list", {})).result!.tools!
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "create_directory",
      "inspect_base",
      "list_directory",
      "read_file",
      "remove",
      "rename",
      "stat",
      "write_file"
    ])
    expect(tools.find((tool) => tool.name === "read_file")!.annotations["readOnlyHint"]).toBe(true)
    expect(tools.find((tool) => tool.name === "write_file")!.annotations["destructiveHint"]).toBe(true)
    expect((yield* call("read_file", { path: "BRIEF.md" })).structuredContent!["content"]).toContain("rollback")
    yield* call("create_directory", { path: "release/friday" })
    yield* call("write_file", { path: "plans/draft.md", content: "Pass tests, release Friday, roll back if needed." })
    yield* call("rename", { from: "plans/draft.md", to: "release/friday/plan.md" })
    yield* call("remove", { path: "temporary.txt" })
    expect((yield* call("read_file", { path: "release/friday/plan.md" })).structuredContent!["content"]).toContain(
      "Pass tests"
    )
    expect((yield* call("stat", { path: "release/friday/plan.md" })).structuredContent).toMatchObject({
      kind: "file",
      size: "48"
    })
    expect((yield* call("inspect_base", { path: "plans/draft.md", action: "read" })).structuredContent!["content"])
      .toContain("Release on Friday.")
    expect((yield* call("inspect_base", { path: ".", action: "list" })).structuredContent!["entries"]).toContainEqual({
      name: "temporary.txt",
      kind: "file"
    })
    expect((yield* failure(yield* call("read_file", { path: "plans/draft.md" }))).code).toBe("NotFound")
    expect((yield* failure(yield* call("remove", { path: "release" }))).code).toBe("NotEmpty")
    const restarted = yield* connect("2025-06-18")
    expect((yield* restarted.call("read_file", { path: "plans/draft.md" })).structuredContent!["content"]).toContain(
      "Release on Friday."
    )
    child.kill("SIGTERM")
    expect(yield* awaitExit(child).pipe(Effect.timeout("3 seconds"))).toBe(130)
  }))

it.live("should recover from tool errors when requests contain invalid parameters or exceed limits", () =>
  Effect.gen(function*() {
    const { call, request } = yield* connect()

    for (const path of ["/BRIEF.md", "../BRIEF.md", "a/../BRIEF.md", "bad\0name", "\ud800"]) {
      expect((yield* failure(yield* call("read_file", { path }))).code).toBe("InvalidToolPath")
    }

    expect((yield* failure(yield* call("write_file", { path: "too-big", content: "é".repeat(32769) }))).code).toBe(
      "TextLimitExceeded"
    )
    expect((yield* failure(yield* call("write_file", { path: "bad-text", content: "\ud800" }))).code).toBe(
      "InvalidTextEncoding"
    )
    expect((yield* failure(yield* call("read_file", { path: "too-big" }))).code).toBe("NotFound")
    expect((yield* failure(yield* call("write_file", { path: "missing/child", content: "x" }))).code).toBe("NotFound")
    expect((yield* failure(yield* call("remove", { path: "missing" }))).code).toBe("NotFound")
    expect((yield* request("tools/call", { name: "read_file", arguments: { path: 42 } })).result!.isError).toBe(true)
    yield* call("write_file", { path: "boundary", content: "x".repeat(65536) })
    expect((yield* call("read_file", { path: "./boundary" })).structuredContent!["content"]).toHaveLength(65536)
    const unicode = "😀".repeat(16384)
    yield* call("write_file", { path: "unicode-boundary", content: unicode })
    expect((yield* call("read_file", { path: "unicode-boundary" })).structuredContent!["content"]).toBe(unicode)
  }))

it.live("should serve captured artifacts and preserve the base when Code Mode runs over stdio", () =>
  Effect.gen(function*() {
    const { call, request } = yield* connect("2025-11-25", "codemode-mcp.ts")
    expect((yield* request("tools/list", {})).result!.tools!.map((tool) => tool.name).sort()).toEqual([
      "combine_runs",
      "execute",
      "inspect_base",
      "inspect_run"
    ])

    const executed = yield* call("execute", {
      code: `
      const original = await tools.workspace.read_file({path: "plans/draft.md"});
      await tools.workspace.write_file({path: "plans/draft.md", content: "Tests pass. Rollback ready."});
      await tools.workspace.write_file({path: "report.txt", content: "Review this artifact."});
      const draft = await tools.workspace.stat({path: "plans/draft.md"});
      const files = await tools.workspace.list_directory({path: "."});
      return {original: original.value.content, kind: draft.value.kind, names: files.value.entries.map(e=>e.name)};
    `
    })

    expect(executed.isError).toBe(false)
    const first = yield* Schema.decodeUnknownEffect(RunResult)(executed.structuredContent)
    expect(first.execution).toMatchObject({
      ok: true,
      value: {
        original: "# Release plan\n\nRelease on Friday.\n",
        kind: "file",
        names: expect.arrayContaining(["report.txt"])
      }
    })
    expect(first.changes.map((change) => `${change._tag}:${change.path}`).sort((a, b) => a.localeCompare(b))).toEqual([
      "Added:report.txt",
      "Updated:plans/draft.md"
    ])
    const inspected = yield* call("inspect_run", { runId: first.runId, action: "read", path: "report.txt" })

    const artifact = yield* Schema.decodeUnknownEffect(CodeModeTools.tools.inspect_run.successSchema)(
      inspected.structuredContent
    )

    expect(artifact.entry).toEqual({ path: "report.txt", content: "Review this artifact." })
    expect(artifact.changes).toEqual(first.changes)
    expect(
      (yield* call("inspect_run", { runId: first.runId, action: "stat", path: "report.txt" }))
        .structuredContent?.["entry"]
    ).toMatchObject({ kind: "file" })
    expect(
      (yield* call("inspect_run", { runId: first.runId, action: "read", path: "plans/draft.md" }))
        .structuredContent?.["entry"]
    ).toEqual({ path: "plans/draft.md", content: "Tests pass. Rollback ready." })
    expect((yield* call("inspect_base", { action: "read", path: "plans/draft.md" })).structuredContent!["content"])
      .toContain("Release on Friday.")

    const second = yield* call("execute", {
      code: `return {
        draft: await tools.workspace.read_file({path: "plans/draft.md"}),
        report: await tools.workspace.read_file({path: "report.txt"})
      }`
    })

    const fresh = yield* Schema.decodeUnknownEffect(RunResult)(second.structuredContent)
    expect(fresh.execution).toMatchObject({
      ok: true,
      value: {
        draft: { ok: true, value: { content: "# Release plan\n\nRelease on Friday.\n" } },
        report: { ok: false, error: { code: "NotFound", operation: "open", path: "report.txt" } }
      }
    })
    expect(fresh.changes).toEqual([])
  }))

it.live("should retain partial edits for inspection when a Code Mode program fails over stdio", () =>
  Effect.gen(function*() {
    const { call } = yield* connect("2025-11-25", "codemode-mcp.ts")

    const failed = yield* call("execute", {
      code: "await tools.workspace.write_file({path:\"partial.txt\",content:\"kept\"}); throw new Error(\"stop\")"
    })

    expect(failed.isError).toBe(false)
    const partial = yield* Schema.decodeUnknownEffect(RunResult)(failed.structuredContent)
    expect(partial.execution).toMatchObject({ ok: false, error: { kind: "ExecutionFailure" } })
    expect(partial.changes.map((change) => change.path)).toEqual(["partial.txt"])
    expect(
      (yield* call("inspect_run", { runId: partial.runId, action: "read", path: "partial.txt" }))
        .structuredContent!["entry"]
    )
      .toEqual({ path: "partial.txt", content: "kept" })
    expect((yield* failure(yield* call("inspect_base", { action: "read", path: "partial.txt" }))).code).toBe("NotFound")
  }))

it.live("should return a combined artifact through the Code Mode toolkit", () =>
  Effect.gen(function*() {
    const { call } = yield* connect("2025-11-25", "codemode-mcp.ts")

    const rename = yield* call("execute", {
      code: "return await tools.workspace.rename({ from: \"plans/draft.md\", to: \"plans/moved.md\" })"
    })

    const edit = yield* call("execute", {
      code: "return await tools.workspace.write_file({ path: \"plans/draft.md\", content: \"Edited plan.\" })"
    })

    const ours = yield* Schema.decodeUnknownEffect(RunResult)(rename.structuredContent)
    const theirs = yield* Schema.decodeUnknownEffect(RunResult)(edit.structuredContent)
    const combined = yield* call("combine_runs", { ours: ours.runId, theirs: theirs.runId })
    expect(combined.isError).toBe(false)

    const result = yield* Schema.decodeUnknownEffect(CodeModeTools.tools.combine_runs.successSchema)(
      combined.structuredContent
    )

    if (result.status !== "ready") throw new Error("Expected a ready handoff")

    const header = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({
      format: Schema.Literal("effect-vfs-delta"),
      version: Schema.Literal(1)
    })))(result.delta)

    expect(header).toEqual({ format: "effect-vfs-delta", version: 1 })
  }))

it.live("should discard the workspace and recover when an MCP client cancels execution", () =>
  Effect.gen(function*() {
    const { call, request, send } = yield* connect("2025-11-25", "codemode-mcp.ts")
    yield* send({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: {
        name: "execute",
        arguments: {
          code: "await tools.workspace.write_file({path:'cancelled.txt',content:'discard me'}); while (true) {}"
        }
      }
    })
    yield* request("ping", {})
    yield* send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 100, reason: "Client cancelled execution" }
    })
    expect((yield* failure(yield* call("inspect_run", { runId: "1", path: ".", action: "list" }))).code)
      .toBe("RunNotFound")
    expect((yield* failure(yield* call("inspect_base", { path: "cancelled.txt", action: "read" }))).code)
      .toBe("NotFound")

    const fresh = yield* Schema.decodeUnknownEffect(RunResult)(
      (yield* call("execute", { code: "return await tools.workspace.read_file({path:'cancelled.txt'})" }))
        .structuredContent
    )

    expect(fresh.runId).toMatch(/\/1$/)
    expect(fresh.execution).toMatchObject({ ok: true, value: { ok: false, error: { code: "NotFound" } } })
    expect(fresh.changes).toEqual([])
  }))

it.live("should complete the packed Code Mode release handoff over MCP", () =>
  Effect.gen(function*() {
    const { call } = yield* connect("2025-11-25", "codemode-mcp.ts")

    const execute = Effect.fnUntraced(function*(code: string) {
      const result = yield* call("execute", { code })
      const run = yield* Schema.decodeUnknownEffect(RunResult)(result.structuredContent)
      expect(run.execution.ok).toBe(true)

      return run.runId
    })

    const merge = Effect.fnUntraced(function*(args: Record<string, Schema.Json>) {
      const result = yield* call("combine_runs", args)
      expect(result.isError).toBe(false)

      return yield* Schema.decodeUnknownEffect(CodeModeTools.tools.combine_runs.successSchema)(
        result.structuredContent
      )
    })

    const apply = Effect.fnUntraced(function*(delta: string) {
      const base = yield* makeBaseSnapshot(true)
      const decoded = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(new TextEncoder().encode(delta))
      const volume = yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(base, decoded))

      return yield* (yield* volume.caller()).withRoot(projectRoot)
    })

    const read = (caller: Vfs.Caller, path: string) =>
      Effect.map(caller.readFile(path), (bytes) => new TextDecoder().decode(bytes))

    const rename = yield* execute(
      "return await tools.workspace.rename({from:\"plans/draft.md\",to:\"plans/moved.md\"})"
    )

    const edit = yield* execute(
      "return await tools.workspace.write_file({path:\"plans/draft.md\",content:\"QA approved\"})"
    )

    const clean = yield* merge({ ours: rename, theirs: edit })

    if (clean.status !== "ready") throw new Error("Expected a ready handoff")

    const applied = yield* apply(clean.delta)
    expect(yield* read(applied, "plans/moved.md")).toBe("QA approved")
    expect((yield* Effect.flip(applied.stat("plans/draft.md"))).code).toBe("NotFound")

    const ours = yield* execute(
      "await tools.workspace.rename({from:\"plans/draft.md\",to:\"plans/friday.md\"});" +
        "return await tools.workspace.write_file({path:\"BRIEF.md\",content:\"Friday brief\"})"
    )

    const theirs = yield* execute(
      "await tools.workspace.rename({from:\"plans/draft.md\",to:\"plans/rollback.md\"});" +
        "return await tools.workspace.write_file({path:\"BRIEF-copy.md\",content:\"Rollback brief\"})"
    )

    const preview = yield* merge({ ours, theirs })

    if (preview.status !== "preview") throw new Error("Expected a preview with two choices")

    expect(preview.conflicts).toHaveLength(2)
    const renameGroup = preview.conflicts.find((group) => group.kind === "rename")!
    const linkGroup = preview.conflicts.find((group) => group.kind === "path")!
    expect(renameGroup.affectedPaths).toEqual(
      ["draft.md", "friday.md", "rollback.md"].map((name) => projectRoot + "/plans/" + name)
    )
    expect(linkGroup.affectedPaths).toEqual(["BRIEF-copy.md", "BRIEF.md"].map((name) => projectRoot + "/" + name))
    expect(yield* read(yield* apply(preview.previewDelta), "plans/draft.md")).toContain("Release on Friday.")

    const first = { key: renameGroup.key, take: "ours" } as const
    const partial = yield* merge({ ours, theirs, resolutions: [first] })

    if (partial.status !== "preview") throw new Error("Expected the remaining hard-link conflict")

    expect(partial.conflicts.map((group) => group.key)).toEqual([linkGroup.key])
    const stale = yield* call("combine_runs", { ours: theirs, theirs: ours, resolutions: [first] })
    expect((yield* failure(stale)).code).toBe("InvalidArgument")
    const duplicate = yield* call("combine_runs", { ours, theirs, resolutions: [first, first] })
    expect((yield* failure(duplicate)).code).toBe("InvalidArgument")

    const final = yield* merge({ ours, theirs, resolutions: [first, { key: linkGroup.key, take: "theirs" }] })

    if (final.status !== "ready") throw new Error("Expected all choices to settle the handoff")

    const handoff = yield* apply(final.delta)
    expect(yield* read(handoff, "plans/friday.md")).toContain("Release on Friday.")
    expect((yield* Effect.flip(handoff.stat("plans/draft.md"))).code).toBe("NotFound")
    expect((yield* Effect.flip(handoff.stat("plans/rollback.md"))).code).toBe("NotFound")
    expect(yield* read(handoff, "BRIEF.md")).toBe("Rollback brief")
    expect(yield* read(handoff, "BRIEF-copy.md")).toBe("Rollback brief")
    expect(
      (yield* call("inspect_run", { runId: ours, action: "read", path: "BRIEF.md" }))
        .structuredContent!["entry"]
    ).toEqual({ path: "BRIEF.md", content: "Friday brief" })

    const unsupported = yield* execute("return await tools.workspace.rename({from:\"plans\",to:\"archived-plans\"})")
    expect(yield* failure(yield* call("combine_runs", { ours: unsupported, theirs: edit }))).toMatchObject({
      code: "InvalidStructure",
      field: "renameLineage",
      path: projectRoot + "/plans"
    })

    const restarted = yield* connect("2025-11-25", "codemode-mcp.ts")
    yield* restarted.call("execute", { code: "return 1" })
    yield* restarted.call("execute", { code: "return 2" })
    expect((yield* failure(yield* restarted.call("combine_runs", { ours: rename, theirs: edit }))).code)
      .toBe("RunNotAvailable")
  }).pipe(Effect.provide(BunCrypto.layer)))
