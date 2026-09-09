import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, Result } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { VirtualFileSystem as Vfs } from "../src/index.js"

describe("metadata authority", () => {
  it.effect("rejects timestamps outside the snapshot domain before changing path or handle metadata", () =>
    Effect.gen(function*() {
      const fs = yield* (yield* Vfs.make()).caller()
      const handle = yield* fs.open("/f", { access: "write", create: "exclusive" })
      const before = yield* handle.stat
      for (const nanoseconds of [10n ** 128n, -(10n ** 128n)]) {
        const times = { access: { kind: "value", nanoseconds }, modification: { kind: "now" } } as const
        const result = yield* Effect.result(fs.utimes("/f", times))
        assert.isTrue(Result.isFailure(result), "out-of-domain timestamp must fail")
        if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "InvalidArgument")
        assert.deepStrictEqual(yield* handle.stat, before)
        assert.strictEqual((yield* Effect.flip(fs.utimesHandle(handle, times))).code, "InvalidArgument")
        assert.deepStrictEqual(yield* handle.stat, before)
      }
    }))

  it.effect("round-trips timestamp boundaries and rejects out-of-domain fixture metadata", () =>
    Effect.gen(function*() {
      const maximum = 10n ** 128n - 1n
      const volume = yield* Vfs.fromFixture({
        rootMetadata: { birthtimeNs: -maximum },
        entries: [{ kind: "file", path: "/f", bytes: new Uint8Array(), metadata: { ctimeNs: maximum } }]
      })
      const fs = yield* volume.caller()
      yield* fs.utimes("/f", {
        access: { kind: "value", nanoseconds: maximum },
        modification: { kind: "value", nanoseconds: -maximum }
      })
      const encoded = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
      const restored = yield* Vfs.fromSnapshot(
        yield* Vfs.decodeSnapshot(encoded, {
          maxEncodedBytes: 8192,
          maxRecords: 2,
          maxEntries: 1,
          maxDecodedBytes: 1
        })
      )
      const copy = yield* restored.caller()
      assert.strictEqual((yield* copy.stat("/")).birthtimeNs, -maximum)
      const metadata = yield* copy.stat("/f")
      assert.strictEqual(metadata.atimeNs, maximum)
      assert.strictEqual(metadata.mtimeNs, -maximum)
      for (const nanoseconds of [maximum + 1n, -maximum - 1n]) {
        const rootError = yield* Effect.flip(Vfs.fromFixture({
          rootMetadata: { atimeNs: nanoseconds },
          entries: []
        }))
        assert.strictEqual(rootError._tag, "ImageError")
        if (rootError._tag === "ImageError") assert.strictEqual(rootError.code, "InvalidStructure")
        const entryError = yield* Effect.flip(Vfs.fromFixture({
          entries: [{ kind: "file", path: "/f", bytes: new Uint8Array(), metadata: { birthtimeNs: nanoseconds } }]
        }))
        assert.strictEqual(entryError._tag, "ImageError")
        if (entryError._tag === "ImageError") assert.strictEqual(entryError.code, "InvalidStructure")
      }
    }))

  it.effect("rejects unsupported captured clock samples before creation or mutation", () =>
    Effect.gen(function*() {
      const original = yield* Clock.clockWith(Effect.succeed)
      let now = 10n ** 128n
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => original.currentTimeMillisUnsafe(),
        currentTimeMillis: original.currentTimeMillis,
        currentTimeNanosUnsafe: () => now,
        currentTimeNanos: Effect.sync(() => now),
        monotonicTimeNanosUnsafe: () => original.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: original.monotonicTimeNanos,
        sleep: (duration) => original.sleep(duration)
      }
      const result = yield* Effect.result(Vfs.make().pipe(Effect.provideService(Clock.Clock, clock)))
      assert.isTrue(Result.isFailure(result), "out-of-domain Clock must fail construction")
      if (Result.isFailure(result)) assert.strictEqual(result.failure.field, "clock.currentTimeNanos")
      now = 0n
      const volume = yield* Vfs.make().pipe(Effect.provideService(Clock.Clock, clock))
      const fs = yield* volume.caller()
      const file = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
      yield* file.write(new Uint8Array([1]))
      const before = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
      now = -(10n ** 128n)
      for (const operation of [fs.mkdir("/d"), file.write(new Uint8Array([2])), fs.chmod("/f", 0), fs.readFile("/f")]) {
        assert.strictEqual((yield* Effect.flip(operation)).code, "InvalidArgument")
        assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* volume.snapshot), before)
      }
    }))

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
      assert.strictEqual((yield* f.stat).mode, 0o400)
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
      assert.strictEqual((yield* f.stat).mode, 0o777)
      assert.strictEqual((yield* Effect.flip(owner.chown("/f", { uid: 8 }))).code, "AccessDenied")
      assert.strictEqual((yield* Effect.flip(owner.chown("/f", { gid: 9 }))).code, "AccessDenied")
      yield* admin.chown("/f", { gid: 9 })
      yield* owner.chmod("/f", 0o2777)
      assert.strictEqual((yield* f.stat).mode, 0o777)
      yield* admin.chmod("/f", 0o6777)
      yield* f.write(new Uint8Array([1]))
      assert.strictEqual((yield* f.stat).mode, 0o777)
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
      yield* foreign.close
      assert.strictEqual((yield* Effect.flip(fs.chmodHandle(foreign, 0))).code, "ForeignHandle")
      const own = yield* fs.openDirectory("/")
      yield* own.close
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
      assert.strictEqual((yield* f.stat).size, 1n)
    }))
})
