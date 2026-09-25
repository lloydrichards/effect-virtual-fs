import { assert, describe } from "@effect/vitest"
import { Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const bytes = (...values: Array<number>) => new Uint8Array(values)

const name = (value: string) => new TextEncoder().encode(value)

import { it } from "./TestEffect.js"

describe("object references", () => {
  it.effect("keeps canonical identity across hard links, rename, and path reuse", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const fs = yield* volume.caller()
      yield* fs.writeFile("/a", bytes(1), { access: "write", create: "exclusive" })
      const root = yield* fs.rootReference
      const original = yield* fs.lookupReference(root, name("a"))
      yield* fs.link("/a", "/alias")
      assert.strictEqual(yield* fs.lookupReference(root, name("alias")), original)
      yield* fs.rename("/a", "/moved")
      yield* fs.writeFile("/a", bytes(2), { access: "write", create: "exclusive" })
      assert.strictEqual(yield* fs.lookupReference(root, name("moved")), original)
      assert.notStrictEqual(yield* fs.lookupReference(root, name("a")), original)
      const handle = yield* fs.openReference(original)
      assert.deepStrictEqual(yield* handle.read(1), bytes(1))
      yield* handle.close
    }))

  it.effect("distinguishes forged, foreign, and stale references", () =>
    Effect.gen(function*() {
      const first = yield* Vfs.make()
      const second = yield* Vfs.make()
      const fs = yield* first.caller()
      const other = yield* second.caller()
      const root = yield* fs.rootReference
      assert.strictEqual((yield* Effect.flip(other.observeMetadata(root))).code, "ForeignReference")
      // SAFETY: The forged reference deliberately bypasses the static contract to test runtime authenticity.
      assert.strictEqual(
        (yield* Effect.flip(fs.observeMetadata({} as Vfs.ObjectReference))).code,
        "InvalidReference"
      )
      yield* fs.writeFile("/gone", bytes(1), { access: "write", create: "exclusive" })
      const gone = yield* fs.lookupReference(root, name("gone"))
      yield* fs.unlink("/gone")
      assert.strictEqual((yield* Effect.flip(fs.observeMetadata(gone))).code, "StaleReference")
    }))

  it.effect("keeps an unlinked file observable only until its existing reader closes", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.writeFile("/f", bytes(1, 2), { access: "write", create: "exclusive" })
      const root = yield* fs.rootReference
      const reference = yield* fs.lookupReference(root, name("f"))
      const reader = yield* fs.openReference(reference)
      yield* fs.unlink("/f")
      assert.strictEqual((yield* fs.observeMetadata(reference)).value.nlink, 0)
      assert.deepStrictEqual(yield* reader.read(2), bytes(1, 2))
      assert.strictEqual((yield* Effect.flip(fs.openReference(reference))).code, "StaleReference")
      yield* reader.close
      assert.strictEqual((yield* Effect.flip(fs.observeMetadata(reference))).code, "StaleReference")
    }))

  it.effect("tracks directory parents and owns directory names and symlink targets", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.mkdir("/left")
      yield* fs.mkdir("/right")
      yield* fs.mkdir("/left/child")
      yield* fs.symlink("target", "/link")
      const root = yield* fs.rootReference
      const left = yield* fs.lookupReference(root, name("left"))
      const right = yield* fs.lookupReference(root, name("right"))
      const child = yield* fs.lookupReference(left, name("child"))
      assert.strictEqual(yield* fs.parentReference(root), root)
      assert.strictEqual(yield* fs.parentReference(child), left)
      yield* fs.rename("/left/child", "/right/child")
      assert.strictEqual(yield* fs.parentReference(child), right)

      const observation = yield* fs.observeDirectory(root)
      const firstName = observation.value[0]?.name
      assert.isDefined(firstName)
      firstName[0] = 0
      const names = (yield* fs.observeDirectory(root)).value.map((entry) => new TextDecoder().decode(entry.name))
      assert.deepStrictEqual(names, ["left", "right", "link"])

      const link = yield* fs.lookupReference(root, name("link"))
      const target = yield* fs.readLinkReference(link)
      target[0] = 0
      assert.deepStrictEqual(yield* fs.readLinkReference(link), name("target"))
      yield* fs.rmdir("/right/child")
      assert.strictEqual((yield* Effect.flip(fs.parentReference(child))).code, "StaleReference")
    }))

  it.effect("rechecks the invoking caller's read authority", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller()
      yield* admin.writeFile("/secret", bytes(1), { access: "write", create: "exclusive", mode: 0 })
      const reference = yield* admin.lookupReference(yield* admin.rootReference, name("secret"))
      const guest = yield* volume.caller({ identity: { uid: 1, gid: 1, groups: [], privileged: false } })
      assert.strictEqual((yield* Effect.flip(guest.openReference(reference))).code, "AccessDenied")
      assert.strictEqual((yield* Effect.flip(guest.accessReference(reference, 0o4))).code, "AccessDenied")
      yield* admin.accessReference(reference, 0o4)
      assert.strictEqual((yield* Effect.flip(guest.accessReference(reference, 8))).code, "InvalidArgument")
    }))

  it.effect("observes metadata and link targets without permission on the object", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller({ umask: 0 })
      yield* admin.writeFile("/secret", bytes(1), { access: "write", create: "exclusive", mode: 0 })
      yield* admin.symlink("target", "/link")
      yield* admin.chmod("/link", 0, { followFinalSymlink: false })
      const root = yield* admin.rootReference
      const secret = yield* admin.lookupReference(root, name("secret"))
      const link = yield* admin.lookupReference(root, name("link"))
      const guest = yield* volume.caller({ identity: { uid: 1, gid: 1, groups: [], privileged: false } })

      assert.strictEqual((yield* guest.observeMetadata(secret)).value.mode, 0)
      assert.deepStrictEqual(yield* guest.readLinkReference(link), name("target"))
      assert.strictEqual((yield* Effect.flip(guest.openReference(secret))).code, "AccessDenied")
    }))

  it.effect("rechecks traversal and directory authority for the invoking caller", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller({ umask: 0 })
      yield* admin.mkdir("/directory", { mode: 0o001 })
      yield* admin.mkdir("/directory/child", { mode: 0o001 })
      const root = yield* admin.rootReference
      const directory = yield* admin.lookupReference(root, name("directory"))
      const child = yield* admin.lookupReference(directory, name("child"))
      const guest = yield* volume.caller({ identity: { uid: 1, gid: 1, groups: [], privileged: false } })

      assert.strictEqual(yield* guest.lookupReference(directory, name("child")), child)
      assert.strictEqual(yield* guest.parentReference(child), directory)
      assert.strictEqual((yield* Effect.flip(guest.observeDirectory(directory))).code, "AccessDenied")

      yield* admin.chmod("/directory", 0)
      assert.strictEqual((yield* Effect.flip(guest.lookupReference(directory, name("child")))).code, "AccessDenied")
      yield* admin.chmod("/directory/child", 0)
      assert.strictEqual((yield* Effect.flip(guest.parentReference(child))).code, "AccessDenied")
    }))

  it.effect("validates one byte-preserving lookup component", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      const root = yield* fs.rootReference

      const invalid = [
        new Uint8Array(),
        name("."),
        name(".."),
        name("a/b"),
        new Uint8Array([0]),
        new Uint8Array(256)
      ]

      for (const component of invalid) {
        assert.strictEqual((yield* Effect.flip(fs.lookupReference(root, component))).code, "InvalidArgument")
      }

      // SAFETY: The string deliberately bypasses the byte-array contract to test runtime validation.
      assert.strictEqual(
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime validation requires an invalid typed input.
        (yield* Effect.flip(fs.lookupReference(root, "name" as unknown as Uint8Array))).code,
        "InvalidArgument"
      )
      const detached = new Uint8Array([1])
      structuredClone(detached, { transfer: [detached.buffer] })
      assert.strictEqual((yield* Effect.flip(fs.lookupReference(root, detached))).code, "InvalidArgument")

      const maximum = new Uint8Array(255).fill(97)
      const maximumPath = yield* Vfs.pathFromBytes(new Uint8Array([47, ...maximum]))
      yield* fs.writeFile(maximumPath, bytes(1), { access: "write", create: "exclusive" })
      yield* fs.lookupReference(root, maximum)

      const opaque = new Uint8Array([0xff])
      const opaquePath = yield* Vfs.pathFromBytes(new Uint8Array([47, ...opaque]))
      yield* fs.writeFile(opaquePath, bytes(2), { access: "write", create: "exclusive" })
      const opaqueReference = yield* fs.lookupReference(root, opaque)
      assert.strictEqual((yield* fs.observeMetadata(opaqueReference)).value.size, 1n)
    }))

  it.effect("keeps a removed directory stale for mutations while a handle still holds it", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.mkdir("/a")
      const root = yield* fs.rootReference
      const a = yield* fs.lookupReference(root, name("a"))
      const handle = yield* fs.openDirectory("/a")
      yield* fs.rmdir("/a")
      assert.strictEqual((yield* handle.stat).nlink, 0)
      assert.strictEqual((yield* Effect.flip(fs.observeMetadata(a))).code, "StaleReference")
      assert.strictEqual((yield* Effect.flip(fs.parentReference(a))).code, "StaleReference")
      assert.strictEqual((yield* Effect.flip(fs.mkdirReference(a, name("orphan")))).code, "StaleReference")
      yield* fs.writeFile("/f", bytes(1), { access: "write", create: "exclusive" })
      assert.strictEqual((yield* Effect.flip(fs.renameReference(root, name("f"), a, name("g")))).code, "StaleReference")
      yield* handle.close
      assert.deepStrictEqual(yield* fs.readDirectory("/"), ["f"])
      assert.deepStrictEqual(yield* (yield* Vfs.make()).usage, { usedBytes: 0n, entries: 0 })
    }))
})
