import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { VirtualFileSystem as Vfs } from "../src/index.js"

describe("metadata authority", () => {
  it.effect("keeps open-time access after chmod while metadata uses the invoking caller", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller()
      const owner = yield* volume.caller({ identity: { uid: 7, gid: 7, groups: [8], privileged: false } })
      const f = yield* admin.open("/f", { access: "readWrite", create: "exclusive" })
      yield* admin.chown("/f", { uid: 7, gid: 8 })
      yield* admin.chmod("/f", 0o600)
      const opened = yield* owner.open("/f", { access: "write" })
      yield* owner.chmod("/f", 0)
      yield* opened.write(new Uint8Array([1]))
      assert.strictEqual((yield* Effect.flip(owner.open("/f", { access: "read" }))).code, "AccessDenied")
      const stranger = yield* volume.caller({ identity: { uid: 9, gid: 9, groups: [], privileged: false } })
      assert.strictEqual((yield* Effect.flip(stranger.chmodHandle(f, 0o777))).code, "AccessDenied")
      yield* owner.chmodHandle(f, 0o600)
      yield* admin.unlink("/f")
      yield* owner.chmodHandle(f, 0o400)
      assert.strictEqual((yield* f.stat()).mode, 0o400)
    }))

  it.effect("restricts ownership changes and clears set-ID bits on writes and ownership changes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller()
      const owner = yield* volume.caller({ identity: { uid: 7, gid: 7, groups: [8], privileged: false } })
      const f = yield* admin.open("/f", { access: "readWrite", create: "exclusive" })
      yield* admin.chown("/f", { uid: 7, gid: 7 })
      yield* owner.chmod("/f", 0o6777)
      yield* owner.chown("/f", { gid: 8 })
      assert.strictEqual((yield* f.stat()).mode, 0o777)
      assert.strictEqual((yield* Effect.flip(owner.chown("/f", { uid: 8 }))).code, "AccessDenied")
      assert.strictEqual((yield* Effect.flip(owner.chown("/f", { gid: 9 }))).code, "AccessDenied")
      yield* admin.chown("/f", { gid: 9 })
      yield* owner.chmod("/f", 0o2777)
      assert.strictEqual((yield* f.stat()).mode, 0o777)
      yield* admin.chmod("/f", 0o6777)
      yield* f.write(new Uint8Array([1]))
      assert.strictEqual((yield* f.stat()).mode, 0o777)
    }))

  it.effect("distinguishes owner timestamps from write-authorized now and preserves omitted fields", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller({ umask: 0 })
      yield* admin.open("/f", { access: "write", create: "exclusive", mode: 0o666 })
      const guest = yield* volume.caller({ identity: { uid: 2, gid: 2, groups: [], privileged: false } })
      yield* TestClock.adjust("2 seconds")
      yield* guest.utimes("/f", { access: { kind: "now" }, modification: { kind: "now" } })
      assert.strictEqual((yield* admin.stat("/f")).mtimeNs, 2_000_000_000n)
      assert.strictEqual(
        (yield* Effect.flip(
          guest.utimes("/f", { access: { kind: "value", nanoseconds: 3n }, modification: { kind: "omit" } })
        )).code,
        "AccessDenied"
      )
      yield* admin.utimes("/f", { access: { kind: "value", nanoseconds: 3n }, modification: { kind: "omit" } })
      const before = yield* admin.stat("/f")
      assert.strictEqual(before.atimeNs, 3n)
      yield* TestClock.adjust("1 second")
      yield* guest.utimes("/f", { access: { kind: "omit" }, modification: { kind: "omit" } })
      assert.deepStrictEqual(yield* admin.stat("/f"), before)
    }))

  it.effect("supports own-link metadata and validates foreign and closed handle authority", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      yield* fs.symlink("missing", "/link")
      yield* fs.chown("/link", { uid: 5 }, { followFinalSymlink: false })
      assert.strictEqual((yield* fs.lstat("/link")).uid, 5)
      const foreign = yield* (yield* (yield* Vfs.make()).caller()).openDirectory("/")
      yield* foreign.close()
      assert.strictEqual((yield* Effect.flip(fs.chmodHandle(foreign, 0))).code, "ForeignHandle")
      const own = yield* fs.openDirectory("/")
      yield* own.close()
      assert.strictEqual((yield* Effect.flip(fs.chmodHandle(own, 0))).code, "InvalidHandle")
    }))

  it.effect("checks privileged execute bits and truncates paths without moving existing offsets", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make({ maxBytes: 3 })).caller()
      const f = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
      yield* f.write(new Uint8Array([1, 2, 3]))
      assert.strictEqual((yield* Effect.flip(fs.access("/f", 1))).code, "AccessDenied")
      yield* fs.chmod("/f", 0o100)
      yield* fs.access("/f", 1)
      yield* fs.truncate("/f", 1n)
      assert.strictEqual(yield* f.seek(0n, "current"), 3n)
      assert.strictEqual((yield* Effect.flip(fs.truncate("/f", 4n))).code, "NoSpace")
      assert.strictEqual((yield* f.stat()).size, 1n)
    }))
})
