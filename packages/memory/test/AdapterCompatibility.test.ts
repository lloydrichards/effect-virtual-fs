import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Fiber, Option, Stream } from "effect"
import * as Memory from "../src/MemoryFileSystem.js"

describe("memory adapter compatibility", () => {
  for (const root of ["/", "//", ".", "/directory/..", "/alias/../"]) {
    it.effect(`rejects recursive removal of ${root} before changing the tree`, () =>
      Effect.gen(function*() {
        const fs = yield* Memory.make
        yield* fs.makeDirectory("/directory")
        yield* fs.symlink("/directory", "/alias")
        yield* fs.writeFileString("/directory/sentinel", "keep")
        const before = yield* fs.readDirectory("/", { recursive: true })
        const error = yield* Effect.flip(fs.remove(root, { recursive: true }))
        assert.deepStrictEqual(yield* fs.readDirectory("/", { recursive: true }), before)
        assert.strictEqual(error.reason._tag, "BadResource")
        assert.strictEqual(yield* fs.readFileString("/directory/sentinel"), "keep")
      }))
  }

  for (const nested of [false, true]) {
    it.effect(`replaces destination symlinks during ${nested ? "directory" : "file"} copy without writing their targets`, () =>
      Effect.gen(function*() {
        const fs = yield* Memory.make
        yield* fs.makeDirectory("/source")
        yield* fs.makeDirectory("/destination")
        yield* fs.writeFileString("/source/file", "copied")
        yield* fs.writeFileString("/external", "untouched")
        yield* fs.symlink("/external", "/destination/file")
        if (nested) yield* fs.copy("/source", "/destination", { overwrite: true })
        else yield* fs.copy("/source/file", "/destination/file", { overwrite: true })
        assert.strictEqual(yield* fs.readFileString("/external"), "untouched")
        assert.strictEqual(yield* fs.readFileString("/destination/file"), "copied")
        yield* Effect.flip(fs.readLink("/destination/file"))
      }))
  }

  it.effect("preserves the destination symlink and target when replacement exceeds volume capacity", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make({ maxBytes: ByteSize.bytes(45) })
      const fs = yield* Memory.bind(volume)
      yield* fs.writeFileString("/source", "x".repeat(32))
      yield* fs.writeFileString("/external", "safe")
      yield* fs.symlink("/external", "/destination")
      const watched = yield* fs.watch("/").pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      const error = yield* Effect.flip(fs.copy("/source", "/destination", { overwrite: true }))
      assert.strictEqual(error.reason._tag, "BadResource")
      assert.strictEqual(yield* fs.readLink("/destination"), "/external")
      assert.strictEqual(yield* fs.readFileString("/external"), "safe")
      assert.deepStrictEqual(yield* fs.readDirectory("/"), ["destination", "external", "source"])
      yield* fs.makeDirectory("/sentinel")
      assert.deepStrictEqual(yield* Fiber.join(watched), [{ _tag: "Create", path: "/sentinel" }])
    }))

  it.effect("reuses the replaced symlink's capacity without staging a temporary entry", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make({ maxBytes: ByteSize.bytes(19), maxEntries: 3 })
      const fs = yield* Memory.bind(volume)
      yield* fs.writeFileString("/source", "copied")
      yield* fs.writeFileString("/external", "safe")
      yield* fs.symlink("/external", "/destination")
      const watched = yield* fs.watch("/").pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* fs.copy("/source", "/destination", { overwrite: true })
      assert.strictEqual(yield* fs.readFileString("/destination"), "copied")
      assert.strictEqual(yield* fs.readFileString("/external"), "safe")
      const events = yield* Fiber.join(watched)
      assert.strictEqual(events.length, 1)
      assert.strictEqual(events[0]?.path, "/destination")
      assert.deepStrictEqual(yield* fs.readDirectory("/"), ["destination", "external", "source"])
    }))

  it.effect("copies the source mode while preserving an existing copyFile destination and its aliases", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.writeFileString("/source", "copied", { mode: 0o600 })
      yield* fs.writeFileString("/destination", "old", { mode: 0o777 })
      yield* fs.link("/destination", "/alias")
      const handle = yield* fs.open("/destination")
      const before = yield* fs.stat("/destination")
      const watched = yield* fs.watch("/").pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* fs.copyFile("/source", "/destination")
      const after = yield* fs.stat("/destination")
      assert.strictEqual(after.mode & 0o7777, 0o600)
      assert.deepStrictEqual(after.ino, before.ino)
      assert.strictEqual((yield* fs.stat("/alias")).mode & 0o7777, 0o600)
      assert.strictEqual(new TextDecoder().decode(Option.getOrThrow(yield* handle.readAlloc(6))), "copied")
      yield* fs.makeDirectory("/sentinel")
      assert.deepStrictEqual(yield* Fiber.join(watched), [
        { _tag: "Update", path: "/destination" },
        { _tag: "Update", path: "/alias" },
        { _tag: "Create", path: "/sentinel" }
      ])
    }))

  it.effect("rejects a copied mode without ownership before changing destination bytes or metadata", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const owner = yield* Memory.bind(volume)
      const guest = yield* Memory.bind(volume, {
        identity: { uid: 1, gid: 1, groups: [], privileged: false }
      })
      yield* owner.writeFileString("/source", "copied", { mode: 0o644 })
      yield* owner.writeFileString("/destination", "keep", { mode: 0o666 })
      const before = yield* owner.stat("/destination")
      const watched = yield* owner.watch("/").pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      const error = yield* Effect.flip(guest.copyFile("/source", "/destination"))
      assert.strictEqual(error.reason._tag, "PermissionDenied")
      assert.deepStrictEqual(yield* owner.stat("/destination"), before)
      assert.strictEqual(yield* owner.readFileString("/destination"), "keep")
      yield* owner.makeDirectory("/sentinel")
      assert.deepStrictEqual(yield* Fiber.join(watched), [{ _tag: "Create", path: "/sentinel" }])
    }))

  it.effect("treats copyFile to itself or a hard-link alias as a no-op", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.writeFileString("/source", "unchanged", { mode: 0o600 })
      yield* fs.link("/source", "/alias")
      const before = yield* fs.stat("/source")
      const watched = yield* fs.watch("/").pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* fs.copyFile("/source", "/source")
      yield* fs.copyFile("/source", "/alias")
      assert.deepStrictEqual(yield* fs.stat("/source"), before)
      yield* fs.makeDirectory("/sentinel")
      assert.deepStrictEqual(yield* Fiber.join(watched), [{ _tag: "Create", path: "/sentinel" }])
    }))
})
