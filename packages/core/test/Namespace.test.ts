import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { VirtualFileSystem as Vfs } from "../src/index.js"

describe("directory namespace", () => {
  it.effect("keeps caller and base identity across moves and follows the new parent", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.mkdir("/old")
      yield* fs.mkdir("/new")
      yield* fs.mkdir("/old/work")
      const cwd = yield* fs.withDirectory("/old/work")
      const base = yield* fs.openDirectory("/old/work")
      const before = yield* base.stat
      yield* fs.rename("/old/work", "/new/work")
      yield* fs.mkdir("/old/work")
      yield* cwd.mkdir("child")
      assert.strictEqual((yield* fs.stat("/new/work")).ino, before.ino)
      assert.strictEqual((yield* fs.stat("child", { relativeTo: base })).ino, (yield* cwd.stat("child")).ino)
      assert.strictEqual((yield* cwd.stat("..")).ino, (yield* fs.stat("/new")).ino)
      assert.strictEqual((yield* Effect.flip(fs.stat("/old/work/child"))).code, "NotFound")
      assert.strictEqual((yield* fs.stat("/old")).nlink, 3)
      assert.strictEqual((yield* fs.stat("/new")).nlink, 3)
    }))

  it.effect("replaces empty directories atomically and releases only the displaced entry charge", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make({ maxEntries: 2 })).caller()
      yield* fs.mkdir("/source")
      yield* fs.mkdir("/target")
      const displaced = yield* fs.openDirectory("/target")
      const removedCaller = yield* fs.withDirectory("/target")
      const source = yield* fs.stat("/source")
      yield* fs.rename("/source", "/target/")
      assert.strictEqual((yield* fs.stat("/target")).ino, source.ino)
      assert.strictEqual((yield* displaced.stat).nlink, 0)
      assert.strictEqual((yield* Effect.flip(removedCaller.mkdir("lost"))).code, "NotFound")
      assert.strictEqual((yield* Effect.flip(removedCaller.stat(".."))).code, "NotFound")
      assert.strictEqual((yield* removedCaller.stat("/target")).ino, source.ino)
      yield* fs.mkdir("/reclaimed")
      assert.strictEqual((yield* fs.stat("/")).nlink, 4)
    }))

  it.effect("preserves both trees and metadata when rename rejects a cycle or nonempty replacement", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.mkdir("/a")
      yield* fs.mkdir("/a/child")
      yield* fs.mkdir("/b")
      yield* fs.mkdir("/b/child")
      const a = yield* fs.stat("/a")
      const b = yield* fs.stat("/b")
      yield* TestClock.adjust("1 second")
      assert.strictEqual((yield* Effect.flip(fs.rename("/a", "/a/child/moved"))).code, "InvalidArgument")
      assert.strictEqual((yield* Effect.flip(fs.rename("/a", "/b"))).code, "NotEmpty")
      assert.deepStrictEqual(yield* fs.stat("/a"), a)
      assert.deepStrictEqual(yield* fs.stat("/b"), b)
      yield* fs.stat("/a/child")
      yield* fs.stat("/b/child")
    }))

  it.effect("treats a same-entry rename as a metadata-preserving no-op at full quota", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make({ maxEntries: 1 })).caller()
      yield* fs.mkdir("/a")
      const root = yield* fs.stat("/")
      const a = yield* fs.stat("/a")
      yield* TestClock.adjust("1 second")
      yield* fs.rename("/a", "//a/")
      assert.deepStrictEqual(yield* fs.stat("/a"), a)
      assert.deepStrictEqual(yield* fs.stat("/"), root)
      yield* fs.rename("/a", "/b")
      assert.strictEqual((yield* fs.stat("/b")).ino, a.ino)
    }))

  it.effect("validates dot components, roots, and missing trailing-slash destinations without mutation", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.mkdir("/a")
      for (const path of ["/a/.", "/a/..", "/"]) {
        assert.strictEqual((yield* Effect.flip(fs.rename(path, "/b"))).code, "InvalidArgument")
        assert.strictEqual((yield* Effect.flip(fs.rename("/a", path))).code, "InvalidArgument")
        assert.strictEqual((yield* Effect.flip(fs.rmdir(path))).code, "InvalidArgument")
      }
      assert.strictEqual((yield* Effect.flip(fs.rename("/a", "/b/"))).code, "NotFound")
      yield* fs.stat("/a")
    }))

  it.effect("removes only empty directories and retains live handle metadata until close", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make({ maxEntries: 2 })).caller()
      yield* fs.mkdir("/a")
      yield* fs.mkdir("/a/b")
      const base = yield* fs.openDirectory("/a/b")
      assert.strictEqual((yield* Effect.flip(fs.rmdir("/a"))).code, "NotEmpty")
      yield* fs.rmdir("/a/b")
      assert.strictEqual((yield* base.stat).nlink, 0)
      assert.strictEqual((yield* Effect.flip(fs.mkdir("child", { relativeTo: base }))).code, "NotFound")
      assert.strictEqual((yield* fs.stat("/a")).nlink, 2)
      yield* fs.mkdir("/reuse")
      yield* base.close
      assert.strictEqual((yield* Effect.flip(base.stat)).code, "InvalidHandle")
    }))

  it.effect("checks both parent permissions and sticky ownership using the invoking caller", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller({ umask: 0 })
      yield* admin.mkdir("/shared", { mode: 0o1777 })
      yield* admin.mkdir("/locked", { mode: 0o755 })
      const alice = yield* volume.caller({ identity: { uid: 1, gid: 1, groups: [], privileged: false } })
      const bob = yield* volume.caller({ identity: { uid: 2, gid: 2, groups: [], privileged: false } })
      yield* alice.mkdir("/shared/alice")
      yield* bob.mkdir("/shared/bob")
      assert.strictEqual((yield* Effect.flip(bob.rmdir("/shared/alice"))).code, "AccessDenied")
      assert.strictEqual((yield* Effect.flip(bob.rename("/shared/alice", "/shared/stolen"))).code, "AccessDenied")
      assert.strictEqual((yield* Effect.flip(bob.rename("/shared/bob", "/shared/alice"))).code, "AccessDenied")
      assert.strictEqual((yield* Effect.flip(alice.rename("/shared/alice", "/locked/alice"))).code, "AccessDenied")
      yield* alice.rename("/shared/alice", "/shared/renamed")
      yield* alice.rmdir("/shared/renamed")
      yield* admin.rmdir("/shared/bob")
    }))

  it.effect("resolves independent source and destination bases and ignores them for absolute paths", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.mkdir("/a")
      yield* fs.mkdir("/b")
      yield* fs.mkdir("/a/work")
      const a = yield* fs.openDirectory("/a")
      const b = yield* fs.openDirectory("/b")
      yield* fs.rename("work", "moved", { sourceRelativeTo: a, destinationRelativeTo: b })
      yield* fs.stat("/b/moved")
      const foreign = yield* (yield* (yield* Vfs.make()).caller()).openDirectory("/")
      assert.strictEqual(
        (yield* Effect.flip(fs.rename("moved", "/a/work", { sourceRelativeTo: foreign }))).code,
        "ForeignHandle"
      )
      yield* fs.rename("/b/moved", "/a/work", { sourceRelativeTo: foreign, destinationRelativeTo: foreign })
      yield* a.close
      assert.strictEqual(
        (yield* Effect.flip(fs.rename("/a/work", "work", { destinationRelativeTo: a }))).code,
        "InvalidHandle"
      )
    }))

  it.effect("publishes parent timestamps together and serializes competing renames", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.mkdir("/a")
      yield* fs.mkdir("/b")
      yield* fs.mkdir("/a/work")
      yield* TestClock.adjust("1 second")
      const results = yield* Effect.all([
        Effect.result(fs.rename("/a/work", "/b/first")),
        Effect.result(fs.rename("/a/work", "/b/second"))
      ], { concurrency: "unbounded" })
      assert.strictEqual(results.filter((result) => result._tag === "Success").length, 1)
      const a = yield* fs.stat("/a")
      const b = yield* fs.stat("/b")
      assert.strictEqual(a.nlink, 2)
      assert.strictEqual(b.nlink, 3)
      assert.strictEqual(a.mtimeNs, b.mtimeNs)
      assert.strictEqual(a.ctimeNs, b.ctimeNs)
      assert.strictEqual(a.mtimeNs, 1_000_000_000n)
    }))
})
