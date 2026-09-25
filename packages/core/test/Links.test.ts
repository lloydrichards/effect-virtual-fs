import { assert, describe } from "@effect/vitest"
import { ByteSize, Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import * as InternalBytePath from "../src/internal/bytePath.js"

import { it } from "./TestEffect.js"

// The path an error names, as text; errors carry paths as bytes.
const pathText = (path: Vfs.BytePath | undefined): string | undefined =>
  path === undefined ? undefined : new TextDecoder().decode(InternalBytePath.getBytes(path))

describe("links and byte namespace", () => {
  it.effect(
    "shares hard-link identity and charges content once through rename replacement",
    () =>
      Effect.gen(function*() {
        const fs = yield* (yield* Vfs.make({ maxBytes: ByteSize.bytes(3) })).caller()
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
      })
  )

  it.effect(
    "resolves relative symlinks before dot-dot and supports creation through dangling links",
    () =>
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
      })
  )

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

  it.effect(
    "enforces traversal and exact expansion limits without changing the namespace",
    () =>
      Effect.gen(function*() {
        const fs = yield* (yield* Vfs.make({ maxPathBytes: ByteSize.bytes(12) })).caller()
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
      })
  )

  it.effect("stores raw symlink targets and validates path limits only when traversing", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make({ maxPathBytes: ByteSize.bytes(12) })).caller()
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

  it.effect(
    "names the traversed path, not the expansion, when a symlink target breaks a limit",
    () =>
      Effect.gen(function*() {
        const fs = yield* (yield* Vfs.make()).caller()
        yield* fs.symlink("a".repeat(300), "/link")

        const failed = yield* Effect.flip(fs.readFile("/link"))

        assert.strictEqual(failed.code, "PathTooLong")
        assert.strictEqual(pathText(failed.path), "/link")
      })
  )

  it.effect("resolves realPath through a hard link to the name used", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.writeFile("/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })
      yield* fs.link("/f", "/alias")
      assert.strictEqual(yield* fs.realPath("/alias"), "/alias")
      assert.strictEqual(yield* fs.realPath("/f"), "/f")
      yield* fs.rename("/f", "/g")
      assert.strictEqual(yield* fs.realPath("/alias"), "/alias")
      assert.strictEqual(yield* fs.realPath("/g"), "/g")
      assert.strictEqual((yield* Effect.flip(fs.realPath("/f"))).code, "NotFound")
    }))

  it.effect("resolves realPath of a handle-relative path after its directory moved", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.mkdir("/old")
      yield* fs.mkdir("/old/work")
      const handle = yield* fs.openDirectory("/old/work")
      assert.strictEqual(yield* fs.realPath(".", { relativeTo: handle }), "/old/work")
      yield* fs.rename("/old", "/new")
      assert.strictEqual(yield* fs.realPath(".", { relativeTo: handle }), "/new/work")
      yield* fs.writeFile("x", new Uint8Array([1]), { access: "write", create: "ifMissing", relativeTo: handle })
      assert.strictEqual(yield* fs.realPath("x", { relativeTo: handle }), "/new/work/x")
      assert.strictEqual((yield* fs.stat("/new/work/x")).kind, "file")
    }))

  it.effect("fails realPath with NotFound once the handle's directory is removed", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.mkdir("/gone")
      const handle = yield* fs.openDirectory("/gone")
      assert.strictEqual(yield* fs.realPath(".", { relativeTo: handle }), "/gone")
      yield* fs.rmdir("/gone")
      assert.strictEqual((yield* Effect.flip(fs.realPath(".", { relativeTo: handle }))).code, "NotFound")
    }))
})
