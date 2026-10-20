import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, it, live } from "@effect/vitest"
import { Clock, Deferred, Effect, Fiber } from "effect"
import { describe } from "vitest"
import { makeCodeModeHandlers, maxRetainedRuns, maxSourceBytes } from "../src/codemode.js"

describe("Code Mode workspaces", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("should retain isolated edits when a program updates the workspace", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()

        const first = yield* handlers.execute({
          code: `
          const listing = await tools.workspace.list_directory({path: "."});
          const draft = await tools.workspace.read_file({path: "plans/draft.md"});
          const metadata = await tools.workspace.stat({path: "plans/draft.md"});
          await tools.workspace.write_file({path: "plans/draft.md", content: "Tests pass. Rollback ready."});
          await tools.workspace.write_file({path: "report.json", content: JSON.stringify({files: listing.value.entries.length})});
          return {before: draft.value.content, kind: metadata.value.kind};
        `
        })

        assert.deepStrictEqual(first.execution.ok && first.execution.value, {
          before: "# Release plan\n\nRelease on Friday.\n",
          kind: "file"
        })
        assert.deepStrictEqual(
          first.changes.map((change) => `${change._tag}:${change.path}`).sort((a, b) => a.localeCompare(b)),
          ["Added:report.json", "Updated:plans/draft.md"]
        )
        const inspected = yield* handlers.inspect_run({ runId: first.runId, action: "read", path: "plans/draft.md" })
        assert.deepStrictEqual(inspected.entry, { path: "plans/draft.md", content: "Tests pass. Rollback ready." })
        assert.deepStrictEqual(inspected.changes, first.changes)
        assert.deepStrictEqual(
          yield* handlers.inspect_run({ runId: first.runId, action: "stat", path: "report.json" }).pipe(
            Effect.map((result) => "kind" in result.entry ? result.entry.kind : undefined)
          ),
          "file"
        )
        const base = yield* handlers.inspect_base({ action: "read", path: "plans/draft.md" })
        assert.isTrue("content" in base)

        if ("content" in base) assert.match(base.content, /Release on Friday/)

        const second = yield* handlers.execute({
          code: `
          return {
            draft: await tools.workspace.read_file({path: "plans/draft.md"}),
            report: await tools.workspace.read_file({path: "report.json"})
          };
        `
        })

        assert.deepStrictEqual(second.execution.ok && second.execution.value, {
          draft: { ok: true, value: { path: "plans/draft.md", content: "# Release plan\n\nRelease on Friday.\n" } },
          report: {
            ok: false,
            error: { code: "NotFound", operation: "open", message: "open failed with NotFound", path: "report.json" }
          }
        })
        assert.deepStrictEqual(second.changes, [])
        assert.deepStrictEqual(
          (yield* handlers.inspect_run({ runId: first.runId, action: "read", path: "report.json" })).entry,
          { path: "report.json", content: "{\"files\":3}" }
        )
      }))

    it.effect("should retain independent files when requests arrive concurrently", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()

        const results = yield* Effect.forEach(["alpha", "beta"], (content) =>
          handlers.execute({
            code: `
            await tools.workspace.write_file({path: "temporary.txt", content: "${content}"});
            return "${content}";
          `
          }), { concurrency: "unbounded" })

        assert.notStrictEqual(results[0]!.runId, results[1]!.runId)

        for (const [index, result] of results.entries()) {
          assert.deepStrictEqual(
            (yield* handlers.inspect_run({ runId: result.runId, action: "read", path: "temporary.txt" })).entry,
            { path: "temporary.txt", content: index === 0 ? "alpha" : "beta" }
          )
        }
      }))

    it.effect("should retain partial edits without changing the base when a program throws", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()

        const result = yield* handlers.execute({
          code: `
          await tools.workspace.write_file({path: "partial.txt", content: "inspect me"});
          throw new Error("stop here");
        `
        })

        assert.isFalse(result.execution.ok)
        assert.deepStrictEqual(result.changes.map((change) => change.path), ["partial.txt"])
        assert.deepStrictEqual(
          (yield* handlers.inspect_run({ runId: result.runId, action: "read", path: "partial.txt" })).entry,
          { path: "partial.txt", content: "inspect me" }
        )
        assert.strictEqual(
          (yield* handlers.inspect_base({ action: "read", path: "partial.txt" }).pipe(Effect.flip)).code,
          "NotFound"
        )
      }))

    it.effect("should deny access outside the workspace when guest or inspection paths escape", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()

        const result = yield* handlers.execute({
          code: `
          const outside = await tools.workspace.read_file({path: "../orchestrator.txt"});
          const hidden = await tools.workspace.read_file({path: "orchestrator.txt"});
          return {outside: outside.error.code, hidden: hidden.error.code, process: typeof process, fetch: typeof fetch};
        `
        })

        assert.deepStrictEqual(result.execution.ok && result.execution.value, {
          outside: "InvalidToolPath",
          hidden: "NotFound",
          process: "undefined",
          fetch: "undefined"
        })
        assert.strictEqual(
          (yield* handlers.inspect_run({ runId: result.runId, action: "read", path: "../orchestrator.txt" }).pipe(
            Effect.flip
          )).code,
          "InvalidToolPath"
        )
        assert.strictEqual(
          (yield* handlers.inspect_run({ runId: "missing", action: "list", path: "." }).pipe(Effect.flip)).code,
          "RunNotFound"
        )
      }))

    it.effect("should reject unregistered operations when a guest calls an unavailable tool", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()
        const unknown = yield* handlers.execute({ code: "await tools.workspace.remove({path: 'temporary.txt'})" })
        assert.isFalse(unknown.execution.ok)

        if (!unknown.execution.ok) assert.strictEqual(unknown.execution.error.kind, "UnknownTool")
      }))

    it.effect("should reject oversized source when it exceeds the execution limit", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()
        assert.strictEqual(
          (yield* handlers.execute({ code: " ".repeat(maxSourceBytes + 1) }).pipe(Effect.flip)).code,
          "SourceLimitExceeded"
        )
      }))

    it.effect("should leave no changes when a write exceeds the text limit", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()

        const tooLarge = yield* handlers.execute({
          code: `
          return await tools.workspace.write_file({path: "large", content: "x".repeat(65537)});
        `
        })

        assert.isTrue(tooLarge.execution.ok)

        if (tooLarge.execution.ok) {
          assert.deepStrictEqual(tooLarge.execution.value, {
            ok: false,
            error: {
              code: "TextLimitExceeded",
              operation: "write_file",
              path: "large",
              message: "Content exceeds the 64 KiB text limit."
            }
          })
        }

        assert.deepStrictEqual(tooLarge.changes, [])
      }))

    it.effect("should capture a write when its text is exactly 64 KiB", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()

        const result = yield* handlers.execute({
          code: "return await tools.workspace.write_file({path:\"boundary.txt\", content:\"x\".repeat(65536)})"
        })

        assert.deepStrictEqual(result.execution.ok && result.execution.value, {
          ok: true,
          value: { path: "boundary.txt", message: "Wrote boundary.txt" }
        })
        assert.deepStrictEqual(result.changes.map((change) => change.path), ["boundary.txt"])
        assert.deepStrictEqual(
          (yield* handlers.inspect_run({ runId: result.runId, action: "read", path: "boundary.txt" })).entry,
          { path: "boundary.txt", content: "x".repeat(65536) }
        )
      }))

    it.effect("should retain completed writes and bound diagnostics when a program throws a large multibyte error", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()

        const result = yield* handlers.execute({
          code: `
          await tools.workspace.write_file({path:"diagnostic.txt", content:"saved before throw"});
          console.log("before throw");
          throw new Error("😀".repeat(2000));
        `
        })

        assert.isFalse(result.execution.ok)

        if (!result.execution.ok) {
          assert.strictEqual(result.execution.error.kind, "ExecutionFailure")
          assert.isAtMost(new TextEncoder().encode(result.execution.error.message).byteLength, 2048)
          assert.match(result.execution.error.message, /\[diagnostic truncated\]$/u)
          assert.notInclude(result.execution.error.message, "\uFFFD")
          assert.isTrue(result.execution.truncated)
          assert.deepStrictEqual(result.execution.logs, ["before throw"])
          assert.deepStrictEqual(result.execution.toolCalls, [{ name: "workspace.write_file" }])
        }

        const retained = yield* handlers.inspect_run({ runId: result.runId, action: "read", path: "diagnostic.txt" })
        assert.deepStrictEqual(retained.execution, result.execution)
        assert.deepStrictEqual(retained.entry, { path: "diagnostic.txt", content: "saved before throw" })
        assert.strictEqual(
          (yield* handlers.inspect_base({ action: "read", path: "diagnostic.txt" }).pipe(Effect.flip)).code,
          "NotFound"
        )
      }))

    it.effect("should stop guest calls when the tool call limit is exceeded", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()

        const calls = yield* handlers.execute({
          code: "for (let i=0; i<33; i++) await tools.workspace.stat({path:\"BRIEF.md\"})"
        })

        assert.isFalse(calls.execution.ok)

        if (!calls.execution.ok) assert.strictEqual(calls.execution.error.kind, "ToolCallLimitExceeded")
      }))

    it.effect("should return a parse failure when source contains TypeScript syntax", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()
        const invalid = yield* handlers.execute({ code: "const value: string = 'unsupported'" })
        assert.isFalse(invalid.execution.ok)

        if (!invalid.execution.ok) assert.strictEqual(invalid.execution.error.kind, "ParseError")
      }))

    it.effect("should preserve retained runs when the retention limit rejects another execution", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()

        for (let index = 0; index < maxRetainedRuns; index++) yield* handlers.execute({ code: "return null" })
        assert.strictEqual(
          (yield* handlers.execute({ code: "return null" }).pipe(Effect.flip)).code,
          "RunLimitExceeded"
        )
        const retained = yield* handlers.inspect_run({ runId: "1", action: "list", path: "." })
        assert.deepStrictEqual(retained.execution.ok && retained.execution.value, null)
        assert.deepStrictEqual(retained.changes, [])
      }))

    it.effect("should discard the run and release its slot when execution is externally interrupted", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()
        const baseBefore = yield* handlers.inspect_base({ action: "list", path: "." })
        const started = yield* Deferred.make<void>()
        const clock = yield* Clock.Clock

        const fiber = yield* handlers.execute({ code: "while (true) {}" }).pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
            currentTimeMillis: clock.currentTimeMillis,
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            currentTimeNanos: clock.currentTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            sleep: (duration) => Deferred.succeed(started, undefined).pipe(Effect.andThen(clock.sleep(duration)))
          }),
          Effect.forkChild
        )

        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        assert.deepStrictEqual(yield* handlers.inspect_base({ action: "list", path: "." }), baseBefore)

        assert.strictEqual(
          (yield* handlers.inspect_run({ runId: "1", action: "list", path: "." }).pipe(Effect.flip)).code,
          "RunNotFound"
        )

        for (let index = 0; index < maxRetainedRuns; index++) {
          const next = yield* handlers.execute({ code: "return 'still running'" })
          assert.strictEqual(next.runId, String(index + 1))
          assert.deepStrictEqual(next.execution.ok && next.execution.value, "still running")
          assert.deepStrictEqual(next.changes, [])
        }
      }))

    live("should retain completed writes and recover when a program times out", () =>
      Effect.gen(function*() {
        const handlers = yield* makeCodeModeHandlers()

        const timedOut = yield* handlers.execute({
          code: `
          await tools.workspace.write_file({path: "before-timeout.txt", content: "inspect after timeout"});
          while (true) {}
        `
        })

        assert.isFalse(timedOut.execution.ok)

        if (!timedOut.execution.ok) assert.strictEqual(timedOut.execution.error.kind, "TimeoutExceeded")
        assert.deepStrictEqual(timedOut.changes.map((change) => `${change._tag}:${change.path}`), [
          "Added:before-timeout.txt"
        ])
        assert.deepStrictEqual(
          (yield* handlers.inspect_run({ runId: timedOut.runId, action: "read", path: "before-timeout.txt" })).entry,
          { path: "before-timeout.txt", content: "inspect after timeout" }
        )
        assert.strictEqual(
          (yield* handlers.inspect_base({ action: "read", path: "before-timeout.txt" }).pipe(Effect.flip)).code,
          "NotFound"
        )

        const next = yield* handlers.execute({
          code: "return await tools.workspace.read_file({path: 'before-timeout.txt'})"
        })

        assert.deepStrictEqual(next.execution.ok && next.execution.value, {
          ok: false,
          error: {
            code: "NotFound",
            operation: "open",
            message: "open failed with NotFound",
            path: "before-timeout.txt"
          }
        })
        assert.deepStrictEqual(next.changes, [])
      }).pipe(Effect.provide(BunCrypto.layer)), 10_000)
  })
})
