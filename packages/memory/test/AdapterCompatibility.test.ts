import { Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Option } from "effect"
import * as Memory from "../src/MemoryFileSystem.js"

describe("memory adapter compatibility", () => {
  for (const root of ["/", "//", ".", "/directory/..", "/alias/../"]) {
    it.effect(`should reject recursive removal of ${root} without changing the tree`, () =>
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
    it.effect(`should replace a destination symlink without changing its target when copying a ${nested ? "directory" : "file"}`, () =>
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

  it.effect("should preserve a destination directory symlink when copying a tree over it", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.makeDirectory("/source/child", { recursive: true })
      yield* fs.makeDirectory("/destination")
      yield* fs.makeDirectory("/outside")
      yield* fs.writeFileString("/source/child/file", "copied")
      yield* fs.symlink("/outside", "/destination/child")

      const error = yield* Effect.flip(fs.copy("/source", "/destination", { overwrite: true }))

      assert.strictEqual(error.reason._tag, "BadResource")
      assert.strictEqual(yield* fs.readLink("/destination/child"), "/outside")
      assert.deepStrictEqual(yield* fs.readDirectory("/outside"), [])
    }))

  it.effect("should leave the destination absent when copying root into its descendant is rejected", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.makeDirectory("/parent")
      yield* fs.writeFileString("/parent/file", "keep")

      const error = yield* Effect.flip(fs.copy("/", "/parent/copy"))

      assert.strictEqual(error.reason._tag, "BadArgument")
      assert.deepStrictEqual(yield* fs.readDirectory("/parent"), ["file"])
      assert.strictEqual(yield* fs.readFileString("/parent/file"), "keep")
    }))

  it.effect("should preserve a destination symlink and its target when replacement exceeds capacity", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.bind(yield* Vfs.Volume)
      yield* fs.writeFileString("/source", "x".repeat(32))
      yield* fs.writeFileString("/external", "safe")
      yield* fs.symlink("/external", "/destination")

      const watched = yield* Testing.collectChanges(fs.watch("/"), 1)

      const error = yield* Effect.flip(fs.copy("/source", "/destination", { overwrite: true }))
      assert.strictEqual(error.reason._tag, "Unknown")
      assert.strictEqual(yield* fs.readLink("/destination"), "/external")
      assert.strictEqual(yield* fs.readFileString("/external"), "safe")
      assert.deepStrictEqual(yield* fs.readDirectory("/"), ["destination", "external", "source"])
      yield* fs.makeDirectory("/sentinel")
      assert.deepStrictEqual(yield* watched, [{ _tag: "Create", path: "/sentinel" }])
    }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(45) } }))))

  it.effect("should replace a symlink within capacity when its storage can be reused", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.bind(yield* Vfs.Volume)
      yield* fs.writeFileString("/source", "copied")
      yield* fs.writeFileString("/external", "safe")
      yield* fs.symlink("/external", "/destination")

      const watched = yield* Testing.collectChanges(fs.watch("/"), 1)

      yield* fs.copy("/source", "/destination", { overwrite: true })
      assert.strictEqual(yield* fs.readFileString("/destination"), "copied")
      assert.strictEqual(yield* fs.readFileString("/external"), "safe")
      const events = yield* watched
      assert.strictEqual(events.length, 1)
      assert.strictEqual(events[0]?.path, "/destination")
      assert.deepStrictEqual(yield* fs.readDirectory("/"), ["destination", "external", "source"])
    }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(19), maxEntries: 3 } }))))

  it.effect("should copy source mode and contents to existing destination aliases when copying a file", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.writeFileString("/source", "copied", { mode: 0o600 })
      yield* fs.writeFileString("/destination", "old", { mode: 0o777 })
      yield* fs.link("/destination", "/alias")
      const handle = yield* fs.open("/destination")
      const before = yield* fs.stat("/destination")

      const watched = yield* Testing.collectChanges(fs.watch("/"), 3)

      yield* fs.copyFile("/source", "/destination")
      const after = yield* fs.stat("/destination")
      assert.strictEqual(after.mode & 0o7777, 0o600)
      assert.deepStrictEqual(after.ino, before.ino)
      assert.strictEqual((yield* fs.stat("/alias")).mode & 0o7777, 0o600)
      assert.strictEqual(new TextDecoder().decode(Option.getOrThrow(yield* handle.readAlloc(6))), "copied")
      yield* fs.makeDirectory("/sentinel")
      assert.deepStrictEqual(yield* watched, [
        { _tag: "Update", path: "/destination" },
        { _tag: "Update", path: "/alias" },
        { _tag: "Create", path: "/sentinel" }
      ])
    }))

  it.effect("should preserve destination bytes and metadata when copying mode is denied", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const owner = yield* Memory.bind(volume)

      const guest = yield* Memory.bind(volume, {
        identity: { uid: 1, gid: 1, groups: [], privileged: false }
      })

      yield* owner.writeFileString("/source", "copied", { mode: 0o644 })
      yield* owner.writeFileString("/destination", "keep", { mode: 0o666 })
      const before = yield* owner.stat("/destination")

      const watched = yield* Testing.collectChanges(owner.watch("/"), 1)

      const error = yield* Effect.flip(guest.copyFile("/source", "/destination"))
      assert.strictEqual(error.reason._tag, "PermissionDenied")
      assert.deepStrictEqual(yield* owner.stat("/destination"), before)
      assert.strictEqual(yield* owner.readFileString("/destination"), "keep")
      yield* owner.makeDirectory("/sentinel")
      assert.deepStrictEqual(yield* watched, [{ _tag: "Create", path: "/sentinel" }])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should leave a file unchanged when copied to itself or a hard-link alias", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.writeFileString("/source", "unchanged", { mode: 0o600 })
      yield* fs.link("/source", "/alias")
      const before = yield* fs.stat("/source")

      const watched = yield* Testing.collectChanges(fs.watch("/"), 1)

      yield* fs.copyFile("/source", "/source")
      yield* fs.copyFile("/source", "/alias")
      assert.deepStrictEqual(yield* fs.stat("/source"), before)
      yield* fs.makeDirectory("/sentinel")
      assert.deepStrictEqual(yield* watched, [{ _tag: "Create", path: "/sentinel" }])
    }))

  it.effect("should keep special mode bits when copying a directory tree", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.makeDirectory("/source")
      yield* fs.writeFileString("/source/tool", "run")
      yield* fs.chmod("/source/tool", 0o4755)

      yield* fs.copy("/source", "/copy")

      assert.strictEqual((yield* fs.stat("/copy/tool")).mode & 0o7777, 0o4755)
    }))

  it.effect("should report a copy larger than the volume as out of space", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.bind(yield* Vfs.Volume)
      yield* fs.makeDirectory("/source")
      yield* fs.writeFileString("/source/a", "0123456789")

      const error = yield* Effect.flip(fs.copy("/source", "/copy"))

      assert.deepStrictEqual([error.reason._tag, error.reason.description], ["Unknown", "NoSpace"])
      assert.isFalse(yield* fs.exists("/copy"))
    }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(16) } }))))

  it.effect("should reject copying a file onto one of its own hard links", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.make
      yield* fs.writeFileString("/source", "keep")
      yield* fs.link("/source", "/alias")

      const error = yield* Effect.flip(fs.copy("/source", "/alias", { overwrite: true }))

      assert.strictEqual(error.reason._tag, "BadArgument")
      assert.strictEqual(yield* fs.readFileString("/alias"), "keep")
    }))

  it.effect("should create no directory when a recursive makeDirectory fails partway", () =>
    Effect.gen(function*() {
      const fs = yield* Memory.bind(yield* Vfs.Volume)

      // The third directory is past the volume's entry limit, so the first two are not created either.
      const error = yield* Effect.flip(fs.makeDirectory("/a/b/c", { recursive: true }))

      assert.deepStrictEqual([error.reason._tag, error.reason.description], ["Unknown", "NoSpace"])
      assert.isFalse(yield* fs.exists("/a"))
    }).pipe(Effect.provide(Testing.layer({ volume: { maxEntries: 2 } }))))

  // As Node does, a recursive listing reads a directory it may read but not search and fails below it.
  it.effect("should fail a recursive listing below a directory it may read but not search", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const owner = yield* Memory.bind(volume)
      yield* owner.makeDirectory("/listed/inner", { recursive: true })
      yield* owner.writeFileString("/listed/inner/file", "x")
      yield* owner.chmod("/listed", 0o444)
      const guest = yield* Memory.bind(volume, { identity: { uid: 1, gid: 1, groups: [], privileged: false } })

      assert.deepStrictEqual(yield* guest.readDirectory("/listed"), ["inner"])
      const error = yield* Effect.flip(guest.readDirectory("/listed", { recursive: true }))
      assert.strictEqual(error.reason._tag, "PermissionDenied")
    }).pipe(Effect.provide(Testing.layer())))
})
