import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import * as Memory from "../src/MemoryFileSystem.js"

const bytes = new TextEncoder()

describe("overlay memory binding", () => {
  it.effect("should bind as an ordinary Volume and observe direct and adapter writes", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/f", bytes: bytes.encode("base") }]
      })).snapshot
      const overlay = yield* Vfs.makeOverlay(base)
      const core = yield* overlay.caller()
      const adapter = yield* Memory.bind(overlay)

      yield* adapter.writeFileString("/f", "adapter")
      assert.strictEqual(new TextDecoder().decode(yield* core.readFile("/f")), "adapter")
      yield* core.writeFile("/f", bytes.encode("core"), { access: "write", truncate: true })
      assert.strictEqual(yield* adapter.readFileString("/f"), "core")
      assert.strictEqual((yield* overlay.changes()).length, 1)
    }))

  it.effect("should keep sibling adapter bindings isolated after same-sized writes", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/f", bytes: bytes.encode("same") }]
      })).snapshot
      const a = yield* Memory.bind(yield* Vfs.makeOverlay(base))
      const b = yield* Memory.bind(yield* Vfs.makeOverlay(base))
      yield* a.writeFileString("/f", "edit")
      assert.strictEqual(yield* a.readFileString("/f"), "edit")
      assert.strictEqual(yield* b.readFileString("/f"), "same")
    }))

  it.effect("should publish direct and adapter rename events in commit order when a destination is replaced", () =>
    Effect.gen(function*() {
      const base = yield* (yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/direct", bytes: bytes.encode("direct") },
          { kind: "file", path: "/source", bytes: bytes.encode("source") },
          { kind: "file", path: "/destination", bytes: bytes.encode("destination") }
        ]
      })).snapshot
      const overlay = yield* Vfs.makeOverlay(base)
      const core = yield* overlay.caller()
      const adapter = yield* Memory.bind(overlay)
      const watched = yield* adapter.watch("/").pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )

      yield* core.rename("/direct", "/renamed")
      yield* adapter.rename("/source", "/destination")

      assert.deepStrictEqual(yield* Fiber.join(watched), [
        { _tag: "Remove", path: "/direct" },
        { _tag: "Create", path: "/renamed" },
        { _tag: "Remove", path: "/source" },
        { _tag: "Create", path: "/destination" }
      ])
      assert.strictEqual(yield* adapter.readFileString("/destination"), "source")
    }))
})
