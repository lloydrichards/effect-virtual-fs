import { assert, describe } from "@effect/vitest"
import { ByteSize, Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import { entryNames, it } from "./TestEffect.js"

const name = (value: string) => new TextEncoder().encode(value)

const observeChild = Effect.fnUntraced(function*(caller: Vfs.Caller, reference: Vfs.ObjectReference) {
  const observation = yield* caller.stat(reference)

  return {
    reference,
    revision: observation.revision,
    atimeNs: observation.atimeNs,
    mtimeNs: observation.mtimeNs
  }
})

describe("conditional child creation", () => {
  it.effect("rejects a newly present or replaced child before truncating it", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const root = yield* caller.root

      const first = yield* caller.open(Vfs.Entry(root, name("file")), {
        access: "readWrite",
        create: "exclusive",
        expectedChild: null
      })

      yield* first.handle.write(new Uint8Array([1]))
      const expectedChild = yield* observeChild(caller, first.reference)

      const missing = yield* Effect.flip(caller.open(Vfs.Entry(root, name("file")), {
        access: "write",
        create: "ifMissing",
        truncate: true,
        expectedChild: null
      }))

      assert.strictEqual(missing.code, "StaleReference")
      assert.strictEqual((yield* first.handle.stat).size, 1n)
      yield* caller.unlink(Vfs.Entry(root, name("file")))
      yield* caller.writeFile("file", new Uint8Array([2, 3]), { access: "write", create: "exclusive" })

      const replaced = yield* Effect.flip(caller.open(Vfs.Entry(root, name("file")), {
        access: "write",
        truncate: true,
        expectedChild
      }))

      assert.strictEqual(replaced.code, "StaleReference")
      assert.deepStrictEqual(yield* caller.readFile("file"), new Uint8Array([2, 3]))
    }))

  it.effect("checks both mutation revisions and access times before opening", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const root = yield* caller.root

      const first = yield* caller.open(Vfs.Entry(root, name("file")), {
        access: "readWrite",
        create: "exclusive",
        times: { access: { kind: "value", nanoseconds: 1n }, modification: { kind: "value", nanoseconds: 2n } }
      })

      const expectedChild = yield* observeChild(caller, first.reference)
      const matching = yield* caller.open(Vfs.Entry(root, name("file")), { access: "read", expectedChild })
      assert.strictEqual(matching.reference, first.reference)
      yield* caller.readFile("file")
      assert.strictEqual((yield* caller.stat(first.reference)).revision, expectedChild.revision)
      assert.strictEqual(
        (yield* Effect.flip(caller.open(Vfs.Entry(root, name("file")), {
          access: "read",
          expectedChild
        }))).code,
        "StaleReference"
      )
      const beforeWrite = yield* observeChild(caller, first.reference)
      yield* first.handle.write(new Uint8Array([1]))
      assert.strictEqual(
        (yield* Effect.flip(caller.open(Vfs.Entry(root, name("file")), {
          access: "write",
          truncate: true,
          expectedChild: beforeWrite
        }))).code,
        "StaleReference"
      )
      assert.strictEqual((yield* first.handle.stat).size, 1n)
    }))

  it.effect("creates initial size and ownership without changing initial timestamps", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller({ umask: 0o027 })
      const root = yield* caller.root

      const opened = yield* caller.open(Vfs.Entry(root, name("file")), {
        access: "readWrite",
        create: "exclusive",
        mode: 0o666,
        initialSize: 3n,
        owner: { uid: 7, gid: 8 },
        times: { access: { kind: "value", nanoseconds: 11n }, modification: { kind: "value", nanoseconds: 12n } }
      })

      assert.deepInclude(yield* opened.handle.stat, {
        size: 3n,
        uid: 7,
        gid: 8,
        mode: 0o640,
        atimeNs: 11n,
        mtimeNs: 12n
      })

      const existing = yield* caller.open(Vfs.Entry(root, name("file")), {
        access: "read",
        create: "ifMissing",
        initialSize: 9n,
        owner: { uid: 9, gid: 9 }
      })

      assert.deepInclude(yield* existing.handle.stat, { size: 3n, uid: 7, gid: 8 })
      assert.deepStrictEqual(yield* caller.readFile("file"), new Uint8Array(3))
      yield* opened.handle.close
      yield* existing.handle.close
      yield* caller.unlink(Vfs.Entry(root, name("file")))
      assert.strictEqual((yield* volume.usage).usedBytes, 0n)
    }))

  it.effect("leaves no entry when initial size exceeds file or volume capacity", () =>
    Effect.gen(function*() {
      for (
        const [limits, code] of [
          [{ maxFileBytes: ByteSize.bytes(2) }, "FileTooLarge"],
          [{ maxBytes: ByteSize.bytes(2) }, "NoSpace"]
        ] as const
      ) {
        const volume = yield* Vfs.make(limits)
        const caller = yield* volume.caller()
        const root = yield* caller.root
        const before = entryNames(yield* caller.readDirectory(root))

        const error = yield* Effect.flip(caller.open(Vfs.Entry(root, name("file")), {
          access: "write",
          create: "exclusive",
          initialSize: 3n
        }))

        assert.strictEqual(error.code, code)
        assert.deepStrictEqual(entryNames(yield* caller.readDirectory(root)), before)
        assert.strictEqual((yield* volume.usage).usedBytes, 0n)
      }
    }))

  it.effect("checks initial ownership before publishing and accepts a caller group", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller()
      const root = yield* admin.root
      yield* admin.chmod(root, 0o777)
      const caller = yield* volume.caller({ identity: { uid: 7, gid: 8, groups: [9], privileged: false } })

      for (const owner of [{ uid: 10 }, { gid: 10 }]) {
        const error = yield* Effect.flip(caller.open(Vfs.Entry(root, name("file")), {
          access: "write",
          create: "exclusive",
          owner
        }))

        assert.strictEqual(error.code, "AccessDenied")
        assert.strictEqual((yield* Effect.flip(caller.lookup(Vfs.Entry(root, name("file"))))).code, "NotFound")
      }

      const opened = yield* caller.open(Vfs.Entry(root, name("file")), {
        access: "write",
        create: "exclusive",
        owner: { uid: 7, gid: 9 },
        mode: 0o2670,
        exactMode: true,
        initialSize: 3n,
        times: { access: { kind: "value", nanoseconds: 11n }, modification: { kind: "value", nanoseconds: 12n } }
      })

      assert.deepInclude(yield* opened.handle.stat, {
        uid: 7,
        gid: 9,
        mode: 0o2670,
        size: 3n,
        atimeNs: 11n,
        mtimeNs: 12n
      })
    }))
})
