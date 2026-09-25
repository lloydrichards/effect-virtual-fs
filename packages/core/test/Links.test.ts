import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { entryNames, pathText, rawEntryNames, text } from "./support/text.js"

describe("links and byte namespace", () => {
  it.effect(
    "shares hard-link identity and charges content once through rename replacement",
    () =>
      Effect.gen(function*() {
        const fs = yield* Vfs.Caller
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
      }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(3) } })))
  )

  it.effect(
    "resolves relative symlinks before dot-dot and supports creation through dangling links",
    () =>
      Effect.gen(function*() {
        const fs = yield* Vfs.Caller
        yield* fs.mkdir("/a")
        yield* fs.mkdir("/b")
        yield* fs.mkdir("/b/deep")
        yield* fs.symlink("../b/deep", "/a/link")
        assert.strictEqual(yield* pathText(yield* fs.realPath("/a/link/..")), "/b")
        yield* fs.symlink("missing", "/b/dangling")
        const f = yield* fs.open("/b/dangling", { access: "write", create: "ifMissing" })
        yield* f.write(new Uint8Array([9]))
        assert.strictEqual((yield* fs.stat("/b/missing")).ino, (yield* f.stat).ino)
        assert.strictEqual(
          (yield* fs.stat(Vfs.Target.Path({ path: "/b/dangling", followFinalSymlink: false }))).kind,
          "symlink"
        )
        assert.strictEqual(
          (yield* Effect.flip(
            fs.open(Vfs.Target.Path({ path: "/b/dangling", followFinalSymlink: false }), { access: "read" })
          )).code,
          "SymlinkLoop"
        )
        assert.strictEqual(
          (yield* Effect.flip(fs.open("/b/dangling", { access: "write", create: "exclusive" }))).code,
          "AlreadyExists"
        )
      }).pipe(Effect.provide(Testing.layer()))
  )

  it.effect("renames and unlinks final symlinks without changing their target", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/target")
      yield* fs.symlink("/target", "/alias")
      yield* fs.rename("/alias", "/renamed")
      assert.strictEqual(text(yield* fs.readLink("/renamed")), "/target")
      assert.strictEqual((yield* Effect.flip(fs.rmdir("/renamed"))).code, "NotDirectory")
      yield* fs.link("/renamed", "/alias")
      assert.strictEqual(
        (yield* fs.stat(Vfs.Target.Path({ path: "/alias", followFinalSymlink: false }))).ino,
        (yield* fs.stat(Vfs.Target.Path({ path: "/renamed", followFinalSymlink: false }))).ino
      )
      yield* fs.unlink("/renamed")
      yield* fs.unlink("/alias")
      yield* fs.stat("/target")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reads a link without following it, even when the target asks to follow", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* fs.symlink("/file", "/link")

      const following = Vfs.Target.Path({ path: "/link", followFinalSymlink: true })

      assert.strictEqual(text(yield* fs.readLink(following)), "/file")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect(
    "enforces traversal and exact expansion limits without changing the namespace",
    () =>
      Effect.gen(function*() {
        const fs = yield* Vfs.Caller
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
        assert.deepStrictEqual([...(entryNames(yield* fs.readDirectory("/")))].sort(), ["a", "longname", "loop"])
      }).pipe(Effect.provide(Testing.layer({ volume: { maxPathBytes: ByteSize.bytes(12) } })))
  )

  it.effect("stores raw symlink targets and validates path limits only when traversing", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const target = "x".repeat(300)
      yield* fs.symlink(target, "/raw")
      assert.strictEqual(text(yield* fs.readLink("/raw")), target)
      assert.strictEqual((yield* Effect.flip(fs.stat("/raw"))).code, "PathTooLong")
      yield* fs.symlink("", "/empty")
      assert.strictEqual(text(yield* fs.readLink("/empty")), "")
      assert.strictEqual((yield* Effect.flip(fs.stat("/empty"))).code, "NotFound")
      yield* fs.mkdir("/x")
      assert.strictEqual((yield* Effect.flip(fs.stat("/empty/x"))).code, "NotFound")
    }).pipe(Effect.provide(Testing.layer({ volume: { maxPathBytes: ByteSize.bytes(12) } }))))

  it.effect("returns independently owned byte names", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const path = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))
      yield* fs.mkdir(path)
      const names = rawEntryNames(yield* fs.readDirectory("/"))
      assert.deepStrictEqual(names, [new Uint8Array([255])])
      const first = names[0]
      assert.isDefined(first)
      first[0] = 1
      assert.deepStrictEqual(rawEntryNames(yield* fs.readDirectory("/")), [new Uint8Array([255])])
      assert.deepStrictEqual(yield* Vfs.pathToBytes(yield* fs.realPath(path)), new Uint8Array([47, 255]))
      yield* fs.symlink(path, "/alias")
      assert.deepStrictEqual(yield* fs.readLink("/alias"), new Uint8Array([47, 255]))
    }).pipe(Effect.provide(Testing.layer())))

  it.effect(
    "names the traversed path, not the expansion, when a symlink target breaks a limit",
    () =>
      Effect.gen(function*() {
        const fs = yield* Vfs.Caller
        yield* fs.symlink("a".repeat(300), "/link")

        const failed = yield* Effect.flip(fs.readFile("/link"))

        assert.strictEqual(failed.code, "PathTooLong")
        assert.strictEqual(yield* pathText(failed.path), "/link")
      }).pipe(Effect.provide(Testing.layer()))
  )

  it.effect("resolves realPath through a hard link to the name used", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.writeFile("/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })
      yield* fs.link("/f", "/alias")
      assert.strictEqual(yield* pathText(yield* fs.realPath("/alias")), "/alias")
      assert.strictEqual(yield* pathText(yield* fs.realPath("/f")), "/f")
      yield* fs.rename("/f", "/g")
      assert.strictEqual(yield* pathText(yield* fs.realPath("/alias")), "/alias")
      assert.strictEqual(yield* pathText(yield* fs.realPath("/g")), "/g")
      assert.strictEqual((yield* Effect.flip(fs.realPath("/f"))).code, "NotFound")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("resolves realPath of a handle-relative path after its directory moved", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/old")
      yield* fs.mkdir("/old/work")
      const handle = yield* fs.openDirectory("/old/work")
      assert.strictEqual(
        yield* pathText(yield* fs.realPath(Vfs.Target.Path({ path: ".", relativeTo: handle }))),
        "/old/work"
      )
      yield* fs.rename("/old", "/new")
      assert.strictEqual(
        yield* pathText(yield* fs.realPath(Vfs.Target.Path({ path: ".", relativeTo: handle }))),
        "/new/work"
      )
      yield* fs.writeFile(Vfs.Target.Path({ path: "x", relativeTo: handle }), new Uint8Array([1]), {
        access: "write",
        create: "ifMissing"
      })
      assert.strictEqual(
        yield* pathText(yield* fs.realPath(Vfs.Target.Path({ path: "x", relativeTo: handle }))),
        "/new/work/x"
      )
      assert.strictEqual((yield* fs.stat("/new/work/x")).kind, "file")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("fails realPath with NotFound once the handle's directory is removed", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/gone")
      const handle = yield* fs.openDirectory("/gone")
      assert.strictEqual(
        yield* pathText(yield* fs.realPath(Vfs.Target.Path({ path: ".", relativeTo: handle }))),
        "/gone"
      )
      yield* fs.rmdir("/gone")
      assert.strictEqual(
        (yield* Effect.flip(fs.realPath(Vfs.Target.Path({ path: ".", relativeTo: handle })))).code,
        "NotFound"
      )
    }).pipe(Effect.provide(Testing.layer())))
})
