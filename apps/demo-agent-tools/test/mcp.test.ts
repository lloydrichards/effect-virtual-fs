import { it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
// Native subprocess I/O keeps the test client independent of the server’s BunStdio implementation.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import { ToolFailure } from "../src/tools.js"

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

const connect = Effect.fnUntraced(function*(protocolVersion = "2025-11-25") {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() => spawn("bun", [fileURLToPath(new URL("../src/mcp.ts", import.meta.url))], { stdio: "pipe" })),
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

  return { child, request, call }
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
