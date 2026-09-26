import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { entryNames } from "./support/text.js"

const bytes = (...values: Array<number>) => new Uint8Array(values)

const name = (value: string) => new TextEncoder().encode(value)

describe("object references", () => {
  it.effect("keeps canonical identity across hard links, rename, and path reuse", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.writeFile("/a", bytes(1), { access: "write", create: "exclusive" })
      const root = yield* fs.root
      const original = yield* fs.lookup(Vfs.Entry(root, name("a")))
      yield* fs.link("/a", "/alias")
      assert.strictEqual(yield* fs.lookup(Vfs.Entry(root, name("alias"))), original)
      yield* fs.rename("/a", "/moved")
      yield* fs.writeFile("/a", bytes(2), { access: "write", create: "exclusive" })
      assert.strictEqual(yield* fs.lookup(Vfs.Entry(root, name("moved"))), original)
      assert.notStrictEqual(yield* fs.lookup(Vfs.Entry(root, name("a"))), original)
      const handle = yield* fs.open(original, { access: "read" })
      assert.deepStrictEqual(yield* handle.read(1), bytes(1))
      yield* handle.close
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("distinguishes forged, foreign, and stale references", () =>
    Effect.gen(function*() {
      const second = yield* Vfs.make()
      const fs = yield* Vfs.Caller
      const other = yield* second.caller()
      const root = yield* fs.root
      assert.strictEqual((yield* Effect.flip(other.stat(root))).code, "ForeignReference")
      // SAFETY: The forged reference deliberately bypasses the static contract to test runtime authenticity.
      assert.strictEqual(
        (yield* Effect.flip(fs.stat({} as Vfs.ObjectReference))).code,
        "InvalidReference"
      )
      yield* fs.writeFile("/gone", bytes(1), { access: "write", create: "exclusive" })
      const gone = yield* fs.lookup(Vfs.Entry(root, name("gone")))
      yield* fs.unlink("/gone")
      assert.strictEqual((yield* Effect.flip(fs.stat(gone))).code, "StaleReference")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("keeps an unlinked file observable only until its existing reader closes", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.writeFile("/f", bytes(1, 2), { access: "write", create: "exclusive" })
      const root = yield* fs.root
      const reference = yield* fs.lookup(Vfs.Entry(root, name("f")))
      const reader = yield* fs.open(reference, { access: "read" })
      yield* fs.unlink("/f")
      assert.strictEqual((yield* fs.stat(reference)).nlink, 0)
      assert.deepStrictEqual(yield* reader.read(2), bytes(1, 2))
      assert.strictEqual((yield* Effect.flip(fs.open(reference, { access: "read" }))).code, "StaleReference")
      yield* reader.close
      assert.strictEqual((yield* Effect.flip(fs.stat(reference))).code, "StaleReference")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("tracks directory parents and owns directory names and symlink targets", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/left")
      yield* fs.mkdir("/right")
      yield* fs.mkdir("/left/child")
      yield* fs.symlink("target", "/link")
      const root = yield* fs.root
      const left = yield* fs.lookup(Vfs.Entry(root, name("left")))
      const right = yield* fs.lookup(Vfs.Entry(root, name("right")))
      const child = yield* fs.lookup(Vfs.Entry(left, name("child")))
      assert.strictEqual(yield* fs.parent(root), root)
      assert.strictEqual(yield* fs.parent(child), left)
      yield* fs.rename("/left/child", "/right/child")
      assert.strictEqual(yield* fs.parent(child), right)

      const observation = yield* fs.readDirectory(root)
      const firstName = observation.value[0]?.name
      assert.isDefined(firstName)
      firstName[0] = 0
      const names = (yield* fs.readDirectory(root)).value.map((entry) => new TextDecoder().decode(entry.name))
      assert.deepStrictEqual(names, ["left", "right", "link"])

      const link = yield* fs.lookup(Vfs.Entry(root, name("link")))
      const target = yield* fs.readLink(link)
      target[0] = 0
      assert.deepStrictEqual(yield* fs.readLink(link), name("target"))
      yield* fs.rmdir("/right/child")
      assert.strictEqual((yield* Effect.flip(fs.parent(child))).code, "StaleReference")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("rechecks the invoking caller's read authority", () =>
    Effect.gen(function*() {
      const admin = yield* Vfs.Caller
      yield* admin.writeFile("/secret", bytes(1), { access: "write", create: "exclusive", mode: 0 })
      const reference = yield* admin.lookup(Vfs.Entry(yield* admin.root, name("secret")))
      const guest = yield* Testing.callerAs({ uid: 1, gid: 1, groups: [], privileged: false })
      assert.strictEqual((yield* Effect.flip(guest.open(reference, { access: "read" }))).code, "AccessDenied")
      assert.strictEqual(yield* guest.access(reference, 0o4), 0)
      assert.strictEqual(yield* admin.access(reference, 0o4), 0o4)
      assert.strictEqual((yield* Effect.flip(guest.access(reference, 8))).code, "InvalidArgument")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("observes metadata and link targets without permission on the object", () =>
    Effect.gen(function*() {
      const admin = yield* Vfs.Caller
      yield* admin.writeFile("/secret", bytes(1), { access: "write", create: "exclusive", mode: 0 })
      yield* admin.symlink("target", "/link")
      yield* admin.chmod(Vfs.Target.Path({ path: "/link", followFinalSymlink: false }), 0)
      const root = yield* admin.root
      const secret = yield* admin.lookup(Vfs.Entry(root, name("secret")))
      const link = yield* admin.lookup(Vfs.Entry(root, name("link")))
      const guest = yield* Testing.callerAs({ uid: 1, gid: 1, groups: [], privileged: false })

      assert.strictEqual((yield* guest.stat(secret)).mode, 0)
      assert.deepStrictEqual(yield* guest.readLink(link), name("target"))
      assert.strictEqual((yield* Effect.flip(guest.open(secret, { access: "read" }))).code, "AccessDenied")
    }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

  it.effect("rechecks traversal and directory authority for the invoking caller", () =>
    Effect.gen(function*() {
      const admin = yield* Vfs.Caller
      yield* admin.mkdir("/directory", { mode: 0o001 })
      yield* admin.mkdir("/directory/child", { mode: 0o001 })
      const root = yield* admin.root
      const directory = yield* admin.lookup(Vfs.Entry(root, name("directory")))
      const child = yield* admin.lookup(Vfs.Entry(directory, name("child")))
      const guest = yield* Testing.callerAs({ uid: 1, gid: 1, groups: [], privileged: false })

      assert.strictEqual(yield* guest.lookup(Vfs.Entry(directory, name("child"))), child)
      assert.strictEqual(yield* guest.parent(child), directory)
      assert.strictEqual((yield* Effect.flip(guest.readDirectory(directory))).code, "AccessDenied")

      yield* admin.chmod("/directory", 0)
      assert.strictEqual((yield* Effect.flip(guest.lookup(Vfs.Entry(directory, name("child"))))).code, "AccessDenied")
      yield* admin.chmod("/directory/child", 0)
      assert.strictEqual((yield* Effect.flip(guest.parent(child))).code, "AccessDenied")
    }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

  it.effect("validates one byte-preserving lookup component", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const root = yield* fs.root

      const invalid = [
        new Uint8Array(),
        name("."),
        name(".."),
        name("a/b"),
        new Uint8Array([0]),
        new Uint8Array(256)
      ]

      for (const component of invalid) {
        assert.strictEqual((yield* Effect.flip(fs.lookup(Vfs.Entry(root, component)))).code, "InvalidArgument")
      }

      // A string name is encoded as UTF-8 and looked up like bytes.
      assert.strictEqual((yield* Effect.flip(fs.lookup(Vfs.Entry(root, "name")))).code, "NotFound")
      const detached = new Uint8Array([1])
      structuredClone(detached, { transfer: [detached.buffer] })
      assert.strictEqual((yield* Effect.flip(fs.lookup(Vfs.Entry(root, detached)))).code, "InvalidArgument")

      const maximum = new Uint8Array(255).fill(97)
      const maximumPath = yield* Vfs.pathFromBytes(new Uint8Array([47, ...maximum]))
      yield* fs.writeFile(maximumPath, bytes(1), { access: "write", create: "exclusive" })
      yield* fs.lookup(Vfs.Entry(root, maximum))

      const opaque = new Uint8Array([0xff])
      const opaquePath = yield* Vfs.pathFromBytes(new Uint8Array([47, ...opaque]))
      yield* fs.writeFile(opaquePath, bytes(2), { access: "write", create: "exclusive" })
      const opaqueReference = yield* fs.lookup(Vfs.Entry(root, opaque))
      assert.strictEqual((yield* fs.stat(opaqueReference)).size, 1n)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("keeps a removed directory stale for mutations while a handle still holds it", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/a")
      const root = yield* fs.root
      const a = yield* fs.lookup(Vfs.Entry(root, name("a")))
      const handle = yield* fs.openDirectory("/a")
      yield* fs.rmdir("/a")
      assert.strictEqual((yield* handle.stat).nlink, 0)
      // The removed directory stops counting at rmdir, even while the handle still holds it.
      assert.deepStrictEqual(yield* (yield* Vfs.Volume).usage, { usedBytes: 0n, entries: 0 })
      assert.strictEqual((yield* Effect.flip(fs.stat(a))).code, "StaleReference")
      assert.strictEqual((yield* Effect.flip(fs.parent(a))).code, "StaleReference")
      assert.strictEqual((yield* Effect.flip(fs.mkdir(Vfs.Entry(a, name("orphan"))))).code, "StaleReference")
      yield* fs.writeFile("/f", bytes(1), { access: "write", create: "exclusive" })
      assert.strictEqual(
        (yield* Effect.flip(fs.rename(Vfs.Entry(root, name("f")), Vfs.Entry(a, name("g"))))).code,
        "StaleReference"
      )
      assert.deepStrictEqual(yield* (yield* Vfs.Volume).usage, { usedBytes: 1n, entries: 1 })
      yield* handle.close
      assert.strictEqual((yield* Effect.flip(handle.stat)).code, "InvalidHandle")
      assert.deepStrictEqual(entryNames(yield* fs.readDirectory("/")), ["f"])
      assert.deepStrictEqual(yield* (yield* Vfs.Volume).usage, { usedBytes: 1n, entries: 1 })
    }).pipe(Effect.provide(Testing.layer())))
})
