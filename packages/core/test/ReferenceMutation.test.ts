import { assert, describe, it } from "@effect/vitest"
import { Effect, type Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"

const name = (value: string) => new TextEncoder().encode(value)

describe("reference mutations", () => {
  it.effect("applies umask to ordinary directories but preserves an explicit exact mode", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const root = yield* fs.root
      const ordinary = yield* fs.mkdir(Vfs.Entry(root, name("ordinary")), { mode: 0o777 })
      const exact = yield* fs.mkdir(Vfs.Entry(root, name("exact")), { mode: 0o6777, exactMode: true })

      assert.strictEqual((yield* fs.stat(ordinary.reference)).mode, 0o700)
      assert.strictEqual((yield* fs.stat(exact.reference)).mode, 0o6777)
      assert.strictEqual(
        (yield* Effect.flip(fs.mkdir(Vfs.Entry(root, name("invalid")), { exactMode: true }))).code,
        "InvalidArgument"
      )
    }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0o077 } }))))

  it.effect("removes files and empty directories in one operation", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const root = yield* fs.root
      const file = yield* fs.open(Vfs.Entry(root, name("file")), { access: "write", create: "exclusive" })
      yield* file.handle.close
      const directory = yield* fs.mkdir(Vfs.Entry(root, name("directory")))
      const nested = yield* fs.mkdir(Vfs.Entry(root, name("nested")))
      yield* fs.mkdir(Vfs.Entry(nested.reference, name("child")))

      assert.strictEqual((yield* Effect.flip(fs.remove(Vfs.Entry(root, name("nested"))))).code, "NotEmpty")
      const fileChange = yield* fs.remove(Vfs.Entry(root, name("file")))
      const directoryChange = yield* fs.remove(Vfs.Entry(root, name("directory")))
      assert.isTrue(fileChange.after > fileChange.before)
      assert.isTrue(directoryChange.after > directoryChange.before)
      assert.strictEqual((yield* Effect.flip(fs.lookup(Vfs.Entry(root, name("file"))))).code, "NotFound")
      assert.strictEqual((yield* Effect.flip(fs.stat(directory.reference))).code, "StaleReference")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("checks a removal like rmdir and unlink before removing either kind", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const guest = yield* Testing.callerAs({ uid: 9, gid: 9, groups: [], privileged: false })
      const root = yield* fs.root
      const sticky = (yield* fs.mkdir(Vfs.Entry(root, name("sticky")), { mode: 0o1777 })).reference
      const file = yield* fs.open(Vfs.Entry(sticky, name("file")), { access: "write", create: "exclusive" })
      yield* file.handle.close
      const code = <A>(effect: Effect.Effect<A, Vfs.VfsError>) => Effect.map(Effect.flip(effect), (error) => error.code)

      assert.strictEqual(yield* code(guest.remove(Vfs.Entry(sticky, name("file")))), "NotPermitted")
      assert.strictEqual(yield* code(fs.remove(Vfs.Entry(sticky, name("missing")))), "NotFound")
      assert.strictEqual(yield* code(fs.remove(Vfs.Entry(sticky, name(".")))), "InvalidArgument")
      assert.strictEqual(yield* code(fs.remove(Vfs.Entry(root, name("sticky")))), "NotEmpty")

      yield* fs.remove(Vfs.Entry(sticky, name("file")))
      const links = (yield* fs.stat(root)).nlink
      yield* fs.remove(Vfs.Entry(root, name("sticky")))
      assert.strictEqual((yield* fs.stat(root)).nlink, links - 1)
      assert.strictEqual(yield* code(fs.stat(sticky)), "StaleReference")
    }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

  it.effect(
    "creates entries with exact identities, initial times, and coordinated directory changes",
    () =>
      Effect.gen(function*() {
        const fs = yield* Vfs.Caller
        const root = yield* fs.root

        const directory = yield* fs.mkdir(Vfs.Entry(root, name("directory")), {
          mode: 0o750,
          times: {
            access: { kind: "value", nanoseconds: 11n },
            modification: { kind: "value", nanoseconds: 12n }
          }
        })

        assert.strictEqual(yield* fs.lookup(Vfs.Entry(root, name("directory"))), directory.reference)
        assert.isTrue(directory.directory.after > directory.directory.before)
        assert.deepInclude(yield* fs.stat(directory.reference), {
          mode: 0o750,
          atimeNs: 11n,
          mtimeNs: 12n
        })

        const link = yield* fs.symlink("target", Vfs.Entry(root, name("link")), {
          times: {
            access: { kind: "value", nanoseconds: 21n },
            modification: { kind: "value", nanoseconds: 22n }
          }
        })

        assert.deepStrictEqual(yield* fs.readLink(link.reference), name("target"))
        assert.deepInclude(yield* fs.stat(link.reference), { atimeNs: 21n, mtimeNs: 22n })

        const invalid = [new Uint8Array(), name("."), name(".."), name("a/b"), new Uint8Array([0])]

        for (const component of invalid) {
          assert.strictEqual((yield* Effect.flip(fs.mkdir(Vfs.Entry(root, component)))).code, "InvalidArgument")
        }
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
  )

  it.effect(
    "opens or creates one child atomically and supports writable reference handles",
    () =>
      Effect.gen(function*() {
        const fs = yield* Vfs.Caller
        const root = yield* fs.root

        const created = yield* fs.open(Vfs.Entry(root, name("file")), {
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

        const sized = yield* fs.open(Vfs.Entry(root, name("sized")), {
          access: "read",
          create: "exclusive",
          initialSize: 3n
        })

        assert.deepInclude(yield* sized.handle.stat, { size: 3n })
        yield* sized.handle.close
        yield* created.handle.write(new Uint8Array([1, 2]))
        yield* created.handle.close
        const beforeExisting = yield* fs.stat(created.reference)

        const existing = yield* fs.open(Vfs.Entry(root, name("file")), {
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
          (yield* Effect.flip(fs.open(Vfs.Entry(root, name("file")), {
            access: "read",
            create: "exclusive"
          }))).code,
          "AlreadyExists"
        )

        const writer = yield* fs.open(created.reference, { access: "write", append: true })
        yield* writer.write(new Uint8Array([3]))
        assert.deepStrictEqual(yield* fs.readFile("/file"), new Uint8Array([1, 2, 3]))
        yield* fs.unlink(Vfs.Entry(root, name("file")))
        yield* writer.write(new Uint8Array([4]))
        assert.strictEqual((yield* Effect.flip(fs.open(created.reference, { access: "read" }))).code, "StaleReference")
        assert.strictEqual(
          (yield* Effect.flip(fs.link(created.reference, Vfs.Entry(root, name("resurrected"))))).code,
          "StaleReference"
        )
        yield* writer.close
        assert.strictEqual((yield* Effect.flip(fs.stat(created.reference))).code, "StaleReference")
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
  )

  it.effect("links, renames, and removes by exact object identity", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const root = yield* fs.root
      const left = yield* fs.mkdir(Vfs.Entry(root, name("left")))
      const right = yield* fs.mkdir(Vfs.Entry(root, name("right")))

      const file = yield* fs.open(Vfs.Entry(left.reference, name("file")), {
        access: "readWrite",
        create: "exclusive"
      })

      yield* file.handle.close
      const linked = yield* fs.link(file.reference, Vfs.Entry(right.reference, name("alias")))
      assert.strictEqual(linked.reference, file.reference)
      const noOp = yield* fs.rename(Vfs.Entry(left.reference, name("file")), Vfs.Entry(right.reference, name("alias")))
      assert.strictEqual(noOp._tag, "DifferentDirectories")

      if (Vfs.RenameReferenceResult.guards.DifferentDirectories(noOp)) {
        assert.strictEqual(noOp.sourceDirectory.before, noOp.sourceDirectory.after)
        assert.strictEqual(noOp.destinationDirectory.before, noOp.destinationDirectory.after)
      }

      const moved = yield* fs.rename(Vfs.Entry(left.reference, name("file")), Vfs.Entry(right.reference, name("moved")))
      assert.strictEqual(moved._tag, "DifferentDirectories")
      assert.strictEqual(yield* fs.lookup(Vfs.Entry(right.reference, name("moved"))), file.reference)
      yield* fs.unlink(Vfs.Entry(right.reference, name("alias")))
      yield* fs.unlink(Vfs.Entry(right.reference, name("moved")))
      const removed = yield* fs.rmdir(Vfs.Entry(root, name("left")))
      assert.isTrue(removed.after > removed.before)
      yield* fs.rmdir(Vfs.Entry(root, name("right")))
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports one directory change when a rename stays in its directory", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const root = yield* fs.root
      const file = yield* fs.open(Vfs.Entry(root, name("file")), { access: "write", create: "exclusive" })
      yield* file.handle.close
      yield* fs.link(file.reference, Vfs.Entry(root, name("alias")))

      const noOp = yield* fs.rename(Vfs.Entry(root, name("file")), Vfs.Entry(root, name("alias")))
      assert.strictEqual(noOp._tag, "SameDirectory")

      if (Vfs.RenameReferenceResult.guards.SameDirectory(noOp)) {
        assert.strictEqual(noOp.directory.before, noOp.directory.after)
      }

      const moved = yield* fs.rename(Vfs.Entry(root, name("file")), Vfs.Entry(root, name("moved")))
      assert.strictEqual(moved._tag, "SameDirectory")

      if (Vfs.RenameReferenceResult.guards.SameDirectory(moved)) {
        assert.isTrue(moved.directory.after > moved.directory.before)
      }
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("applies metadata and truncation authority to the invoking caller", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const admin = yield* Vfs.Caller
      const root = yield* admin.root

      const opened = yield* admin.open(Vfs.Entry(root, name("file")), {
        access: "readWrite",
        create: "exclusive",
        mode: 0o600
      })

      yield* opened.handle.write(new Uint8Array([1, 2, 3]))
      yield* opened.handle.close
      yield* admin.chmod(opened.reference, 0o640)
      yield* admin.chown(opened.reference, { uid: 7, gid: 8 })
      yield* admin.utimes(opened.reference, {
        access: { kind: "value", nanoseconds: 41n },
        modification: { kind: "value", nanoseconds: 42n }
      })
      assert.deepInclude(yield* admin.stat(opened.reference), { atimeNs: 41n, mtimeNs: 42n })
      yield* admin.truncate(opened.reference, 1n)
      assert.deepInclude(yield* admin.stat(opened.reference), {
        uid: 7,
        gid: 8,
        mode: 0o640,
        atimeNs: 41n,
        size: 1n
      })

      const guest = yield* Testing.callerAs({ uid: 9, gid: 9, groups: [], privileged: false })
      assert.strictEqual((yield* Effect.flip(guest.chmod(opened.reference, 0o600))).code, "NotPermitted")
      assert.strictEqual((yield* Effect.flip(guest.chown(opened.reference, { uid: 9 }))).code, "NotPermitted")
      assert.strictEqual(
        (yield* Effect.flip(guest.utimes(opened.reference, {
          access: { kind: "value", nanoseconds: 1n },
          modification: { kind: "value", nanoseconds: 1n }
        }))).code,
        "NotPermitted"
      )
      assert.strictEqual((yield* Effect.flip(guest.truncate(opened.reference, 0n))).code, "AccessDenied")
      assert.strictEqual(
        (yield* Effect.flip(guest.open(opened.reference, { access: "write" }))).code,
        "AccessDenied"
      )
      assert.strictEqual((yield* Effect.flip(guest.mkdir(Vfs.Entry(root, name("blocked"))))).code, "AccessDenied")
      assert.strictEqual(
        (yield* Effect.flip(guest.symlink("target", Vfs.Entry(root, name("blocked"))))).code,
        "AccessDenied"
      )
      assert.strictEqual(
        (yield* Effect.flip(guest.link(opened.reference, Vfs.Entry(root, name("blocked"))))).code,
        "AccessDenied"
      )
      assert.strictEqual((yield* Effect.flip(guest.unlink(Vfs.Entry(root, name("file"))))).code, "AccessDenied")
      // A missing name is reported before write permission (#186 decision 5).
      assert.strictEqual((yield* Effect.flip(guest.rmdir(Vfs.Entry(root, name("missing"))))).code, "NotFound")
      assert.strictEqual(
        (yield* Effect.flip(guest.rename(Vfs.Entry(root, name("file")), Vfs.Entry(root, name("moved"))))).code,
        "AccessDenied"
      )
      assert.strictEqual(
        (yield* Effect.flip(guest.open(Vfs.Entry(root, name("other")), {
          access: "write",
          create: "ifMissing"
        }))).code,
        "AccessDenied"
      )
    }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

  it.effect("checks an expected child before changing an open target", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const root = yield* fs.root
      const first = yield* fs.open(Vfs.Entry(root, name("guarded")), { access: "write", create: "exclusive" })

      assert.strictEqual(
        (yield* Effect.flip(fs.open(Vfs.Entry(root, name("guarded")), {
          access: "write",
          create: "ifMissing",
          truncate: true,
          expected: null
        }))).code,
        "VolumeBusy"
      )

      const same = yield* fs.open(Vfs.Entry(root, name("guarded")), {
        access: "read",
        create: "ifMissing",
        expected: first.reference
      })

      assert.strictEqual(same.reference, first.reference)
      yield* same.handle.close

      yield* fs.unlink(Vfs.Entry(root, name("guarded")))
      yield* fs.writeFile("/guarded", new Uint8Array([7]), { access: "write", create: "exclusive" })

      assert.strictEqual(
        (yield* Effect.flip(fs.open(Vfs.Entry(root, name("guarded")), {
          access: "write",
          create: "ifMissing",
          truncate: true,
          expected: first.reference
        }))).code,
        "VolumeBusy"
      )
      assert.deepStrictEqual(yield* fs.readFile("/guarded"), new Uint8Array([7]))
      yield* first.handle.close
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports the parent's revision before and after every entry mutation", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const root = yield* fs.root
      const parent = (yield* fs.mkdir(Vfs.Entry(root, name("parent")))).reference
      const other = (yield* fs.mkdir(Vfs.Entry(root, name("other")))).reference
      const seed = yield* fs.open(Vfs.Entry(parent, name("seed")), { access: "write", create: "exclusive" })
      yield* seed.handle.close

      const revision = (reference: Vfs.ObjectReference) =>
        Effect.map(fs.readDirectory(reference), (observation) => observation.revision)

      const openChild = Effect.fnUntraced(function*(create: "exclusive" | "ifMissing") {
        const opened = yield* fs.open(Vfs.Entry(parent, name("file")), { access: "write", create })

        yield* opened.handle.close

        return opened.directory
      })

      const cases: ReadonlyArray<{
        readonly label: string
        readonly bumps: boolean
        readonly run: Effect.Effect<Vfs.DirectoryChange, Vfs.VfsError, Scope.Scope>
      }> = [
        {
          label: "mkdirReference",
          bumps: true,
          run: Effect.map(fs.mkdir(Vfs.Entry(parent, name("dir"))), (r) => r.directory)
        },
        {
          label: "symlinkReference",
          bumps: true,
          run: Effect.map(fs.symlink("target", Vfs.Entry(parent, name("link"))), (r) => r.directory)
        },
        {
          label: "linkReference",
          bumps: true,
          run: Effect.map(fs.link(seed.reference, Vfs.Entry(parent, name("alias"))), (r) => r.directory)
        },
        { label: "unlinkReference", bumps: true, run: fs.unlink(Vfs.Entry(parent, name("alias"))) },
        { label: "rmdirReference", bumps: true, run: fs.rmdir(Vfs.Entry(parent, name("dir"))) },
        { label: "openChildReference exclusive", bumps: true, run: openChild("exclusive") },
        { label: "openChildReference existing", bumps: false, run: openChild("ifMissing") },
        { label: "removeReference file", bumps: true, run: fs.remove(Vfs.Entry(parent, name("file"))) },
        {
          label: "mkdirReference again",
          bumps: true,
          run: Effect.map(fs.mkdir(Vfs.Entry(parent, name("dir"))), (r) => r.directory)
        },
        { label: "removeReference directory", bumps: true, run: fs.remove(Vfs.Entry(parent, name("dir"))) },
        { label: "removeReference symlink", bumps: true, run: fs.remove(Vfs.Entry(parent, name("link"))) },
        {
          label: "renameReference same directory",
          bumps: true,
          run: Effect.flatMap(
            fs.rename(Vfs.Entry(parent, name("seed")), Vfs.Entry(parent, name("renamed"))),
            (result) =>
              Vfs.RenameReferenceResult.guards.SameDirectory(result)
                ? Effect.succeed(result.directory)
                : Effect.die(`expected SameDirectory, got ${result._tag}`)
          )
        }
      ]

      for (const { bumps, label, run } of cases) {
        const rootBefore = yield* revision(root)
        const r0 = yield* revision(parent)
        const change = yield* run
        const r1 = yield* revision(parent)
        assert.strictEqual(change.before, r0, `${label}: before`)
        assert.strictEqual(change.after, r1, `${label}: after`)

        if (bumps) {
          assert.isTrue(r1 > r0, `${label}: parent advanced`)
        } else assert.strictEqual(r1, r0, `${label}: parent unchanged`)
        assert.strictEqual(yield* revision(root), rootBefore, `${label}: root untouched`)
      }

      const rootBefore = yield* revision(root)
      const parentBefore = yield* revision(parent)
      const otherBefore = yield* revision(other)
      const moved = yield* fs.rename(Vfs.Entry(parent, name("renamed")), Vfs.Entry(other, name("moved")))
      const parentAfter = yield* revision(parent)
      const otherAfter = yield* revision(other)
      assert.strictEqual(moved._tag, "DifferentDirectories")

      if (Vfs.RenameReferenceResult.guards.DifferentDirectories(moved)) {
        assert.deepStrictEqual(moved.sourceDirectory, { before: parentBefore, after: parentAfter })
        assert.deepStrictEqual(moved.destinationDirectory, { before: otherBefore, after: otherAfter })
      }

      assert.isTrue(parentAfter > parentBefore)
      assert.isTrue(otherAfter > otherBefore)
      assert.strictEqual(yield* revision(root), rootBefore)

      const otherUntouched = yield* revision(other)
      const beforeFailure = yield* revision(parent)
      yield* fs.mkdir(Vfs.Entry(parent, name("existing")))
      const beforeRepeat = yield* revision(parent)
      assert.strictEqual((yield* Effect.flip(fs.mkdir(Vfs.Entry(parent, name("existing"))))).code, "AlreadyExists")
      assert.isTrue(beforeRepeat > beforeFailure)
      assert.strictEqual(yield* revision(parent), beforeRepeat)
      assert.strictEqual(yield* revision(other), otherUntouched)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("returns non-overlapping revision pairs under concurrent creation", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      const root = yield* fs.root

      const results = yield* Effect.forEach(
        Array.from({ length: 16 }, (_, index) => index),
        (index) => fs.mkdir(Vfs.Entry(root, name(`d-${index}`))),
        { concurrency: "unbounded" }
      )

      const ordered = [...results].sort((left, right) => left.directory.before < right.directory.before ? -1 : 1)

      for (let index = 1; index < ordered.length; index++) {
        assert.strictEqual(ordered[index - 1]!.directory.after, ordered[index]!.directory.before)
      }
    }).pipe(Effect.provide(Testing.layer())))
})
