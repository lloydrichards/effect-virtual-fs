import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

describe("links and byte namespace", () => {
  it.effect("shares hard-link identity and charges content once through rename replacement", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make({ maxBytes: 3 })).caller()
      const f = yield* fs.open("/a", { access: "readWrite", create: "exclusive" })
      yield* f.write(new Uint8Array([1, 2, 3]))
      yield* fs.link("/a", "/b")
      assert.strictEqual((yield* fs.stat("/b")).ino, (yield* f.stat).ino)
      assert.strictEqual((yield* f.stat).nlink, 2)
      yield* fs.rename("/a", "/b")
      assert.strictEqual((yield* f.stat).nlink, 2)
      yield* fs.unlink("/a")
      yield* fs.rename("/b", "/c")
      assert.strictEqual((yield* f.stat).nlink, 1)
      const empty = yield* fs.open("/empty", { access: "write", create: "exclusive" })
      yield* fs.rename("/empty", "/c")
      assert.strictEqual((yield* f.stat).nlink, 0)
      assert.strictEqual((yield* Effect.flip(empty.write(new Uint8Array([4])))).code, "NoSpace")
      yield* f.close
      yield* empty.write(new Uint8Array([4]))
    }))

  it.effect("resolves relative symlinks before dot-dot and supports creation through dangling links", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.mkdir("/a")
      yield* fs.mkdir("/b")
      yield* fs.mkdir("/b/deep")
      yield* fs.symlink("../b/deep", "/a/link")
      assert.strictEqual(yield* fs.realPath("/a/link/.."), "/b")
      yield* fs.symlink("missing", "/b/dangling")
      const f = yield* fs.open("/b/dangling", { access: "write", create: "ifMissing" })
      yield* f.write(new Uint8Array([9]))
      assert.strictEqual((yield* fs.stat("/b/missing")).ino, (yield* f.stat).ino)
      assert.strictEqual((yield* fs.lstat("/b/dangling")).kind, "symlink")
      assert.strictEqual(
        (yield* Effect.flip(fs.open("/b/dangling", { access: "read", followFinalSymlink: false }))).code,
        "SymlinkLoop"
      )
      assert.strictEqual(
        (yield* Effect.flip(fs.open("/b/dangling", { access: "write", create: "exclusive" }))).code,
        "AlreadyExists"
      )
    }))

  it.effect("renames and unlinks final symlinks without changing their target", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.mkdir("/target")
      yield* fs.symlink("/target", "/alias")
      yield* fs.rename("/alias", "/renamed")
      assert.strictEqual(yield* fs.readLink("/renamed"), "/target")
      assert.strictEqual((yield* Effect.flip(fs.rmdir("/renamed"))).code, "NotDirectory")
      yield* fs.link("/renamed", "/alias")
      assert.strictEqual((yield* fs.lstat("/alias")).ino, (yield* fs.lstat("/renamed")).ino)
      yield* fs.unlink("/renamed")
      yield* fs.unlink("/alias")
      yield* fs.stat("/target")
    }))

  it.effect("enforces traversal and exact expansion limits without changing the namespace", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make({ maxPathBytes: 12 })).caller()
      yield* fs.mkdir("/longname")
      yield* fs.symlink("/longname", "/a")
      assert.strictEqual((yield* Effect.flip(fs.stat("/a/////x"))).code, "PathTooLong")
      assert.strictEqual((yield* Effect.flip(fs.mkdir("/a/////x"))).code, "PathTooLong")
      yield* fs.symlink("/loop", "/loop")
      assert.strictEqual((yield* Effect.flip(fs.stat("/loop"))).code, "SymlinkLoop")
      assert.strictEqual(
        (yield* Effect.flip(fs.open("/loop", { access: "write", create: "ifMissing" }))).code,
        "SymlinkLoop"
      )
      assert.deepStrictEqual([...(yield* fs.readDirectory("/"))].sort(), ["a", "longname", "loop"])
    }))

  it.effect("stores raw symlink targets and validates path limits only when traversing", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make({ maxPathBytes: 12 })).caller()
      const target = "x".repeat(300)
      yield* fs.symlink(target, "/raw")
      assert.strictEqual(yield* fs.readLink("/raw"), target)
      assert.strictEqual((yield* Effect.flip(fs.stat("/raw"))).code, "PathTooLong")
      yield* fs.symlink("", "/empty")
      assert.strictEqual(yield* fs.readLink("/empty"), "")
      assert.strictEqual((yield* Effect.flip(fs.stat("/empty"))).code, "NotFound")
      yield* fs.mkdir("/x")
      assert.strictEqual((yield* Effect.flip(fs.stat("/empty/x"))).code, "NotFound")
    }))

  it.effect("returns independently owned byte names and rejects lossy string results", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      const path = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))
      yield* fs.mkdir(path)
      const names = yield* fs.readDirectoryBytes("/")
      assert.deepStrictEqual(names, [new Uint8Array([255])])
      const first = names[0]
      assert.isDefined(first)
      first[0] = 1
      assert.deepStrictEqual(yield* fs.readDirectoryBytes("/"), [new Uint8Array([255])])
      assert.strictEqual((yield* Effect.flip(fs.readDirectory("/"))).code, "UnrepresentableName")
      assert.strictEqual((yield* Effect.flip(fs.realPath(path))).code, "UnrepresentableName")
      assert.deepStrictEqual(yield* Vfs.pathToBytes(yield* fs.realPathBytes(path)), new Uint8Array([47, 255]))
      yield* fs.symlink(path, "/alias")
      assert.strictEqual((yield* Effect.flip(fs.readLink("/alias"))).code, "UnrepresentableName")
      assert.deepStrictEqual(yield* fs.readLinkBytes("/alias"), new Uint8Array([47, 255]))
    }))
})
