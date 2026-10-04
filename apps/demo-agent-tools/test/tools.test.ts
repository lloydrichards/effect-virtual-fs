import { BytePath, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { describe } from "vitest"
import { handlersFor } from "../src/tools.js"
import { makeWorkspace } from "../src/workspace.js"

const encode = (text: string) => new TextEncoder().encode(text)

describe("bounded text toolkit", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("keeps tool paths rooted after project rename and hides volume-level data", () =>
      Effect.gen(function*() {
        const { caller, baseCaller, owner } = yield* makeWorkspace()
        const handlers = handlersFor(caller, baseCaller)
        yield* owner.rename("/projects/release", "/projects/renamed-release")
        yield* caller.symlink("/BRIEF.md", "/brief-link")
        assert.match((yield* handlers.read_file({ path: "brief-link" })).content, /rollback/)
        assert.strictEqual((yield* handlers.read_file({ path: "orchestrator.txt" }).pipe(Effect.flip)).code, "NotFound")
        assert.deepStrictEqual(
          (yield* handlers.list_directory({ path: "." })).entries.map((entry) => entry.name).sort(),
          ["BRIEF.md", "brief-link", "plans", "temporary.txt"]
        )
        yield* handlers.write_file({ path: "plans/draft.md", content: "Revised plan." })
        const original = yield* handlers.inspect_base({ path: "plans/draft.md", action: "read" })
        assert.isTrue("content" in original)

        if ("content" in original) assert.match(original.content, /Release on Friday/)
      }))
    it.effect("rejects oversized and malformed file bytes and continues serving valid reads", () =>
      Effect.gen(function*() {
        const { caller, baseCaller } = yield* makeWorkspace()
        const handlers = handlersFor(caller, baseCaller)
        yield* caller.writeFile("large", new Uint8Array(65537), { access: "write", create: "exclusive" })
        yield* caller.writeFile("binary", new Uint8Array([255]), { access: "write", create: "exclusive" })
        assert.strictEqual((yield* handlers.read_file({ path: "large" }).pipe(Effect.flip)).code, "TextLimitExceeded")
        assert.strictEqual(
          (yield* handlers.read_file({ path: "binary" }).pipe(Effect.flip)).code,
          "InvalidTextEncoding"
        )
        yield* caller.remove("large")
        yield* caller.remove("binary")
        assert.strictEqual((yield* handlers.read_file({ path: "BRIEF.md" })).path, "BRIEF.md")
      }))
    it.effect("rejects oversized listings and byte names without replacement", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({
          entries: Array.from(
            { length: 201 },
            (_, index) => ({ kind: "file" as const, path: `/f${index}`, bytes: encode("x") })
          )
        })

        const caller = yield* volume.caller()
        const handlers = handlersFor(caller, caller)
        assert.strictEqual(
          (yield* handlers.list_directory({ path: "." }).pipe(Effect.flip)).code,
          "DirectoryLimitExceeded"
        )
        yield* caller.mkdir("bytes")
        yield* caller.writeFile(
          yield* BytePath.fromBytes(new Uint8Array([98, 121, 116, 101, 115, 47, 255])),
          encode("x"),
          { access: "write", create: "exclusive" }
        )
        assert.strictEqual(
          (yield* handlers.list_directory({ path: "bytes" }).pipe(Effect.flip)).code,
          "InvalidNameEncoding"
        )
        yield* caller.remove("f200")
        yield* caller.remove("bytes", { recursive: true })
        assert.strictEqual((yield* handlers.list_directory({ path: "." })).entries.length, 200)
      }))
    it.effect("lists symlinks as links and replaces compatible rename destinations", () =>
      Effect.gen(function*() {
        const { caller, baseCaller } = yield* makeWorkspace()
        const handlers = handlersFor(caller, baseCaller)
        yield* caller.symlink("BRIEF.md", "brief-link")
        assert.deepStrictEqual(
          (yield* handlers.list_directory({ path: "." })).entries.find((entry) => entry.name === "brief-link"),
          { name: "brief-link", kind: "symlink" }
        )
        yield* handlers.write_file({ path: "destination", content: "old" })
        yield* handlers.rename({ from: "temporary.txt", to: "destination" })
        assert.match((yield* handlers.read_file({ path: "destination" })).content, /scratch/)
        yield* handlers.remove({ path: "brief-link" })
        assert.match((yield* handlers.read_file({ path: "BRIEF.md" })).content, /rollback/)
        const original = yield* handlers.inspect_base({ path: "temporary.txt", action: "read" })
        assert.isTrue("content" in original)

        if ("content" in original) assert.match(original.content, /scratch/)
      }))
  })
})
