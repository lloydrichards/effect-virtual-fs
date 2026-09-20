import { assert, describe } from "@effect/vitest"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const name = (value: string) => new TextEncoder().encode(value)

import { it } from "./TestEffect.js"

describe("reference mutations", () => {
  it.effect(
    "creates entries with exact identities, initial times, and coordinated directory changes",
    () =>
      Effect.gen(function*() {
        const fs = yield* (yield* Vfs.make()).caller({ umask: 0 })
        const root = yield* fs.rootReference

        const directory = yield* fs.mkdirReference(root, name("directory"), {
          mode: 0o750,
          times: {
            access: { kind: "value", nanoseconds: 11n },
            modification: { kind: "value", nanoseconds: 12n }
          }
        })

        assert.strictEqual(yield* fs.lookupReference(root, name("directory")), directory.reference)
        assert.isTrue(directory.directory.after > directory.directory.before)
        assert.deepInclude((yield* fs.observeMetadata(directory.reference)).value, {
          mode: 0o750,
          atimeNs: 11n,
          mtimeNs: 12n
        })

        const link = yield* fs.symlinkReference("target", root, name("link"), {
          times: {
            access: { kind: "value", nanoseconds: 21n },
            modification: { kind: "value", nanoseconds: 22n }
          }
        })

        assert.deepStrictEqual(yield* fs.readLinkReference(link.reference), name("target"))
        assert.deepInclude((yield* fs.observeMetadata(link.reference)).value, { atimeNs: 21n, mtimeNs: 22n })

        const invalid = [new Uint8Array(), name("."), name(".."), name("a/b"), new Uint8Array([0])]

        for (const component of invalid) {
          assert.strictEqual((yield* Effect.flip(fs.mkdirReference(root, component))).code, "InvalidArgument")
        }
      })
  )

  it.effect(
    "opens or creates one child atomically and supports writable reference handles",
    () =>
      Effect.gen(function*() {
        const fs = yield* (yield* Vfs.make()).caller({ umask: 0 })
        const root = yield* fs.rootReference

        const created = yield* fs.openChildReference(root, name("file"), {
          access: "readWrite",
          create: "exclusive",
          mode: 0o640,
          times: {
            access: { kind: "value", nanoseconds: 31n },
            modification: { kind: "value", nanoseconds: 32n }
          }
        })

        assert.isTrue(created.created)
        assert.isTrue(created.directory.after > created.directory.before)
        assert.deepInclude(yield* created.handle.stat, { mode: 0o640, atimeNs: 31n, mtimeNs: 32n })

        const sized = yield* fs.openChildReference(root, name("sized"), {
          access: "read",
          create: "exclusive",
          initialSize: 3n
        })

        assert.deepInclude(yield* sized.handle.stat, { size: 3n })
        yield* sized.handle.close
        yield* created.handle.write(new Uint8Array([1, 2]))
        yield* created.handle.close
        const beforeExisting = (yield* fs.observeMetadata(created.reference)).value

        const existing = yield* fs.openChildReference(root, name("file"), {
          access: "readWrite",
          create: "ifMissing",
          mode: 0o777,
          times: {
            access: { kind: "value", nanoseconds: 99n },
            modification: { kind: "value", nanoseconds: 99n }
          }
        })

        assert.isFalse(existing.created)
        assert.strictEqual(existing.reference, created.reference)
        assert.strictEqual(existing.directory.before, existing.directory.after)
        assert.deepInclude(yield* existing.handle.stat, {
          mode: beforeExisting.mode,
          atimeNs: beforeExisting.atimeNs,
          mtimeNs: beforeExisting.mtimeNs
        })
        yield* existing.handle.close
        assert.strictEqual(
          (yield* Effect.flip(fs.openChildReference(root, name("file"), {
            access: "read",
            create: "exclusive"
          }))).code,
          "AlreadyExists"
        )

        const writer = yield* fs.openReference(created.reference, { access: "write", append: true })
        yield* writer.write(new Uint8Array([3]))
        assert.deepStrictEqual(yield* fs.readFile("/file"), new Uint8Array([1, 2, 3]))
        yield* fs.unlinkReference(root, name("file"))
        yield* writer.write(new Uint8Array([4]))
        assert.strictEqual((yield* Effect.flip(fs.openReference(created.reference))).code, "StaleReference")
        assert.strictEqual(
          (yield* Effect.flip(fs.linkReference(created.reference, root, name("resurrected")))).code,
          "StaleReference"
        )
        yield* writer.close
        assert.strictEqual((yield* Effect.flip(fs.observeMetadata(created.reference))).code, "StaleReference")
      })
  )

  it.effect("links, renames, and removes by exact object identity", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      const root = yield* fs.rootReference
      const left = yield* fs.mkdirReference(root, name("left"))
      const right = yield* fs.mkdirReference(root, name("right"))

      const file = yield* fs.openChildReference(left.reference, name("file"), {
        access: "readWrite",
        create: "exclusive"
      })

      yield* file.handle.close
      const linked = yield* fs.linkReference(file.reference, right.reference, name("alias"))
      assert.strictEqual(linked.reference, file.reference)
      const noOp = yield* fs.renameReference(left.reference, name("file"), right.reference, name("alias"))
      assert.strictEqual(noOp._tag, "DifferentDirectories")

      if (Vfs.RenameReferenceResult.guards.DifferentDirectories(noOp)) {
        assert.strictEqual(noOp.sourceDirectory.before, noOp.sourceDirectory.after)
        assert.strictEqual(noOp.destinationDirectory.before, noOp.destinationDirectory.after)
      }

      const moved = yield* fs.renameReference(left.reference, name("file"), right.reference, name("moved"))
      assert.strictEqual(moved._tag, "DifferentDirectories")
      assert.strictEqual(yield* fs.lookupReference(right.reference, name("moved")), file.reference)
      yield* fs.unlinkReference(right.reference, name("alias"))
      yield* fs.unlinkReference(right.reference, name("moved"))
      const removed = yield* fs.rmdirReference(root, name("left"))
      assert.isTrue(removed.after > removed.before)
      yield* fs.rmdirReference(root, name("right"))
    }))

  it.effect("applies metadata and truncation authority to the invoking caller", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller({ umask: 0 })
      const root = yield* admin.rootReference

      const opened = yield* admin.openChildReference(root, name("file"), {
        access: "readWrite",
        create: "exclusive",
        mode: 0o600
      })

      yield* opened.handle.write(new Uint8Array([1, 2, 3]))
      yield* opened.handle.close
      yield* admin.chmodReference(opened.reference, 0o640)
      yield* admin.chownReference(opened.reference, { uid: 7, gid: 8 })
      yield* admin.utimesReference(opened.reference, {
        access: { kind: "value", nanoseconds: 41n },
        modification: { kind: "value", nanoseconds: 42n }
      })
      assert.deepInclude((yield* admin.observeMetadata(opened.reference)).value, { atimeNs: 41n, mtimeNs: 42n })
      yield* admin.truncateReference(opened.reference, 1n)
      assert.deepInclude((yield* admin.observeMetadata(opened.reference)).value, {
        uid: 7,
        gid: 8,
        mode: 0o640,
        atimeNs: 41n,
        size: 1n
      })

      const guest = yield* volume.caller({ identity: { uid: 9, gid: 9, groups: [], privileged: false } })
      assert.strictEqual((yield* Effect.flip(guest.chmodReference(opened.reference, 0o600))).code, "AccessDenied")
      assert.strictEqual((yield* Effect.flip(guest.chownReference(opened.reference, { uid: 9 }))).code, "AccessDenied")
      assert.strictEqual(
        (yield* Effect.flip(guest.utimesReference(opened.reference, {
          access: { kind: "value", nanoseconds: 1n },
          modification: { kind: "value", nanoseconds: 1n }
        }))).code,
        "AccessDenied"
      )
      assert.strictEqual((yield* Effect.flip(guest.truncateReference(opened.reference, 0n))).code, "AccessDenied")
      assert.strictEqual(
        (yield* Effect.flip(guest.openReference(opened.reference, { access: "write" }))).code,
        "AccessDenied"
      )
      assert.strictEqual((yield* Effect.flip(guest.mkdirReference(root, name("blocked")))).code, "AccessDenied")
      assert.strictEqual(
        (yield* Effect.flip(guest.symlinkReference("target", root, name("blocked")))).code,
        "AccessDenied"
      )
      assert.strictEqual(
        (yield* Effect.flip(guest.linkReference(opened.reference, root, name("blocked")))).code,
        "AccessDenied"
      )
      assert.strictEqual((yield* Effect.flip(guest.unlinkReference(root, name("file")))).code, "AccessDenied")
      assert.strictEqual((yield* Effect.flip(guest.rmdirReference(root, name("missing")))).code, "AccessDenied")
      assert.strictEqual(
        (yield* Effect.flip(guest.renameReference(root, name("file"), root, name("moved")))).code,
        "AccessDenied"
      )
      assert.strictEqual(
        (yield* Effect.flip(guest.openChildReference(root, name("other"), {
          access: "write",
          create: "ifMissing"
        }))).code,
        "AccessDenied"
      )
    }))

  it.effect("checks an expected child before changing an open target", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      const root = yield* fs.rootReference
      const first = yield* fs.openChildReference(root, name("guarded"), { access: "write", create: "exclusive" })

      assert.strictEqual(
        (yield* Effect.flip(fs.openChildReference(root, name("guarded"), {
          access: "write",
          create: "ifMissing",
          truncate: true
        }, null))).code,
        "VolumeBusy"
      )

      const same = yield* fs.openChildReference(root, name("guarded"), {
        access: "read",
        create: "ifMissing"
      }, first.reference)

      assert.strictEqual(same.reference, first.reference)
      yield* same.handle.close

      yield* fs.unlinkReference(root, name("guarded"))
      yield* fs.writeFile("/guarded", new Uint8Array([7]), { access: "write", create: "exclusive" })

      assert.strictEqual(
        (yield* Effect.flip(fs.openChildReference(root, name("guarded"), {
          access: "write",
          create: "ifMissing",
          truncate: true
        }, first.reference))).code,
        "VolumeBusy"
      )
      assert.deepStrictEqual(yield* fs.readFile("/guarded"), new Uint8Array([7]))
      yield* first.handle.close
    }))

  it.effect("returns non-overlapping revision pairs under concurrent creation", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      const root = yield* fs.rootReference

      const results = yield* Effect.forEach(
        Array.from({ length: 16 }, (_, index) => index),
        (index) => fs.mkdirReference(root, name(`d-${index}`)),
        { concurrency: "unbounded" }
      )

      const ordered = [...results].sort((left, right) => left.directory.before < right.directory.before ? -1 : 1)

      for (let index = 1; index < ordered.length; index++) {
        assert.strictEqual(ordered[index - 1]!.directory.after, ordered[index]!.directory.before)
      }
    }))
})
