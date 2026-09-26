import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Clock, Deferred, Duration, Effect, Fiber, Predicate, Result } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Metadata, Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { withVolumeTestSeams } from "../src/internal/testSeams.js"
import { pathText } from "./support/text.js"

// A clock whose wall time is `now`; monotonic time and sleeping stay with `original`.
const wallClock = (original: Clock.Clock, now: () => bigint): Clock.Clock => ({
  currentTimeMillisUnsafe: () => original.currentTimeMillisUnsafe(),
  currentTimeMillis: original.currentTimeMillis,
  currentTimeNanosUnsafe: now,
  currentTimeNanos: Effect.sync(now),
  monotonicTimeNanosUnsafe: () => original.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: original.monotonicTimeNanos,
  sleep: (duration) => original.sleep(duration)
})

describe("metadata authority", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should preserve metadata when a timestamp is outside the snapshot domain",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          const handle = yield* fs.open("/f", { access: "write", create: "exclusive" })
          const before = yield* handle.stat

          for (const nanoseconds of [10n ** 128n, -(10n ** 128n)]) {
            const times = { access: { kind: "value", nanoseconds }, modification: { kind: "now" } } as const
            const result = yield* Effect.result(fs.utimes("/f", times))
            assert.isTrue(Result.isFailure(result), "out-of-domain timestamp must fail")

            if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "InvalidArgument")
            assert.deepStrictEqual(yield* handle.stat, before)
            assert.strictEqual((yield* Effect.flip(fs.utimes(handle, times))).code, "InvalidArgument")
            assert.deepStrictEqual(yield* handle.stat, before)
          }
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should round-trip boundary timestamps and reject values when fixture metadata is out of domain",
      () =>
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
              maxEncodedBytes: ByteSize.kibibytes(8),
              maxRecords: 2,
              maxEntries: 1,
              maxDecodedBytes: ByteSize.bytes(1)
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

            assert.strictEqual(rootError._tag, "VfsError")

            if (Predicate.isTagged("VfsError")(rootError)) assert.strictEqual(rootError.code, "InvalidStructure")

            const entryError = yield* Effect.flip(Vfs.fromFixture({
              entries: [{ kind: "file", path: "/f", bytes: new Uint8Array(), metadata: { birthtimeNs: nanoseconds } }]
            }))

            assert.strictEqual(entryError._tag, "VfsError")

            if (Predicate.isTagged("VfsError")(entryError)) assert.strictEqual(entryError.code, "InvalidStructure")
          }
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should validate metadata before resolving the target when input is invalid",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller

          const code = (effect: Effect.Effect<void, Vfs.VfsError>) =>
            Effect.map(Effect.flip(effect), (error) => error.code)

          // A bad argument is reported before the missing path would be.
          assert.deepStrictEqual([
            yield* code(fs.chmod("/missing", -1)),
            yield* code(fs.chown("/missing", { uid: -1 })),
            // SAFETY: deliberately violates Times to reach the decode failure.
            yield* code(fs.utimes("/missing", { access: { kind: "never" } } as never))
          ], ["InvalidArgument", "InvalidArgument", "InvalidArgument"])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should reject creation and mutation when captured clock samples are unsupported",
      () =>
        Effect.gen(function*() {
          const original = yield* Clock.clockWith(Effect.succeed)
          let now = 10n ** 128n

          const clock = wallClock(original, () => now)

          const result = yield* Effect.result(Vfs.make().pipe(Effect.provideService(Clock.Clock, clock)))
          assert.isTrue(Result.isFailure(result), "out-of-domain Clock must fail construction")

          if (Result.isFailure(result)) {
            assert.isTrue(Predicate.isTagged(result.failure, "VfsError"))

            if (Predicate.isTagged(result.failure, "VfsError")) {
              assert.strictEqual(result.failure.field, "clock.currentTimeNanos")
            }
          }

          now = 0n
          const volume = yield* Vfs.make().pipe(Effect.provideService(Clock.Clock, clock))
          const fs = yield* volume.caller()
          const file = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
          yield* file.write(new Uint8Array([1]))
          const before = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
          now = -(10n ** 128n)

          for (
            const operation of [fs.mkdir("/d"), file.write(new Uint8Array([2])), fs.chmod("/f", 0), fs.readFile("/f")]
          ) {
            assert.strictEqual((yield* Effect.flip(operation)).code, "InvalidArgument")
            assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* volume.snapshot), before)
          }
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should retain open-time access while checking caller authority when chmod follows open",
      () =>
        Effect.gen(function*() {
          const admin = yield* Vfs.Caller
          const owner = yield* Testing.callerAs({ uid: 7, gid: 7, groups: [8], privileged: false })
          const f = yield* admin.open("/f", { access: "readWrite", create: "exclusive" })
          yield* admin.chown("/f", { uid: 7, gid: 8 })
          yield* admin.chmod("/f", 0o600)
          const opened = yield* owner.open("/f", { access: "write" })
          yield* owner.chmod("/f", 0)
          yield* opened.write(new Uint8Array([1]))
          assert.strictEqual((yield* Effect.flip(owner.open("/f", { access: "read" }))).code, "AccessDenied")
          const stranger = yield* Testing.callerAs({ uid: 9, gid: 9, groups: [], privileged: false })
          assert.strictEqual((yield* Effect.flip(stranger.chmod(f, 0o777))).code, "NotPermitted")
          yield* owner.chmod(f, 0o600)
          yield* admin.unlink("/f")
          yield* owner.chmod(f, 0o400)
          assert.strictEqual((yield* f.stat).mode, 0o400)
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should enforce ownership rules and clear set-ID bits when files are written or reassigned",
      () =>
        Effect.gen(function*() {
          const admin = yield* Vfs.Caller
          const owner = yield* Testing.callerAs({ uid: 7, gid: 7, groups: [8], privileged: false })
          const f = yield* admin.open("/f", { access: "readWrite", create: "exclusive" })
          yield* admin.chown("/f", { uid: 7, gid: 7 })
          yield* owner.chmod("/f", 0o6777)
          yield* owner.chown("/f", { gid: 8 })
          assert.strictEqual((yield* f.stat).mode, 0o777)
          assert.strictEqual((yield* Effect.flip(owner.chown("/f", { uid: 8 }))).code, "NotPermitted")
          assert.strictEqual((yield* Effect.flip(owner.chown("/f", { gid: 9 }))).code, "NotPermitted")
          yield* admin.chown("/f", { gid: 9 })
          yield* owner.chmod("/f", 0o2777)
          assert.strictEqual((yield* f.stat).mode, 0o777)
          yield* admin.chmod("/f", 0o6777)
          yield* f.write(new Uint8Array([1]))
          assert.strictEqual((yield* f.stat).mode, 0o777)
          yield* admin.chmod("/f", 0o6777)
          yield* admin.truncate("/f", 0n)
          assert.strictEqual((yield* f.stat).mode, 0o777)
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should preserve omitted timestamps while applying caller authority when times change",
      () =>
        Effect.gen(function*() {
          const admin = yield* Vfs.Caller
          yield* admin.open("/f", { access: "write", create: "exclusive", mode: 0o666 })
          const guest = yield* Testing.callerAs({ uid: 2, gid: 2, groups: [], privileged: false })
          yield* TestClock.adjust("2 seconds")
          yield* guest.utimes("/f", { access: { kind: "now" }, modification: { kind: "now" } })
          assert.strictEqual((yield* admin.stat("/f")).mtimeNs, 2_000_000_000n)
          assert.strictEqual(
            (yield* Effect.flip(
              guest.utimes("/f", { access: { kind: "value", nanoseconds: 3n }, modification: { kind: "omit" } })
            )).code,
            "NotPermitted"
          )
          yield* admin.utimes("/f", { access: { kind: "value", nanoseconds: 3n }, modification: { kind: "omit" } })
          const before = yield* admin.stat("/f")
          assert.strictEqual(before.atimeNs, 3n)
          yield* TestClock.adjust("1 second")
          yield* guest.utimes("/f", { access: { kind: "omit" }, modification: { kind: "omit" } })
          assert.deepStrictEqual(yield* admin.stat("/f"), before)
        }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should update link metadata and reject foreign or closed handles when authority is checked",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          yield* fs.symlink("missing", "/link")
          yield* fs.chown(Vfs.Target.Path({ path: "/link", followFinalSymlink: false }), { uid: 5 })
          assert.strictEqual((yield* fs.stat(Vfs.Target.Path({ path: "/link", followFinalSymlink: false }))).uid, 5)
          const foreign = yield* (yield* (yield* Vfs.make()).caller()).openDirectory("/")
          yield* foreign.close
          assert.strictEqual((yield* Effect.flip(fs.chmod(foreign, 0))).code, "ForeignHandle")
          const own = yield* fs.openDirectory("/")
          yield* own.close
          assert.strictEqual((yield* Effect.flip(fs.chmod(own, 0))).code, "InvalidHandle")
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should preserve offsets and enforce privileged mode rules when truncating paths",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          const f = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
          yield* f.write(new Uint8Array([1, 2, 3]))
          assert.strictEqual(yield* fs.access("/f", 1), 0)
          yield* fs.chmod("/f", 0o100)
          assert.strictEqual(yield* fs.access("/f", 1), 1)
          yield* fs.truncate("/f", 1n)
          assert.strictEqual(yield* f.seek(0n, "current"), 3n)
          assert.strictEqual((yield* Effect.flip(fs.truncate("/f", 4n))).code, "NoSpace")
          assert.strictEqual((yield* f.stat).size, 1n)
        }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(3) } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should allow a write-authorized non-owner to touch times when both values are UTIME_NOW",
      () =>
        Effect.gen(function*() {
          const admin = yield* Vfs.Caller
          yield* admin.mkdir("/deep")
          yield* admin.open("/deep/f", { access: "write", create: "exclusive", mode: 0o666 })
          const guest = yield* Testing.callerAs({ uid: 2, gid: 2, groups: [], privileged: false })
          yield* TestClock.adjust("2 seconds")

          yield* guest.utimes("/deep/f", { access: { kind: "now" }, modification: { kind: "now" } })
          assert.strictEqual((yield* admin.stat("/deep/f")).mtimeNs, 2_000_000_000n)

          // Mixing UTIME_NOW with UTIME_OMIT is not a touch, so POSIX still requires ownership.
          const mixed = yield* Effect.flip(
            guest.utimes("/deep/f", { access: { kind: "now" }, modification: { kind: "omit" } })
          )

          assert.strictEqual(mixed.code, "NotPermitted")
          assert.strictEqual(yield* pathText(mixed.path), "/deep/f")
        }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should name the requested path when a timestamp update is denied", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller
        yield* admin.mkdir("/deep")
        yield* admin.open("/deep/f", { access: "write", create: "exclusive", mode: 0o600 })
        const guest = yield* Testing.callerAs({ uid: 2, gid: 2, groups: [], privileged: false })

        const denied = yield* Effect.flip(
          guest.utimes("/deep/f", { access: { kind: "now" }, modification: { kind: "now" } })
        )

        assert.strictEqual(denied.code, "AccessDenied")
        assert.strictEqual(yield* pathText(denied.path), "/deep/f")

        const handle = yield* guest.openDirectory("/deep")

        const throughHandle = yield* Effect.flip(
          guest.utimes(handle, { access: { kind: "value", nanoseconds: 3n }, modification: { kind: "omit" } })
        )

        assert.strictEqual(throughHandle.code, "NotPermitted")
        assert.strictEqual(throughHandle.path, undefined)
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should require group membership when chown repeats the existing group",
      () =>
        Effect.gen(function*() {
          const admin = yield* Vfs.Caller
          yield* admin.open("/f", { access: "write", create: "exclusive", mode: 0o666 })
          yield* admin.chown("/f", { uid: 7, gid: 9 })
          const owner = yield* Testing.callerAs({ uid: 7, gid: 7, groups: [], privileged: false })

          // POSIX permits a group change only to the caller's effective or supplementary group,
          // with no exemption for re-asserting the group the node already carries.
          assert.strictEqual((yield* Effect.flip(owner.chown("/f", { gid: 9 }))).code, "NotPermitted")
          const member = yield* Testing.callerAs({ uid: 7, gid: 7, groups: [9], privileged: false })

          yield* member.chown("/f", { gid: 9 })
          assert.strictEqual((yield* admin.stat("/f")).gid, 9)
        }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
    )
  })
})

describe("typed mode", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect("should combine type and permission bits when reporting typed mode", () =>
      Effect.gen(function*() {
        const fs = yield* Vfs.Caller
        yield* fs.mkdir("/d", { mode: 0o1755 })
        yield* fs.open("/f", { access: "write", create: "exclusive" })
        yield* fs.chmod("/f", 0o4640)
        yield* fs.symlink("f", "/l")

        const directory = yield* fs.stat("/d")
        const file = yield* fs.stat("/f")
        const symlink = yield* fs.stat(Vfs.Target.Path({ path: "/l", followFinalSymlink: false }))

        assert.strictEqual(Metadata.typedMode(directory), 0o41755)
        assert.strictEqual(Metadata.typedMode(file), 0o104640)
        assert.strictEqual(Metadata.typedMode(symlink), 0o120777)

        // mode itself stays permission bits only, so the kind has one source.
        assert.deepStrictEqual([directory.mode, file.mode, symlink.mode], [0o1755, 0o4640, 0o777])
        assert.deepStrictEqual(
          [directory, file, symlink].map((metadata) => Metadata.typedMode(metadata) & Metadata.S_IFMT),
          [Metadata.S_IFDIR, Metadata.S_IFREG, Metadata.S_IFLNK]
        )
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should distinguish file kinds when reporting typed mode", () =>
      Effect.sync(() => {
        const typeBits = { directory: 0o040000, file: 0o100000, symlink: 0o120000 } as const

        for (const kind of ["directory", "file", "symlink"] as const) {
          assert.strictEqual(Metadata.typedMode({ kind, mode: 0 }), typeBits[kind])
          assert.strictEqual(Metadata.typedMode({ kind, mode: 0o7777 }), typeBits[kind] | 0o7777)
          assert.strictEqual(Metadata.typedMode({ kind, mode: 0o7777 }) & Metadata.S_IFMT, typeBits[kind])
        }
      }))
  })
})

const DAY = Duration.hours(24)

const bytes = (...values: Array<number>) => new Uint8Array(values)

// Lets forked fibers make progress without waiting on any of them.
const settle = Effect.gen(function*() {
  for (let i = 0; i < 4; i++) yield* Effect.yieldNow
})

// Each read that relatime governs, as a function of the caller and a path to a file or directory.
const READS = [
  { name: "readFile", kind: "file", read: (fs: Vfs.Caller, path: string) => Effect.asVoid(fs.readFile(path)) },
  {
    name: "readDirectory",
    kind: "directory",
    read: (fs: Vfs.Caller, path: string) => Effect.asVoid(fs.readDirectory(path))
  },
  {
    name: "pread",
    kind: "file",
    read: (fs: Vfs.Caller, path: string) =>
      Effect.scoped(Effect.flatMap(fs.open(path, { access: "read" }), (file) => file.pread(1, 0n)))
  },
  {
    name: "read",
    kind: "file",
    read: (fs: Vfs.Caller, path: string) =>
      Effect.scoped(Effect.flatMap(fs.open(path, { access: "read" }), (file) => file.read(1)))
  }
] as const

const create = (fs: Vfs.Caller, kind: "file" | "directory", path: string) =>
  kind === "file"
    ? fs.writeFile(path, bytes(1), { access: "write", create: "exclusive" })
    : Effect.asVoid(fs.mkdir(path))

// Changes what the path names: a file's contents, or a directory's entries.
const modify = (fs: Vfs.Caller, kind: "file" | "directory", path: string) =>
  kind === "file"
    ? fs.writeFile(path, bytes(2), { access: "write", truncate: true })
    : Effect.asVoid(fs.mkdir(`${path}/child`))

const atime = (fs: Vfs.Caller, path: string) => Effect.map(fs.stat(path), (metadata) => metadata.atimeNs)

describe("relatime", () => {
  for (const { name, kind, read } of READS) {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        `should refresh access time when ${name} reads after content, status, or daily expiry`,
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* create(fs, kind, "/target")
            yield* TestClock.adjust("1 second")
            yield* read(fs, "/target")
            assert.strictEqual(yield* atime(fs, "/target"), Duration.toNanosUnsafe(Duration.seconds(1)))

            yield* TestClock.adjust("1 second")
            yield* read(fs, "/target")
            assert.strictEqual(yield* atime(fs, "/target"), Duration.toNanosUnsafe(Duration.seconds(1)))

            yield* modify(fs, kind, "/target")
            yield* TestClock.adjust("1 second")
            yield* read(fs, "/target")
            assert.strictEqual(yield* atime(fs, "/target"), Duration.toNanosUnsafe(Duration.seconds(3)))

            yield* TestClock.adjust("1 second")
            yield* fs.chmod("/target", 0o700)
            const changed = yield* fs.stat("/target")
            assert.strictEqual(changed.ctimeNs, Duration.toNanosUnsafe(Duration.seconds(4)))
            assert.strictEqual(changed.mtimeNs, Duration.toNanosUnsafe(Duration.seconds(2)))
            yield* TestClock.adjust("1 second")
            yield* read(fs, "/target")
            assert.strictEqual(yield* atime(fs, "/target"), Duration.toNanosUnsafe(Duration.seconds(5)))

            yield* TestClock.adjust(Duration.subtract(DAY, Duration.nanos(1n)))
            yield* read(fs, "/target")
            assert.strictEqual(yield* atime(fs, "/target"), Duration.toNanosUnsafe(Duration.seconds(5)))
            yield* TestClock.adjust(Duration.nanos(1n))
            yield* read(fs, "/target")
            assert.strictEqual(
              yield* atime(fs, "/target"),
              Duration.toNanosUnsafe(Duration.seconds(5)) + Duration.toNanosUnsafe(DAY)
            )
          }).pipe(Effect.provide(Testing.layer()))
      )
    })
  }

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should leave the access time alone when a handle reads nothing", () =>
      Effect.gen(function*() {
        const fs = yield* Vfs.Caller
        yield* fs.writeFile("/f", bytes(1), { access: "write", create: "exclusive" })
        const file = yield* fs.open("/f", { access: "read" })
        yield* TestClock.adjust("1 second")

        assert.deepStrictEqual((yield* file.pread(0, 0n)).bytes, bytes())
        assert.deepStrictEqual(yield* file.read(0), bytes())
        assert.strictEqual(yield* atime(fs, "/f"), 0n)
      }).pipe(Effect.scoped, Effect.provide(Testing.layer())))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should allow recent reads beside observations and wait for stale reads when relatime is enabled",
      () =>
        Effect.gen(function*() {
          // Both entries were accessed after their last change, so reading them refreshes nothing.
          const base = yield* (yield* Vfs.fromFixture({
            entries: [
              { kind: "file", path: "/recent", bytes: bytes(1, 2), metadata: { atimeNs: 5n } },
              { kind: "directory", path: "/dir", metadata: { atimeNs: 5n } },
              { kind: "file", path: "/stale", bytes: bytes(3) }
            ]
          })).snapshot

          // A second on, so the unread entry's access time is due.
          yield* TestClock.adjust("1 second")

          const overlay = yield* Vfs.makeOverlay(base)
          const fs = yield* overlay.caller()
          const file = yield* fs.open("/recent", { access: "read" })
          const held = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()

          // A capture held between its two halves keeps one permit, which a change must wait for.
          const capturing = yield* overlay.capture().pipe(
            withVolumeTestSeams({
              betweenSnapshotAndSummary: Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release)))
            }),
            Effect.forkChild({ startImmediately: true })
          )

          yield* Deferred.await(held)
          assert.deepStrictEqual(yield* fs.readFile("/recent"), bytes(1, 2))
          assert.strictEqual((yield* fs.readDirectory("/dir")).value.length, 0)
          assert.deepStrictEqual((yield* file.pread(2, 0n)).bytes, bytes(1, 2))

          // A due access time and a cursor read each need a change, so both wait for the capture.
          const stale = yield* fs.readFile("/stale").pipe(Effect.forkChild({ startImmediately: true }))
          const cursor = yield* file.read(2).pipe(Effect.forkChild({ startImmediately: true }))
          yield* settle
          assert.isUndefined(stale.pollUnsafe())
          assert.isUndefined(cursor.pollUnsafe())

          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(capturing)
          assert.deepStrictEqual(yield* Fiber.join(stale), bytes(3))
          assert.deepStrictEqual(yield* Fiber.join(cursor), bytes(1, 2))
          assert.strictEqual(yield* atime(fs, "/recent"), 5n)
        }).pipe(Effect.scoped)
    )
  })
})
