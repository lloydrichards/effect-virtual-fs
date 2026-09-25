import { assert, describe } from "@effect/vitest"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const name = (value: string) => new TextEncoder().encode(value)

import { it } from "./TestEffect.js"

describe("mutation revisions", () => {
  it.effect("keeps references and revisions out of snapshot version 1", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({
        entries: [{ kind: "file", path: "/f", bytes: new Uint8Array([1]) }]
      })

      const fs = yield* volume.caller()
      const before = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
      const root = yield* fs.rootReference
      yield* fs.observeDirectory(root)
      yield* fs.observeMetadata(yield* fs.lookupReference(root, name("f")))
      const after = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
      assert.deepStrictEqual(after, before)
      const encoded = new TextDecoder().decode(after)
      assert.isFalse(encoded.includes("revision"))
      assert.isFalse(encoded.includes("objectReference"))

      const restored = yield* Vfs.fromSnapshot(yield* volume.snapshot)
      const restoredFs = yield* restored.caller()
      const restoredRoot = yield* restoredFs.rootReference
      assert.notStrictEqual(restoredRoot, root)
      assert.strictEqual((yield* Effect.flip(fs.observeMetadata(restoredRoot))).code, "ForeignReference")
      assert.strictEqual((yield* Effect.flip(restoredFs.observeMetadata(root))).code, "ForeignReference")
    }))

  it.effect("distinguishes content and metadata mutations under a fixed clock", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const fs = yield* (yield* Vfs.make()).caller()
      const root = yield* fs.rootReference
      const rootBefore = yield* fs.observeDirectory(root)
      const file = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
      const reference = yield* fs.lookupReference(root, name("f"))
      const created = yield* fs.observeMetadata(reference)
      assert.isTrue((yield* fs.observeDirectory(root)).revision > rootBefore.revision)

      yield* file.write(new Uint8Array([1, 2]))
      const written = yield* fs.observeMetadata(reference)
      assert.isTrue(written.revision > created.revision)
      yield* file.pwrite(new Uint8Array([3, 4]), 0n)
      const sameSize = yield* fs.observeMetadata(reference)
      assert.isTrue(sameSize.revision > written.revision)
      yield* fs.chmod("/f", 0o600)
      const changedMode = yield* fs.observeMetadata(reference)
      assert.isTrue(changedMode.revision > sameSize.revision)
      yield* fs.truncate("/f", 1n)
      const truncated = yield* fs.observeMetadata(reference)
      assert.isTrue(truncated.revision > changedMode.revision)
      yield* fs.chown("/f", { uid: 7 })
      const changedOwner = yield* fs.observeMetadata(reference)
      assert.isTrue(changedOwner.revision > truncated.revision)
      yield* fs.utimes("/f", {
        access: { kind: "value", nanoseconds: 1n },
        modification: { kind: "value", nanoseconds: 2n }
      })
      const changedTimes = yield* fs.observeMetadata(reference)
      assert.isTrue(changedTimes.revision > changedOwner.revision)
      yield* fs.link("/f", "/alias")
      const alias = yield* fs.lookupReference(root, name("alias"))
      assert.strictEqual(alias, reference)
      assert.isTrue((yield* fs.observeMetadata(alias)).revision > changedTimes.revision)
      yield* file.close
    }))

  it.effect(
    "keeps revisions stable for reads, rejected mutations, and existing no-op branches",
    () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(0)
        const fs = yield* (yield* Vfs.make()).caller()
        yield* fs.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const root = yield* fs.rootReference
        const file = yield* fs.lookupReference(root, name("f"))
        const before = yield* fs.observeMetadata(file)
        yield* fs.readFile("/f")
        assert.strictEqual((yield* fs.observeMetadata(file)).revision, before.revision)
        yield* fs.writeFile("/f", new Uint8Array(), { access: "write" })
        assert.strictEqual((yield* fs.observeMetadata(file)).revision, before.revision)
        yield* fs.chown("/f", {})
        assert.strictEqual((yield* fs.observeMetadata(file)).revision, before.revision)
        yield* fs.utimes("/f", { access: { kind: "omit" }, modification: { kind: "omit" } })
        assert.strictEqual((yield* fs.observeMetadata(file)).revision, before.revision)
        yield* Effect.flip(fs.chmod("/f", -1))
        assert.strictEqual((yield* fs.observeMetadata(file)).revision, before.revision)
        const directoryBefore = yield* fs.observeDirectory(root)
        yield* fs.observeDirectory(root)
        assert.strictEqual((yield* fs.observeDirectory(root)).revision, directoryBefore.revision)
      })
  )

  it.effect(
    "advances both directory sides and the moved object on cross-directory rename",
    () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(0)
        const fs = yield* (yield* Vfs.make()).caller()
        yield* fs.mkdir("/a")
        yield* fs.mkdir("/b")
        yield* fs.writeFile("/a/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const root = yield* fs.rootReference
        const a = yield* fs.lookupReference(root, name("a"))
        const b = yield* fs.lookupReference(root, name("b"))
        const file = yield* fs.lookupReference(a, name("f"))
        const beforeA = yield* fs.observeDirectory(a)
        const beforeB = yield* fs.observeDirectory(b)
        const beforeFile = yield* fs.observeMetadata(file)
        yield* fs.rename("/a/f", "/b/f")
        assert.isTrue((yield* fs.observeDirectory(a)).revision > beforeA.revision)
        assert.isTrue((yield* fs.observeDirectory(b)).revision > beforeB.revision)
        assert.isTrue((yield* fs.observeMetadata(file)).revision > beforeFile.revision)
      })
  )

  it.effect("advances directory revisions for create, remove, and replacement", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const fs = yield* (yield* Vfs.make()).caller()
      const root = yield* fs.rootReference
      const initial = yield* fs.observeDirectory(root)
      yield* fs.symlink("old", "/entry")
      const created = yield* fs.observeDirectory(root)
      assert.isTrue(created.revision > initial.revision)
      const oldReference = yield* fs.lookupReference(root, name("entry"))
      yield* fs.writeFile("/entry", new Uint8Array([1]), {
        access: "write",
        create: "ifMissing",
        replaceFinalSymlink: true
      })
      const replaced = yield* fs.observeDirectory(root)
      assert.isTrue(replaced.revision > created.revision)
      assert.strictEqual((yield* Effect.flip(fs.observeMetadata(oldReference))).code, "StaleReference")
      yield* fs.unlink("/entry")
      assert.isTrue((yield* fs.observeDirectory(root)).revision > replaced.revision)
    }))

  it.effect("advances parents and surviving objects for mkdir, link, and unlink", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const fs = yield* (yield* Vfs.make()).caller()
      const root = yield* fs.rootReference
      const beforeMkdir = yield* fs.observeDirectory(root)
      yield* fs.mkdir("/directory")
      const afterMkdir = yield* fs.observeDirectory(root)
      assert.isTrue(afterMkdir.revision > beforeMkdir.revision)

      yield* fs.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const file = yield* fs.lookupReference(root, name("file"))
      const beforeLinkDirectory = yield* fs.observeDirectory(root)
      const beforeLinkFile = yield* fs.observeMetadata(file)
      yield* fs.link("/file", "/alias")
      assert.isTrue((yield* fs.observeDirectory(root)).revision > beforeLinkDirectory.revision)
      assert.isTrue((yield* fs.observeMetadata(file)).revision > beforeLinkFile.revision)

      const beforeUnlinkDirectory = yield* fs.observeDirectory(root)
      const beforeUnlinkFile = yield* fs.observeMetadata(file)
      yield* fs.unlink("/file")
      assert.strictEqual(yield* fs.lookupReference(root, name("alias")), file)
      assert.isTrue((yield* fs.observeDirectory(root)).revision > beforeUnlinkDirectory.revision)
      const surviving = yield* fs.observeMetadata(file)
      assert.isTrue(surviving.revision > beforeUnlinkFile.revision)
      assert.strictEqual(surviving.value.nlink, 1)
    }))

  it.effect(
    "advances the parent for rmdir, same-directory rename, rename over an existing entry, exclusive open, and writeFile create",
    () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(0)
        const fs = yield* (yield* Vfs.make()).caller()
        yield* fs.mkdir("/p")
        yield* fs.mkdir("/p/d")
        yield* fs.writeFile("/p/sibling", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const root = yield* fs.rootReference
        const parent = yield* fs.lookupReference(root, name("p"))
        const sibling = yield* fs.lookupReference(parent, name("sibling"))
        const siblingRevision = (yield* fs.observeMetadata(sibling)).revision
        const parentRevision = () => Effect.map(fs.observeDirectory(parent), (observation) => observation.revision)

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

        const moved = yield* fs.lookupReference(parent, name("a"))
        const displaced = yield* fs.lookupReference(parent, name("x"))
        const movedBefore = (yield* fs.observeMetadata(moved)).revision
        yield* fs.rename("/p/a", "/p/b")
        const afterRename = yield* parentRevision()
        assert.isTrue(afterRename > afterOpen)
        const movedAfterRename = (yield* fs.observeMetadata(moved)).revision
        assert.isTrue(movedAfterRename > movedBefore)
        assert.strictEqual(yield* fs.lookupReference(parent, name("b")), moved)

        yield* fs.rename("/p/b", "/p/x")
        assert.isTrue((yield* parentRevision()) > afterRename)
        assert.strictEqual(yield* fs.lookupReference(parent, name("x")), moved)
        assert.isTrue((yield* fs.observeMetadata(moved)).revision > movedAfterRename)
        assert.strictEqual((yield* Effect.flip(fs.observeMetadata(displaced))).code, "StaleReference")
        assert.strictEqual((yield* fs.observeMetadata(sibling)).revision, siblingRevision)
      })
  )

  it.effect("keeps the revision of a hard link's target when its other name is unlinked", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* fs.link("/f", "/alias")
      const root = yield* fs.rootReference
      const reference = yield* fs.lookupReference(root, name("f"))
      assert.strictEqual(yield* fs.lookupReference(root, name("alias")), reference)
      const linked = yield* fs.observeMetadata(reference)
      assert.strictEqual(linked.value.nlink, 2)

      yield* fs.unlink("/alias")
      const unlinked = yield* fs.observeMetadata(reference)
      assert.isTrue(unlinked.revision > linked.revision)
      assert.strictEqual(unlinked.value.nlink, 1)
      assert.strictEqual(yield* fs.lookupReference(root, name("f")), reference)

      assert.deepStrictEqual(yield* fs.readFile("/f"), new Uint8Array([1]))
      assert.strictEqual((yield* fs.observeMetadata(reference)).revision, unlinked.revision)
      assert.strictEqual((yield* fs.observeMetadata(reference)).revision, unlinked.revision)
    }))

  it.effect("keeps revisions after a failed mutation", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.mkdir("/p")
      yield* fs.mkdir("/p/existing")
      yield* fs.writeFile("/p/sibling", new Uint8Array([1]), { access: "write", create: "exclusive" })
      const root = yield* fs.rootReference
      const parent = yield* fs.lookupReference(root, name("p"))
      const sibling = yield* fs.lookupReference(parent, name("sibling"))
      const parentBefore = (yield* fs.observeDirectory(parent)).revision
      const siblingBefore = (yield* fs.observeMetadata(sibling)).revision
      const rootBefore = (yield* fs.observeDirectory(root)).revision

      assert.strictEqual((yield* Effect.flip(fs.chmod("/p/missing", 0o600))).code, "NotFound")
      assert.strictEqual((yield* Effect.flip(fs.mkdir("/p/existing"))).code, "AlreadyExists")
      assert.strictEqual((yield* Effect.flip(fs.rename("/p/missing", "/p/moved"))).code, "NotFound")

      assert.strictEqual((yield* fs.observeDirectory(parent)).revision, parentBefore)
      assert.strictEqual((yield* fs.observeMetadata(sibling)).revision, siblingBefore)
      assert.strictEqual((yield* fs.observeDirectory(root)).revision, rootBefore)
      assert.strictEqual((yield* Effect.flip(fs.lookupReference(parent, name("moved")))).code, "NotFound")
    }))
})
