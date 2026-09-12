import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Exit, Fiber, Option, Scope, Stream } from "effect"
import * as Memory from "../src/MemoryFileSystem.js"

const bytes = new TextEncoder()
describe("core-backed memory bindings", () => {
  it.effect("shares direct core writes and independent adapter cursors between bindings", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const core = yield* volume.caller()
      const a = yield* Memory.bind(volume)
      const b = yield* Memory.bind(volume)
      assert.isFalse(yield* a.exists("/tmp"))
      yield* core.writeFile("/f", bytes.encode("abc"), { access: "write", create: "exclusive" })
      const af = yield* a.open("/f")
      const bf = yield* b.open("/f")
      const read = yield* af.readAlloc(1)
      assert.isTrue(Option.isSome(read))
      assert.strictEqual(yield* bf.seek(0n, "current"), 0n)
      yield* b.writeFileString("/f", "xyz")
      assert.strictEqual(new TextDecoder().decode(Option.getOrThrow(yield* bf.readAlloc(3))), "xyz")
      const scope = yield* Scope.make()
      const closed = yield* a.open("/f").pipe(Scope.provide(scope))
      yield* Scope.close(scope, Exit.void)
      yield* Effect.flip(closed.readAlloc(1))
      assert.strictEqual(yield* closed.seek(10n, "start"), 0n)
      assert.strictEqual(yield* a.readFileString("/f"), "xyz")
    }))

  it.effect("delivers direct-core and alias writes to adapter watchers in commit order", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const core = yield* volume.caller()
      const adapter = yield* Memory.bind(volume)
      yield* core.writeFile("/f", bytes.encode("old"), { access: "write", create: "exclusive" })
      yield* core.link("/f", "/alias")
      const watch = yield* adapter.watch("/").pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* core.writeFile("/f", bytes.encode("new"), { access: "write", truncate: true })
      yield* core.rename("/alias", "/renamed")
      assert.deepStrictEqual(yield* Fiber.join(watch), [
        { _tag: "Update", path: "/f" },
        { _tag: "Update", path: "/alias" },
        { _tag: "Remove", path: "/alias" },
        { _tag: "Create", path: "/renamed" }
      ])
    }))

  it.effect("preserves the old file and publishes nothing when a whole-file write exceeds quota", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make({ maxBytes: ByteSize.bytes(3) })
      const core = yield* volume.caller()
      const adapter = yield* Memory.bind(volume)
      yield* adapter.writeFileString("/f", "old")
      const before = yield* core.stat("/f")
      const watch = yield* adapter.watch("/").pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.flip(adapter.writeFileString("/f", "too long"))
      assert.deepStrictEqual(yield* core.stat("/f"), before)
      assert.strictEqual(yield* adapter.readFileString("/f"), "old")
      yield* core.mkdir("/sentinel")
      assert.deepStrictEqual(yield* Fiber.join(watch), [{ _tag: "Create", path: "/sentinel" }])
    }))

  it.effect("filters unrelated byte names before strict watch conversion", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const core = yield* volume.caller()
      const adapter = yield* Memory.bind(volume)
      yield* core.mkdir("/watched")
      const watch = yield* adapter.watch("/watched").pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* core.mkdir(yield* Vfs.pathFromBytes(new Uint8Array([47, 255])))
      yield* core.mkdir("/watched/child")
      assert.deepStrictEqual(yield* Fiber.join(watch), [{ _tag: "Create", path: "/watched/child" }])
      const invalid = yield* Effect.flip(adapter.readDirectory("/"))
      assert.strictEqual(invalid.reason._tag, "InvalidData")
    }))

  it.effect("preserves copied hard-link topology and directory timestamps", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.makeDirectory("/source/nested", { recursive: true })
      yield* fs.writeFileString("/source/nested/a", "content")
      yield* fs.link("/source/nested/a", "/source/nested/b")
      yield* fs.utimes("/source/nested", 100, 200)
      yield* fs.copy("/source", "/copy", { preserveTimestamps: true })
      assert.deepStrictEqual((yield* fs.stat("/copy/nested/a")).ino, (yield* fs.stat("/copy/nested/b")).ino)
      assert.strictEqual(Option.getOrThrow((yield* fs.stat("/copy/nested")).mtime).getTime(), 200_000)
    }))

  it.effect("preserves adapter append-truncate and path-truncate cursor behavior", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.writeFileString("/f", "abcd")
      const f = yield* fs.open("/f", { flag: "a+" })
      yield* f.seek(4n, "start")
      yield* f.truncate(1)
      assert.strictEqual(yield* f.seek(0n, "current"), 4n)
      const g = yield* fs.open("/f", { flag: "r+" })
      yield* g.seek(3n, "start")
      yield* fs.truncate("/f", 0)
      assert.strictEqual(yield* g.seek(0n, "current"), 3n)
      yield* g.seek(-1n, "start")
      yield* Effect.flip(g.readAlloc(1))
      assert.strictEqual(yield* g.seek(0n, "current"), -1n)
    }))
})
