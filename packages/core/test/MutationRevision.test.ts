import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { entryNames } from "./support/text.js"

const name = (value: string) => new TextEncoder().encode(value)

describe("mutation revisions", () => {
  it.effect("keeps references and revisions out of snapshot version 1", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const fs = yield* Vfs.Caller
      const before = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
      const root = yield* fs.root
      entryNames(yield* fs.readDirectory(root))
      yield* fs.stat(yield* fs.lookup(Vfs.Entry(root, name("f"))))
      const after = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
      assert.deepStrictEqual(after, before)
      const encoded = new TextDecoder().decode(after)
      assert.isFalse(encoded.includes("revision"))
      assert.isFalse(encoded.includes("objectReference"))

      const restored = yield* Vfs.fromSnapshot(yield* volume.snapshot)
      const restoredFs = yield* restored.caller()
      const restoredRoot = yield* restoredFs.root
      assert.notStrictEqual(restoredRoot, root)
      assert.strictEqual((yield* Effect.flip(fs.stat(restoredRoot))).code, "ForeignReference")
      assert.strictEqual((yield* Effect.flip(restoredFs.stat(root))).code, "ForeignReference")
    }).pipe(
      Effect.provide(
        Testing.layer({ fixture: { entries: [{ kind: "file", path: "/f", bytes: new Uint8Array([1]) }] } })
      )
    ))

  it.effect("distinguishes content and metadata mutations under a fixed clock", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const fs = yield* Vfs.Caller
      const root = yield* fs.root
      const rootBefore = yield* fs.readDirectory(root)
      const file = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
      const reference = yield* fs.lookup(Vfs.Entry(root, name("f")))
      const created = yield* fs.stat(reference)
      assert.isTrue((yield* fs.readDirectory(root)).revision > rootBefore.revision)

      yield* file.write(new Uint8Array([1, 2]))
      const written = yield* fs.stat(reference)
      assert.isTrue(written.revision > created.revision)
      yield* file.pwrite(new Uint8Array([3, 4]), 0n)
      const sameSize = yield* fs.stat(reference)
      assert.isTrue(sameSize.revision > written.revision)
      yield* fs.chmod("/f", 0o600)
      const changedMode = yield* fs.stat(reference)
      assert.isTrue(changedMode.revision > sameSize.revision)
      yield* fs.truncate("/f", 1n)
      const truncated = yield* fs.stat(reference)
      assert.isTrue(truncated.revision > changedMode.revision)
      yield* fs.chown("/f", { uid: 7 })
      const changedOwner = yield* fs.stat(reference)
      assert.isTrue(changedOwner.revision > truncated.revision)
      yield* fs.utimes("/f", {
        access: { kind: "value", nanoseconds: 1n },
        modification: { kind: "value", nanoseconds: 2n }
      })
      const changedTimes = yield* fs.stat(reference)
      assert.isTrue(changedTimes.revision > changedOwner.revision)
      yield* fs.link("/f", "/alias")
      const alias = yield* fs.lookup(Vfs.Entry(root, name("alias")))
      assert.strictEqual(alias, reference)
      assert.isTrue((yield* fs.stat(alias)).revision > changedTimes.revision)
      yield* file.close
    }).pipe(Effect.provide(Testing.layer())))

  it.effect(
    "keeps revisions stable for reads, rejected mutations, and existing no-op branches",
    () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(0)
        const fs = yield* Vfs.Caller
        yield* fs.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const root = yield* fs.root
        const file = yield* fs.lookup(Vfs.Entry(root, name("f")))
        const before = yield* fs.stat(file)
        yield* fs.readFile("/f")
        assert.strictEqual((yield* fs.stat(file)).revision, before.revision)
        yield* fs.writeFile("/f", new Uint8Array(), { access: "write" })
        assert.strictEqual((yield* fs.stat(file)).revision, before.revision)
        yield* fs.chown("/f", {})
        assert.strictEqual((yield* fs.stat(file)).revision, before.revision)
        yield* fs.utimes("/f", { access: { kind: "omit" }, modification: { kind: "omit" } })
        assert.strictEqual((yield* fs.stat(file)).revision, before.revision)
        yield* Effect.flip(fs.chmod("/f", -1))
        assert.strictEqual((yield* fs.stat(file)).revision, before.revision)
        const directoryBefore = yield* fs.readDirectory(root)
        entryNames(yield* fs.readDirectory(root))
        assert.strictEqual((yield* fs.readDirectory(root)).revision, directoryBefore.revision)
      }).pipe(Effect.provide(Testing.layer()))
  )

  it.effect(
    "advances both directory sides and the moved object on cross-directory rename",
    () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(0)
        const fs = yield* Vfs.Caller
        yield* fs.mkdir("/a")
        yield* fs.mkdir("/b")
        yield* fs.writeFile("/a/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const root = yield* fs.root
        const a = yield* fs.lookup(Vfs.Entry(root, name("a")))
        const b = yield* fs.lookup(Vfs.Entry(root, name("b")))
        const file = yield* fs.lookup(Vfs.Entry(a, name("f")))
        const beforeA = yield* fs.readDirectory(a)
        const beforeB = yield* fs.readDirectory(b)
        const beforeFile = yield* fs.stat(file)
        yield* fs.rename("/a/f", "/b/f")
        assert.isTrue((yield* fs.readDirectory(a)).revision > beforeA.revision)
        assert.isTrue((yield* fs.readDirectory(b)).revision > beforeB.revision)
        assert.isTrue((yield* fs.stat(file)).revision > beforeFile.revision)
      }).pipe(Effect.provide(Testing.layer()))
  )

  it.effect("advances directory revisions for create, remove, and replacement", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const fs = yield* Vfs.Caller
      const root = yield* fs.root
      const initial = yield* fs.readDirectory(root)
      yield* fs.symlink("old", "/entry")
      const created = yield* fs.readDirectory(root)
      assert.isTrue(created.revision > initial.revision)
      const oldReference = yield* fs.lookup(Vfs.Entry(root, name("entry")))
      yield* fs.writeFile("/entry", new Uint8Array([1]), {
        access: "write",
        create: "ifMissing",
        replaceFinalSymlink: true
      })
      const replaced = yield* fs.readDirectory(root)
      assert.isTrue(replaced.revision > created.revision)
      assert.strictEqual((yield* Effect.flip(fs.stat(oldReference))).code, "StaleReference")
      yield* fs.unlink("/entry")
      assert.isTrue((yield* fs.readDirectory(root)).revision > replaced.revision)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("advances parents and surviving objects for mkdir, link, and unlink", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const fs = yield* Vfs.Caller
      const root = yield* fs.root
      const beforeMkdir = yield* fs.readDirectory(root)
      yield* fs.mkdir("/directory")
      const afterMkdir = yield* fs.readDirectory(root)
      assert.isTrue(afterMkdir.revision > beforeMkdir.revision)

      yield* fs.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const file = yield* fs.lookup(Vfs.Entry(root, name("file")))
      const beforeLinkDirectory = yield* fs.readDirectory(root)
      const beforeLinkFile = yield* fs.stat(file)
      yield* fs.link("/file", "/alias")
      assert.isTrue((yield* fs.readDirectory(root)).revision > beforeLinkDirectory.revision)
      assert.isTrue((yield* fs.stat(file)).revision > beforeLinkFile.revision)

      const beforeUnlinkDirectory = yield* fs.readDirectory(root)
      const beforeUnlinkFile = yield* fs.stat(file)
      yield* fs.unlink("/file")
      assert.strictEqual(yield* fs.lookup(Vfs.Entry(root, name("alias"))), file)
      assert.isTrue((yield* fs.readDirectory(root)).revision > beforeUnlinkDirectory.revision)
      const surviving = yield* fs.stat(file)
      assert.isTrue(surviving.revision > beforeUnlinkFile.revision)
      assert.strictEqual(surviving.nlink, 1)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect(
    "advances the parent for rmdir, same-directory rename, rename over an existing entry, exclusive open, and writeFile create",
    () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(0)
        const fs = yield* Vfs.Caller
        yield* fs.mkdir("/p")
        yield* fs.mkdir("/p/d")
        yield* fs.writeFile("/p/sibling", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const root = yield* fs.root
        const parent = yield* fs.lookup(Vfs.Entry(root, name("p")))
        const sibling = yield* fs.lookup(Vfs.Entry(parent, name("sibling")))
        const siblingRevision = (yield* fs.stat(sibling)).revision
        const parentRevision = () => Effect.map(fs.readDirectory(parent), (observation) => observation.revision)

        const beforeRmdir = yield* parentRevision()
        yield* fs.rmdir("/p/d")
        const afterRmdir = yield* parentRevision()
        assert.isTrue(afterRmdir > beforeRmdir)

        yield* fs.writeFile("/p/a", new Uint8Array([2]), { access: "write", create: "exclusive" })
        const afterWrite = yield* parentRevision()
        assert.isTrue(afterWrite > afterRmdir)

        const opened = yield* fs.open("/p/x", { access: "write", create: "exclusive" })
        yield* opened.close
        const afterOpen = yield* parentRevision()
        assert.isTrue(afterOpen > afterWrite)

        const moved = yield* fs.lookup(Vfs.Entry(parent, name("a")))
        const displaced = yield* fs.lookup(Vfs.Entry(parent, name("x")))
        const movedBefore = (yield* fs.stat(moved)).revision
        yield* fs.rename("/p/a", "/p/b")
        const afterRename = yield* parentRevision()
        assert.isTrue(afterRename > afterOpen)
        const movedAfterRename = (yield* fs.stat(moved)).revision
        assert.isTrue(movedAfterRename > movedBefore)
        assert.strictEqual(yield* fs.lookup(Vfs.Entry(parent, name("b"))), moved)

        yield* fs.rename("/p/b", "/p/x")
        assert.isTrue((yield* parentRevision()) > afterRename)
        assert.strictEqual(yield* fs.lookup(Vfs.Entry(parent, name("x"))), moved)
        assert.isTrue((yield* fs.stat(moved)).revision > movedAfterRename)
        assert.strictEqual((yield* Effect.flip(fs.stat(displaced))).code, "StaleReference")
        assert.strictEqual((yield* fs.stat(sibling)).revision, siblingRevision)
      }).pipe(Effect.provide(Testing.layer()))
  )

  it.effect("keeps the revision of a hard link's target when its other name is unlinked", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const fs = yield* Vfs.Caller
      yield* fs.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* fs.link("/f", "/alias")
      const root = yield* fs.root
      const reference = yield* fs.lookup(Vfs.Entry(root, name("f")))
      assert.strictEqual(yield* fs.lookup(Vfs.Entry(root, name("alias"))), reference)
      const linked = yield* fs.stat(reference)
      assert.strictEqual(linked.nlink, 2)

      yield* fs.unlink("/alias")
      const unlinked = yield* fs.stat(reference)
      assert.isTrue(unlinked.revision > linked.revision)
      assert.strictEqual(unlinked.nlink, 1)
      assert.strictEqual(yield* fs.lookup(Vfs.Entry(root, name("f"))), reference)

      assert.deepStrictEqual(yield* fs.readFile("/f"), new Uint8Array([1]))
      assert.strictEqual((yield* fs.stat(reference)).revision, unlinked.revision)
      assert.strictEqual((yield* fs.stat(reference)).revision, unlinked.revision)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("keeps revisions after a failed mutation", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const fs = yield* Vfs.Caller
      yield* fs.mkdir("/p")
      yield* fs.mkdir("/p/existing")
      yield* fs.writeFile("/p/sibling", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* fs.root
      const parent = yield* fs.lookup(Vfs.Entry(root, name("p")))
      const sibling = yield* fs.lookup(Vfs.Entry(parent, name("sibling")))
      const parentBefore = (yield* fs.readDirectory(parent)).revision
      const siblingBefore = (yield* fs.stat(sibling)).revision
      const rootBefore = (yield* fs.readDirectory(root)).revision

      assert.strictEqual((yield* Effect.flip(fs.chmod("/p/missing", 0o600))).code, "NotFound")
      assert.strictEqual((yield* Effect.flip(fs.mkdir("/p/existing"))).code, "AlreadyExists")
      assert.strictEqual((yield* Effect.flip(fs.rename("/p/missing", "/p/moved"))).code, "NotFound")

      assert.strictEqual((yield* fs.readDirectory(parent)).revision, parentBefore)
      assert.strictEqual((yield* fs.stat(sibling)).revision, siblingBefore)
      assert.strictEqual((yield* fs.readDirectory(root)).revision, rootBefore)
      assert.strictEqual((yield* Effect.flip(fs.lookup(Vfs.Entry(parent, name("moved"))))).code, "NotFound")
    }).pipe(Effect.provide(Testing.layer())))
})
