import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import {
  ByteSize,
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Result,
  Scheduler,
  Schema,
  Scope,
  Tracer
} from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { withVolumeTestSeams } from "../src/internal/testSeams.js"
import { exists, failure, GUEST, RECURSIVE, write } from "./support/caller.js"
import { entryNames, pathText, rawEntryNames, text } from "./support/text.js"

const identity = (uid: number, privileged = false, groups: ReadonlyArray<number> = []) => ({
  uid,
  gid: uid,
  groups,
  privileged
})

// A clock whose wall time is `now`; monotonic time and sleeping stay with `original`.
const wallClock = (original: Clock.Clock, now: () => bigint): Clock.Clock => ({
  currentTimeMillisUnsafe: () => Number(now() / 1_000_000n),
  currentTimeMillis: Effect.sync(() => Number(now() / 1_000_000n)),
  currentTimeNanosUnsafe: now,
  currentTimeNanos: Effect.sync(now),
  monotonicTimeNanosUnsafe: () => original.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: original.monotonicTimeNanos,
  sleep: (duration) => original.sleep(duration)
})

describe("directory volumes", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should share one namespace while isolating separate executions when callers belong to the same or different volume execution",
      () =>
        Effect.gen(function*() {
          const construct = Vfs.make()
          const volume = yield* construct
          const other = yield* construct
          const alice = yield* volume.caller()
          const bob = yield* volume.caller()
          yield* alice.mkdir("/work")
          assert.strictEqual((yield* alice.stat("/work")).ino, (yield* bob.stat("/work")).ino)
          assert.strictEqual((yield* Effect.flip((yield* other.caller()).stat("/work"))).code, "NotFound")
          assert.strictEqual((yield* Effect.flip(bob.stat("/tmp"))).code, "NotFound")
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should initialize directory metadata and update the parent link count when a directory is created",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          const root = yield* caller.stat("/")
          assert.deepStrictEqual([root.uid, root.gid, root.mode, root.size, root.nlink], [0, 0, 0o755, 0n, 2])
          yield* caller.mkdir("/work", { mode: 0o7777 })
          const work = yield* caller.stat("/work")
          assert.deepStrictEqual([work.uid, work.gid, work.mode, work.size, work.nlink], [12, 0, 0o1750, 0n, 2])
          assert.strictEqual((yield* caller.stat("/")).nlink, 3)
        }).pipe(Effect.provide(Testing.layer({ caller: { identity: identity(12, true), umask: 0o027 } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should check owner permissions without falling through when the owner lacks access",
      () =>
        Effect.gen(function*() {
          const admin = yield* Vfs.Caller
          yield* admin.mkdir("/locked", { mode: 0o007 })
          const unprivilegedRoot = yield* Testing.callerAs(identity(0))
          assert.strictEqual((yield* Effect.flip(unprivilegedRoot.mkdir("/locked/child"))).code, "AccessDenied")
          const privileged = yield* Testing.callerAs(identity(91, true))
          yield* privileged.mkdir("/locked/child")
          assert.strictEqual((yield* privileged.stat("/locked/child")).uid, 91)
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should use each caller's captured supplementary groups when permissions are checked",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const admin = yield* Vfs.Caller
          yield* admin.mkdir("/shared", { mode: 0o070 })
          const groups = [99]
          const construct = volume.caller({ identity: identity(42, false, groups) })
          groups[0] = 0
          const allowed = yield* construct
          groups[0] = 99
          const denied = yield* construct
          yield* allowed.mkdir("/shared/child")
          assert.strictEqual((yield* Effect.flip(denied.stat("/shared/child"))).code, "AccessDenied")
        }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should keep root and child callers alive when a parent derived scope closes",
      () =>
        Effect.gen(function*() {
          const root = yield* Vfs.Caller
          yield* root.mkdir("/work")
          const parentScope = yield* Scope.make()
          const parent = yield* root.withDirectory("/work").pipe(Scope.provide(parentScope))
          const child = yield* parent.withDirectory(".")
          const pending = parent.stat(".")
          yield* Scope.close(parentScope, Exit.void)
          assert.strictEqual((yield* Effect.flip(pending)).code, "ClosedCaller")
          assert.strictEqual((yield* child.stat(".")).ino, (yield* root.stat("/work")).ino)
          assert.strictEqual((yield* root.stat(".")).ino, (yield* root.stat("/")).ino)
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should ignore unused bases and reject relevant foreign or closed bases when resolving a target",
      () =>
        Effect.gen(function*() {
          const a = yield* Vfs.Caller
          const b = yield* (yield* Vfs.make()).caller()
          const base = yield* b.openDirectory("/")
          yield* base.close
          yield* a.mkdir(Vfs.Target.Path({ path: "/ok", relativeTo: base }))
          assert.strictEqual(
            (yield* Effect.flip(a.stat(Vfs.Target.Path({ path: "ok", relativeTo: base })))).code,
            "ForeignHandle"
          )
          const own = yield* a.openDirectory("/")
          yield* own.close
          assert.strictEqual(
            (yield* Effect.flip(a.stat(Vfs.Target.Path({ path: "ok", relativeTo: own })))).code,
            "InvalidHandle"
          )
          assert.strictEqual((yield* Effect.flip(own.close)).code, "InvalidHandle")
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should retain the invoking caller's privilege when a directory base was opened by another caller",
      () =>
        Effect.gen(function*() {
          const admin = yield* Vfs.Caller
          yield* admin.mkdir("/private", { mode: 0o700 })
          const base = yield* admin.openDirectory("/private")
          const guest = yield* Testing.callerAs(identity(123))
          assert.strictEqual(
            (yield* Effect.flip(guest.stat(Vfs.Target.Path({ path: ".", relativeTo: base })))).code,
            "AccessDenied"
          )
          assert.strictEqual((yield* guest.stat("/private")).mode, 0o700)
          assert.strictEqual((yield* Effect.flip(guest.openDirectory("/private"))).code, "AccessDenied")
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should retain byte names and own exported buffers when a caller passes or receives byte paths",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          const input = new Uint8Array([47, 254])
          const capture = Vfs.pathFromBytes(input)
          input[1] = 255
          const path = yield* capture
          input[1] = 253
          yield* caller.mkdir(path)
          const exported = yield* Vfs.pathToBytes(path)
          assert.deepStrictEqual(exported, new Uint8Array([47, 255]))
          exported[1] = 1
          assert.deepStrictEqual(yield* Vfs.pathToBytes(path), new Uint8Array([47, 255]))
          yield* caller.mkdir(yield* Vfs.pathFromBytes(new Uint8Array([47, 254])))
          assert.notStrictEqual(
            (yield* caller.stat(path)).ino,
            (yield* caller.stat(yield* Vfs.pathFromBytes(new Uint8Array([47, 254])))).ino
          )
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should apply path byte limits before normalization when the volume is opened",
      () =>
        Effect.gen(function*() {
          const limited = yield* Vfs.Caller
          const unlimited = yield* (yield* Vfs.make()).caller()
          const path = yield* Vfs.pathFromBytes(new TextEncoder().encode("/é"))
          yield* limited.mkdir(path)
          assert.strictEqual((yield* Effect.flip(limited.stat("//é"))).code, "PathTooLong")
          yield* unlimited.mkdir("longer")
          const longer = yield* Vfs.pathFromBytes(new TextEncoder().encode("longer"))
          yield* unlimited.stat(longer)
          assert.strictEqual((yield* Effect.flip(limited.stat(longer))).code, "PathTooLong")
        }).pipe(Effect.provide(Testing.layer({ volume: { maxPathBytes: ByteSize.bytes(3) } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should preserve root charge and parent metadata when a quota rejects creation",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          const before = yield* caller.stat("/")
          assert.strictEqual((yield* Effect.flip(caller.mkdir("/child"))).code, "NoSpace")
          assert.deepStrictEqual(yield* caller.stat("/"), before)
          assert.strictEqual((yield* Effect.flip(caller.stat("/child"))).code, "NotFound")
        }).pipe(Effect.provide(Testing.layer({ volume: { maxEntries: 0 } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should provide the volume and root caller when their service layers are constructed",
      () =>
        Effect.gen(function*() {
          const read = Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("work")

            return (yield* fs.stat("work")).kind
          })

          // Each layer call is a fresh volume, so both reads create their own "work".
          const first = yield* read.pipe(Effect.provide(Vfs.Caller.layer().pipe(Layer.provide(Vfs.Volume.layer()))))
          const second = yield* read.pipe(Effect.provide(Vfs.Caller.layer().pipe(Layer.provide(Vfs.Volume.layer()))))

          assert.deepStrictEqual([first, second], ["directory", "directory"])

          // A caller supplied by value keeps its own volume.
          const caller = yield* (yield* Vfs.make()).caller()
          yield* caller.mkdir("/own")

          const direct = yield* Effect.map(Vfs.Caller, (fs) => fs.stat("/own")).pipe(
            Effect.flatten,
            Effect.provideService(Vfs.Caller, caller)
          )

          assert.strictEqual(direct.kind, "directory")
        })
    )
  })
})

describe("input and mutation boundaries", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should name invalid fields and capture options lazily when volume construction runs",
      () =>
        Effect.gen(function*() {
          for (const maxEntries of [-1, 1.5, Infinity, NaN]) {
            const error = yield* Effect.flip(Vfs.make({ maxEntries }))

            if (Predicate.isTagged(error, "PlatformError")) return yield* Effect.die(error)
            assert.strictEqual(error.field, "maxEntries")
          }

          for (const maxPathBytes of [0, -1, 1.5, Infinity]) {
            // @ts-expect-error exercises runtime rejection outside the public ByteSize contract
            const error = yield* Effect.flip(Vfs.make({ maxPathBytes }))

            if (Predicate.isTagged(error, "PlatformError")) return yield* Effect.die(error)
            assert.strictEqual(error.field, "maxPathBytes")
          }

          const pathError = yield* Effect.flip(Vfs.make({ maxPathBytes: ByteSize.zero }))

          if (Predicate.isTagged(pathError, "PlatformError")) return yield* Effect.die(pathError)
          assert.strictEqual(pathError.field, "maxPathBytes")
          const fileError = yield* Effect.flip(Vfs.make({ maxFileBytes: ByteSize.bytes(0x1_0000_0000) }))

          if (Predicate.isTagged(fileError, "PlatformError")) return yield* Effect.die(fileError)
          assert.strictEqual(
            fileError.field,
            "maxFileBytes"
          )
          yield* Vfs.make({ maxBytes: ByteSize.bytes(BigInt(Number.MAX_SAFE_INTEGER) + 1n) })
          const options = { maxEntries: 0 }
          const construct = Vfs.make(options)
          options.maxEntries = 1
          const volume = yield* construct
          options.maxEntries = 0
          const caller = yield* volume.caller()
          yield* caller.mkdir("first")
          assert.strictEqual((yield* Effect.flip(caller.mkdir("second"))).code, "NoSpace")
          const umaskError = yield* Effect.flip(volume.caller({ umask: 0o1000 }))
          const identityError = yield* Effect.flip(volume.caller({ identity: identity(-1) }))

          assert.strictEqual(umaskError._tag, "VfsError")
          assert.strictEqual(identityError._tag, "VfsError")

          if (
            Predicate.isTagged("VfsError")(umaskError) &&
            Predicate.isTagged("VfsError")(identityError)
          ) {
            assert.strictEqual(umaskError.field, "umask")
            assert.strictEqual(identityError.field, "identity")
          }
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should reject malformed paths and modes without changing the namespace when a caller supplies invalid arguments",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          const before = yield* caller.stat("/")

          for (
            const [path, code] of [["", "NotFound"], ["a\0b", "InvalidArgument"], ["\ud800", "InvalidPathEncoding"], [
              "a\udc00",
              "InvalidPathEncoding"
            ], ["\ud800a", "InvalidPathEncoding"]] as const
          ) {
            const error = yield* Effect.flip(caller.mkdir(path))
            assert.strictEqual(error.code, code)
            assert.strictEqual(error.operation, "mkdir")
            // An unencodable string names its replacement encoding; an empty path or one holding a NUL names none,
            // since no BytePath could hold it.
            assert.strictEqual(
              yield* pathText(error.path),
              path === "" || path.includes("\0") ? undefined : new TextDecoder().decode(new TextEncoder().encode(path))
            )
          }

          for (const mode of [-1, 0o10000, 0.5, Infinity]) {
            assert.strictEqual((yield* Effect.flip(caller.mkdir("bad", { mode }))).code, "InvalidArgument")
          }

          assert.deepStrictEqual(yield* caller.stat("/"), before)
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should reject shared and detached views while copying subarrays when file bytes are supplied",
      () =>
        Effect.gen(function*() {
          const shared = new Uint8Array(new SharedArrayBuffer(2))
          shared.set([47, 97])
          assert.strictEqual((yield* Effect.flip(Vfs.pathFromBytes(shared))).code, "InvalidArgument")
          const detached = new Uint8Array([47, 98])
          structuredClone(detached.buffer, { transfer: [detached.buffer] })
          assert.strictEqual((yield* Effect.flip(Vfs.pathFromBytes(detached))).code, "InvalidArgument")

          for (const input of [new Uint8Array(), new Uint8Array([47, 0])]) {
            assert.strictEqual((yield* Effect.flip(Vfs.pathFromBytes(input))).code, "InvalidArgument")
          }

          const input = new Uint8Array([0, 47, 97, 0])
          const path = yield* Vfs.pathFromBytes(input.subarray(1, 3))
          input[2] = 98
          assert.deepStrictEqual(yield* Vfs.pathToBytes(path), new Uint8Array([47, 97]))
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should preserve literal names and resolve dot components when a path traverses existing directories",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller

          for (const name of ["work", "back\\slash", "%2f", "é", "e\u0301", "line\nfeed", "😀"]) {
            yield* caller.mkdir(name)
          }

          const work = yield* caller.stat("work")

          for (const path of ["/../work", "//work", "///work/", "./work", "/work/../work"]) {
            assert.strictEqual((yield* caller.stat(path)).ino, work.ino)
          }

          assert.notStrictEqual((yield* caller.stat("é")).ino, (yield* caller.stat("e\u0301")).ino)
          assert.strictEqual((yield* Effect.flip(caller.stat("/missing/../work"))).code, "NotFound")
          yield* caller.mkdir("/work/child/")
          const relative = yield* caller.withDirectory("work")
          assert.strictEqual((yield* relative.stat("child")).ino, (yield* caller.stat("/work/child")).ino)

          for (const path of ["/", ".", "/work/..", "/work/.", "/work/"]) {
            assert.strictEqual((yield* Effect.flip(caller.mkdir(path))).code, "AlreadyExists")
          }
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should use byte component boundaries and accept long paths when no total bound is configured",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          yield* caller.mkdir("a".repeat(255))
          yield* caller.mkdir("é".repeat(127))

          for (const path of ["a".repeat(256), "é".repeat(128)]) {
            assert.strictEqual((yield* Effect.flip(caller.mkdir(path))).code, "PathTooLong")
          }

          let path = ""

          for (let index = 0; index < 20; index++) {
            path += "/" + "x".repeat(250)
            yield* caller.mkdir(path)
          }

          assert.isAbove(new TextEncoder().encode(path).length, 4096)
          const base = yield* caller.withDirectory(path)
          assert.strictEqual((yield* base.stat(".")).ino, (yield* caller.stat(path)).ino)
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should leave parents and metadata unchanged when duplicate creation fails",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          const before = yield* caller.stat("/")
          assert.strictEqual((yield* Effect.flip(caller.mkdir("/missing/child"))).code, "NotFound")
          assert.deepStrictEqual(yield* caller.stat("/"), before)
          yield* caller.mkdir("/one")
          const after = yield* caller.stat("/")
          assert.strictEqual((yield* Effect.flip(caller.mkdir("/one"))).code, "AlreadyExists")
          assert.deepStrictEqual(yield* caller.stat("/"), after)
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should serialize creation and quota accounting when callers create entries concurrently",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller

          const results = yield* Effect.forEach([caller.mkdir("/same"), caller.mkdir("/same")], Effect.result, {
            concurrency: "unbounded"
          })

          assert.strictEqual(results.filter(Result.isSuccess).length, 1)
          assert.deepStrictEqual(results.filter(Result.isFailure).map((result) => result.failure.code), [
            "AlreadyExists"
          ])
          assert.strictEqual((yield* caller.stat("/")).nlink, 3)
          assert.strictEqual((yield* Effect.flip(caller.mkdir("/another"))).code, "NoSpace")
        }).pipe(Effect.provide(Testing.layer({ volume: { maxEntries: 1 } })))
    )
  })
})

describe("authority, time, and resource lifetime", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should require parent write and search but not read when resolving or creating a child",
      () =>
        Effect.gen(function*() {
          const owner = yield* Vfs.Caller
          yield* owner.mkdir("/work", { mode: 0o300 })
          yield* owner.mkdir("/work/public", { mode: 0o777 })
          const sameUser = yield* Testing.callerAs(identity(7))
          yield* sameUser.mkdir("/work/new")
          const guest = yield* Testing.callerAs(identity(9))
          assert.strictEqual((yield* Effect.flip(guest.stat("/work/public"))).code, "AccessDenied")
          assert.strictEqual((yield* Effect.flip(guest.mkdir("/new-root-entry"))).code, "AccessDenied")
        }).pipe(Effect.provide(Testing.layer({ caller: { identity: identity(7, true), umask: 0 } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should publish related timestamps from one clock reading when an entry changes",
      () =>
        Effect.gen(function*() {
          const original = yield* Clock.clockWith(Effect.succeed)
          let time = 10n
          let samples = 0

          const clock = wallClock(original, () => {
            samples += 1

            return time
          })

          const volume = yield* Vfs.make().pipe(Effect.provideService(Clock.Clock, clock))
          const caller = yield* volume.caller()
          const initialSamples = samples
          time = 20n
          yield* caller.mkdir("/work")
          const metadata = yield* caller.stat("/work")
          assert.deepStrictEqual([metadata.atimeNs, metadata.mtimeNs, metadata.ctimeNs, metadata.birthtimeNs], [
            20n,
            20n,
            20n,
            20n
          ])
          const root = yield* caller.stat("/")
          assert.deepStrictEqual([root.atimeNs, root.mtimeNs, root.ctimeNs, root.birthtimeNs], [10n, 20n, 20n, 10n])
          assert.strictEqual(samples, initialSamples + 1)
          time = -5n
          yield* caller.mkdir("/other")
          assert.strictEqual((yield* caller.stat("/")).mtimeNs, -5n)
          assert.strictEqual((yield* Effect.flip(caller.mkdir("/other"))).code, "AlreadyExists")
          const handle = yield* caller.openDirectory("/work")
          yield* handle.stat
          yield* handle.close
          assert.strictEqual(samples, initialSamples + 2)
          Object.assign(metadata, { uid: 999, nlink: 999 })
          assert.strictEqual((yield* caller.stat("/work")).uid, 0)
          assert.strictEqual((yield* caller.stat("/work")).nlink, 2)
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should keep separately scoped handles alive when their originating caller closes",
      () =>
        Effect.gen(function*() {
          const root = yield* Vfs.Caller
          yield* root.mkdir("/work")
          const scope = yield* Scope.make()
          const caller = yield* root.withDirectory("/work").pipe(Scope.provide(scope))
          const handle = yield* caller.openDirectory(".")
          yield* Scope.close(scope, Exit.void)
          assert.strictEqual((yield* handle.stat).ino, (yield* root.stat("/work")).ino)
          assert.strictEqual(
            (yield* Effect.flip(caller.stat(Vfs.Target.Path({ path: "/work", relativeTo: handle })))).code,
            "ClosedCaller"
          )
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should release a handle once when its scope closes after explicit close",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          const scope = yield* Scope.make()
          const handle = yield* caller.openDirectory("/").pipe(Scope.provide(scope))
          yield* Scope.close(scope, Exit.void)
          assert.strictEqual((yield* Effect.flip(handle.stat)).code, "InvalidHandle")

          const early = yield* Effect.scoped(Effect.gen(function*() {
            const handle = yield* caller.openDirectory("/")
            yield* handle.close

            return handle
          }))

          assert.strictEqual((yield* Effect.flip(early.close)).code, "InvalidHandle")
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should leave no entry when interruption arrives before mutation starts",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          const ready = yield* Deferred.make<void>()
          const proceed = yield* Deferred.make<void>()

          const worker = yield* Effect.gen(function*() {
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(proceed)
            yield* caller.mkdir("/cancelled")
          }).pipe(Effect.forkChild)

          yield* Deferred.await(ready)
          yield* Fiber.interrupt(worker)
          assert.strictEqual((yield* Effect.flip(caller.stat("/cancelled"))).code, "NotFound")
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should release resources without undoing committed directories when interruption arrives during creation",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          const acquired = yield* Deferred.make<Vfs.DirectoryHandle>()

          const worker = yield* Effect.scoped(Effect.gen(function*() {
            yield* caller.mkdir("/committed")
            const handle = yield* caller.openDirectory("/committed")
            yield* Deferred.succeed(acquired, handle)

            return yield* Effect.never
          })).pipe(Effect.forkChild)

          const handle = yield* Deferred.await(acquired)
          yield* Fiber.interrupt(worker)
          yield* caller.stat("/committed")
          assert.strictEqual((yield* Effect.flip(handle.stat)).code, "InvalidHandle")
        }).pipe(Effect.provide(Testing.layer()))
    )
  })
})

describe("scope and close races", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should not retain a directory or deadlock when the acquisition scope is already closed",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          const scope = yield* Scope.make()
          yield* Scope.close(scope, Exit.void)
          const result = yield* caller.openDirectory("/").pipe(Scope.provide(scope), Effect.exit)
          assert.isTrue(Exit.isFailure(result))

          if (Exit.isFailure(result)) assert.isTrue(Cause.hasInterruptsOnly(result.cause))
          yield* caller.mkdir("/after")
          assert.strictEqual((yield* caller.stat("/")).nlink, 3)
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should avoid returning an escaped live reference when scope closure races acquisition",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller

          for (let attempt = 0; attempt < 10; attempt++) {
            const scope = yield* Scope.make()

            const [acquisition] = yield* Effect.all([
              caller.openDirectory("/").pipe(Scope.provide(scope), Effect.exit),
              Scope.close(scope, Exit.void)
            ], { concurrency: "unbounded" })

            if (Exit.isSuccess(acquisition)) {
              assert.strictEqual((yield* Effect.flip(acquisition.value.stat)).code, "InvalidHandle")
            } else {
              assert.isTrue(Cause.hasInterruptsOnly(acquisition.cause))
            }
          }

          yield* caller.mkdir("/still-usable")
        }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 64), Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should order observation and explicit close when both occur concurrently",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          const handle = yield* caller.openDirectory("/")

          const [observation] = yield* Effect.all([
            handle.stat.pipe(Effect.result),
            handle.close
          ], { concurrency: "unbounded" })

          if (Result.isFailure(observation)) assert.strictEqual(observation.failure.code, "InvalidHandle")
          else assert.strictEqual(observation.success.ino, (yield* caller.stat("/")).ino)
          assert.strictEqual((yield* Effect.flip(handle.stat)).code, "InvalidHandle")
        }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 64), Effect.provide(Testing.layer()))
    )
  })
})

const traced = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const spans: Array<Tracer.NativeSpan> = []

  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)

      return span
    }
  })

  return effect.pipe(
    Effect.withTracer(tracer),
    Effect.map((value) => ({ value, names: spans.map((span) => span.name) }))
  )
}

describe("public tracing boundaries", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should leave tracing to the application when snapshot deltas are diffed inspected or applied",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.make()
          const snapshot = yield* volume.snapshot

          const diff = yield* traced(Vfs.diffSnapshots(snapshot, snapshot))
          const inspect = yield* traced(Vfs.inspectSnapshotDelta(snapshot, diff.value))
          const apply = yield* traced(Vfs.applySnapshotDelta(snapshot, diff.value))

          assert.deepStrictEqual(diff.names, [])
          assert.deepStrictEqual(inspect.names, [])
          assert.deepStrictEqual(apply.names, [])
        }).pipe(Effect.provide(BunCrypto.layer))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should retain an application span without adding package spans when a volume is created",
      () =>
        Effect.gen(function*() {
          const result = yield* traced(Vfs.make().pipe(Effect.withSpan("application.openVolume")))

          assert.deepStrictEqual(result.names, ["application.openVolume"])
        })
    )
  })
})

describe("links and byte namespace", () => {
  describe("links and byte namespace", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should preserve hard-link identity and charge content once when renaming over a link",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            const f = yield* fs.open("/a", { access: "readWrite", create: "exclusive" })
            yield* f.write(new Uint8Array([1, 2, 3]))
            yield* fs.link("/a", "/b")
            assert.strictEqual((yield* fs.stat("/b")).ino, (yield* f.stat).ino)
            assert.strictEqual((yield* f.stat).nlink, 2)
            yield* fs.rename("/a", "/b")
            assert.strictEqual((yield* f.stat).nlink, 2)
            yield* fs.unlink("/a")
            yield* fs.rename("/b", "/c")
            assert.strictEqual((yield* f.stat).nlink, 1)
            const empty = yield* fs.open("/empty", { access: "write", create: "exclusive" })
            yield* fs.rename("/empty", "/c")
            assert.strictEqual((yield* f.stat).nlink, 0)
            assert.strictEqual((yield* Effect.flip(empty.write(new Uint8Array([4])))).code, "NoSpace")
            yield* f.close
            yield* empty.write(new Uint8Array([4]))
          }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(3) } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should resolve relative symlinks before dot-dot when creating through dangling links",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/a")
            yield* fs.mkdir("/b")
            yield* fs.mkdir("/b/deep")
            yield* fs.symlink("../b/deep", "/a/link")
            assert.strictEqual(yield* pathText(yield* fs.realPath("/a/link/..")), "/b")
            yield* fs.symlink("missing", "/b/dangling")
            const f = yield* fs.open("/b/dangling", { access: "write", create: "ifMissing" })
            yield* f.write(new Uint8Array([9]))
            assert.strictEqual((yield* fs.stat("/b/missing")).ino, (yield* f.stat).ino)
            assert.strictEqual(
              (yield* fs.stat(Vfs.Target.Path({ path: "/b/dangling", followFinalSymlink: false }))).kind,
              "symlink"
            )
            assert.strictEqual(
              (yield* Effect.flip(
                fs.open(Vfs.Target.Path({ path: "/b/dangling", followFinalSymlink: false }), { access: "read" })
              )).code,
              "SymlinkLoop"
            )
            assert.strictEqual(
              (yield* Effect.flip(fs.open("/b/dangling", { access: "write", create: "exclusive" }))).code,
              "AlreadyExists"
            )
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should leave symlink targets unchanged when final links are renamed or unlinked",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/target")
            yield* fs.symlink("/target", "/alias")
            yield* fs.rename("/alias", "/renamed")
            assert.strictEqual(text(yield* fs.readLink("/renamed")), "/target")
            assert.strictEqual((yield* Effect.flip(fs.rmdir("/renamed"))).code, "NotDirectory")
            yield* fs.link("/renamed", "/alias")
            assert.strictEqual(
              (yield* fs.stat(Vfs.Target.Path({ path: "/alias", followFinalSymlink: false }))).ino,
              (yield* fs.stat(Vfs.Target.Path({ path: "/renamed", followFinalSymlink: false }))).ino
            )
            yield* fs.unlink("/renamed")
            yield* fs.unlink("/alias")
            yield* fs.stat("/target")
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should return the link target when readLink receives a following target",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
            yield* fs.symlink("/file", "/link")

            const following = Vfs.Target.Path({ path: "/link", followFinalSymlink: true })

            assert.strictEqual(text(yield* fs.readLink(following)), "/file")
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should preserve the namespace when symlink traversal or expansion exceeds limits",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/longname")
            yield* fs.symlink("/longname", "/a")
            assert.strictEqual((yield* Effect.flip(fs.stat("/a/////x"))).code, "PathTooLong")
            assert.strictEqual((yield* Effect.flip(fs.mkdir("/a/////x"))).code, "PathTooLong")
            yield* fs.symlink("/loop", "/loop")
            assert.strictEqual((yield* Effect.flip(fs.stat("/loop"))).code, "SymlinkLoop")
            assert.strictEqual(
              (yield* Effect.flip(fs.open("/loop", { access: "write", create: "ifMissing" }))).code,
              "SymlinkLoop"
            )
            assert.deepStrictEqual([...(entryNames(yield* fs.readDirectory("/")))].sort(), ["a", "longname", "loop"])
          }).pipe(Effect.provide(Testing.layer({ volume: { maxPathBytes: ByteSize.bytes(12) } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should preserve raw symlink targets when path limits apply only during traversal",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            const target = "x".repeat(300)
            yield* fs.symlink(target, "/raw")
            assert.strictEqual(text(yield* fs.readLink("/raw")), target)
            assert.strictEqual((yield* Effect.flip(fs.stat("/raw"))).code, "PathTooLong")
            yield* fs.symlink("", "/empty")
            assert.strictEqual(text(yield* fs.readLink("/empty")), "")
            assert.strictEqual((yield* Effect.flip(fs.stat("/empty"))).code, "NotFound")
            yield* fs.mkdir("/x")
            assert.strictEqual((yield* Effect.flip(fs.stat("/empty/x"))).code, "NotFound")
          }).pipe(Effect.provide(Testing.layer({ volume: { maxPathBytes: ByteSize.bytes(12) } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should return independent name bytes when a caller mutates a listed name",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            const path = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))
            yield* fs.mkdir(path)
            const names = rawEntryNames(yield* fs.readDirectory("/"))
            assert.deepStrictEqual(names, [new Uint8Array([255])])
            const first = names[0]
            assert.isDefined(first)
            first[0] = 1
            assert.deepStrictEqual(rawEntryNames(yield* fs.readDirectory("/")), [new Uint8Array([255])])
            assert.deepStrictEqual(yield* Vfs.pathToBytes(yield* fs.realPath(path)), new Uint8Array([47, 255]))
            yield* fs.symlink(path, "/alias")
            assert.deepStrictEqual(yield* fs.readLink("/alias"), new Uint8Array([47, 255]))
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should name the traversed path when symlink expansion breaks a limit",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.symlink("a".repeat(300), "/link")

            const failed = yield* Effect.flip(fs.readFile("/link"))

            assert.strictEqual(failed.code, "PathTooLong")
            assert.strictEqual(yield* pathText(failed.path), "/link")
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should return the chosen name when realPath traverses a hard link", () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          yield* fs.writeFile("/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })
          yield* fs.link("/f", "/alias")
          assert.strictEqual(yield* pathText(yield* fs.realPath("/alias")), "/alias")
          assert.strictEqual(yield* pathText(yield* fs.realPath("/f")), "/f")
          yield* fs.rename("/f", "/g")
          assert.strictEqual(yield* pathText(yield* fs.realPath("/alias")), "/alias")
          assert.strictEqual(yield* pathText(yield* fs.realPath("/g")), "/g")
          assert.strictEqual((yield* Effect.flip(fs.realPath("/f"))).code, "NotFound")
        }).pipe(Effect.provide(Testing.layer())))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should return the new path when a handle-relative directory moves", () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          yield* fs.mkdir("/old")
          yield* fs.mkdir("/old/work")
          const handle = yield* fs.openDirectory("/old/work")
          assert.strictEqual(
            yield* pathText(yield* fs.realPath(Vfs.Target.Path({ path: ".", relativeTo: handle }))),
            "/old/work"
          )
          yield* fs.rename("/old", "/new")
          assert.strictEqual(
            yield* pathText(yield* fs.realPath(Vfs.Target.Path({ path: ".", relativeTo: handle }))),
            "/new/work"
          )
          yield* fs.writeFile(Vfs.Target.Path({ path: "x", relativeTo: handle }), new Uint8Array([1]), {
            access: "write",
            create: "ifMissing"
          })
          assert.strictEqual(
            yield* pathText(yield* fs.realPath(Vfs.Target.Path({ path: "x", relativeTo: handle }))),
            "/new/work/x"
          )
          assert.strictEqual((yield* fs.stat("/new/work/x")).kind, "file")
        }).pipe(Effect.provide(Testing.layer())))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should report NotFound when realPath uses a removed directory handle",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/gone")
            const handle = yield* fs.openDirectory("/gone")
            assert.strictEqual(
              yield* pathText(yield* fs.realPath(Vfs.Target.Path({ path: ".", relativeTo: handle }))),
              "/gone"
            )
            yield* fs.rmdir("/gone")
            assert.strictEqual(
              (yield* Effect.flip(fs.realPath(Vfs.Target.Path({ path: ".", relativeTo: handle })))).code,
              "NotFound"
            )
          }).pipe(Effect.provide(Testing.layer()))
      )
    })
  })
})

describe("recursive directory creation", () => {
  describe("mkdir recursive", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should create missing directories with ordered events, modes, and final times when parents are absent",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            const volume = yield* Vfs.Volume
            yield* fs.mkdir("/a")
            const changes = yield* Testing.collectChanges(yield* volume.watch(), 3)

            const result = yield* fs.mkdir("/a/b/c/d", {
              ...RECURSIVE,
              mode: 0o777,
              times: { access: { kind: "value", nanoseconds: 5n }, modification: { kind: "value", nanoseconds: 7n } }
            })

            const events = yield* changes

            assert.deepStrictEqual(
              yield* Effect.forEach(
                events,
                (change) => Effect.map(pathText(change.path), (path) => `${change._tag} ${path}`)
              ),
              ["Create /a/b", "Create /a/b/c", "Create /a/b/c/d"]
            )
            assert.strictEqual(result.reference, yield* fs.lookup("/a/b/c/d"))
            assert.strictEqual(result.directory.after, (yield* fs.stat("/a/b/c")).revision)
            const parent = yield* fs.stat("/a/b/c")
            const leaf = yield* fs.stat("/a/b/c/d")
            assert.deepStrictEqual([parent.mode & 0o777, leaf.mode & 0o777], [0o755, 0o755])
            assert.deepStrictEqual([leaf.atimeNs, leaf.mtimeNs], [5n, 7n])
            assert.notStrictEqual(parent.mtimeNs, 7n)
          }).pipe(Effect.scoped, Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should create nothing when a later recursive mkdir component fails", () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller

          // The third directory is past the volume's entry limit.
          const error = yield* Effect.flip(fs.mkdir("/x/y/z", RECURSIVE))

          assert.deepStrictEqual(yield* failure(error), ["NoSpace", "/x/y/z"])
          assert.isFalse(yield* exists(fs, "/x"))
        }).pipe(Effect.provide(Testing.layer({ volume: { maxEntries: 2 } }))))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should create nothing when the caller cannot search a new directory",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/work", { mode: 0o777 })
            yield* fs.chown("/work", { uid: GUEST.uid, gid: GUEST.gid })
            const guest = yield* Testing.callerAs(GUEST)

            const error = yield* Effect.flip(guest.mkdir("/work/sealed/inner", { recursive: true, mode: 0o600 }))

            assert.deepStrictEqual(yield* failure(error), ["AccessDenied", "/work/sealed/inner"])
            assert.isFalse(yield* exists(fs, "/work/sealed"))

            // The final directory is never searched, so its mode may lack owner search.
            yield* guest.mkdir("/work/sealed", { recursive: true, mode: 0o600 })
            assert.isTrue(yield* exists(fs, "/work/sealed"))
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should make no change when recursive mkdir finds an existing directory",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/a")
            const before = yield* fs.stat("/")

            const result = yield* fs.mkdir("/a", RECURSIVE)

            assert.strictEqual(result.reference, yield* fs.lookup("/a"))
            assert.deepStrictEqual(result.directory, { before: before.revision, after: before.revision })
            assert.strictEqual((yield* fs.stat("/")).revision, before.revision)
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should distinguish final and intermediate files when recursive mkdir encounters them",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.writeFile("/f", new Uint8Array(1), { access: "write", create: "exclusive" })

            assert.deepStrictEqual(yield* failure(yield* Effect.flip(fs.mkdir("/f", RECURSIVE))), [
              "AlreadyExists",
              "/f"
            ])
            assert.deepStrictEqual(
              yield* failure(yield* Effect.flip(fs.mkdir("/f/g", RECURSIVE))),
              ["NotDirectory", "/f/g"]
            )
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should traverse dot components when recursive mkdir receives them", () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller

          yield* fs.mkdir("/a/./b/../c", RECURSIVE)
          yield* fs.mkdir("/a/.", RECURSIVE)
          const before = (yield* fs.stat("/")).revision
          const up = yield* fs.mkdir("/new/..", RECURSIVE)

          assert.deepStrictEqual(
            yield* Effect.forEach(["/a/b", "/a/c", "/new"], (path) => exists(fs, path)),
            [true, true, true]
          )
          // A path that leaves the directory it created names the directory it ends on, and reports the change the
          // call made to that directory's parent.
          assert.strictEqual(up.reference, yield* fs.root)
          assert.deepStrictEqual(up.directory, { before, after: (yield* fs.stat("/")).revision })
          assert.notStrictEqual(up.directory.after, up.directory.before)
        }).pipe(Effect.provide(Testing.layer())))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should create only requested names when an intermediate path is a symlink",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/real")
            yield* fs.symlink("/real", "/link")
            yield* fs.symlink("/nowhere/deeper", "/dangling")

            yield* fs.mkdir("/link/x/y", RECURSIVE)
            assert.isTrue(yield* exists(fs, "/real/x/y"))

            // A link to a directory is an existing directory.
            yield* fs.mkdir("/link", RECURSIVE)

            assert.deepStrictEqual(
              yield* failure(yield* Effect.flip(fs.mkdir("/dangling/x", RECURSIVE))),
              ["NotFound", "/dangling/x"]
            )
            assert.deepStrictEqual(
              yield* failure(yield* Effect.flip(fs.mkdir("/dangling", RECURSIVE))),
              ["NotFound", "/dangling"]
            )
            assert.isFalse(yield* exists(fs, "/nowhere"))
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should resolve relative paths when recursive mkdir starts from the caller directory",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/base")
            const inBase = yield* fs.withDirectory("/base")

            yield* inBase.mkdir("x/y", RECURSIVE)

            assert.isTrue(yield* exists(fs, "/base/x/y"))
          }).pipe(Effect.scoped, Effect.provide(Testing.layer()))
      )
    })
  })
})

describe("recursive removal", () => {
  const present = (fs: Vfs.Caller, paths: ReadonlyArray<string>) => Effect.forEach(paths, (path) => exists(fs, path))

  // A guest-owned /work the guest can write, and a guest caller.
  const guestWork = Effect.gen(function*() {
    const fs = yield* Vfs.Caller
    yield* fs.mkdir("/work")
    yield* fs.chown("/work", { uid: GUEST.uid, gid: GUEST.gid })

    return yield* Testing.callerAs(GUEST)
  })

  describe("remove recursive", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should remove entries before directories with one event each when a nested tree is removed",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            const volume = yield* Vfs.Volume
            yield* fs.mkdir("/t")
            yield* fs.mkdir("/t/a")
            yield* write(fs, "/t/a/x")
            yield* write(fs, "/t/b")
            const changes = yield* Testing.collectChanges(yield* volume.watch(), 4)

            const change = yield* fs.remove("/t", RECURSIVE)
            const events = yield* changes

            assert.deepStrictEqual(
              yield* Effect.forEach(
                events,
                (event) => Effect.map(pathText(event.path), (path) => `${event._tag} ${path}`)
              ),
              ["Remove /t/a/x", "Remove /t/a", "Remove /t/b", "Remove /t"]
            )
            assert.strictEqual(change.after, (yield* fs.stat("/")).revision)
          }).pipe(Effect.scoped, Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should remove a link without touching its target when recursive removal encounters a symbolic link",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/dir")
            yield* write(fs, "/dir/kept")
            yield* fs.symlink("/dir", "/link")
            yield* write(fs, "/file")

            yield* fs.remove("/link", RECURSIVE)
            yield* fs.remove("/file", RECURSIVE)

            assert.deepStrictEqual(yield* present(fs, ["/link", "/file", "/dir/kept"]), [false, false, true])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should stop at the first failure and retain later entries when one entry removal fails",
        () =>
          Effect.gen(function*() {
            const guest = yield* guestWork
            yield* guest.mkdir("/work/t/locked", RECURSIVE)
            yield* write(guest, "/work/t/a")
            yield* write(guest, "/work/t/locked/f")
            yield* write(guest, "/work/t/z")
            // Readable, so the walk lists it, but not writable, so its entry cannot go.
            yield* guest.chmod("/work/t/locked", 0o555)

            const error = yield* Effect.flip(guest.remove("/work/t", RECURSIVE))

            assert.deepStrictEqual(yield* failure(error), ["AccessDenied", "/work/t/locked/f"])
            assert.deepStrictEqual(
              yield* present(guest, ["/work/t/a", "/work/t/locked/f", "/work/t/z"]),
              [false, true, true]
            )
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should refuse a nonempty unreadable directory without changing its mode when recursive removal reaches it",
        () =>
          Effect.gen(function*() {
            const guest = yield* guestWork
            yield* guest.mkdir("/work/t/sealed", RECURSIVE)
            yield* write(guest, "/work/t/sealed/f")
            yield* guest.chmod("/work/t/sealed", 0o000)

            const error = yield* Effect.flip(guest.remove("/work/t", RECURSIVE))

            assert.deepStrictEqual(yield* failure(error), ["AccessDenied", "/work/t/sealed"])
            assert.strictEqual((yield* guest.stat("/work/t/sealed")).mode & 0o777, 0o000)
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should remove an unreadable empty directory when recursive removal reaches it",
        () =>
          Effect.gen(function*() {
            const guest = yield* guestWork
            yield* guest.mkdir("/work/t/sealed", RECURSIVE)
            yield* write(guest, "/work/t/f")
            yield* guest.chmod("/work/t/sealed", 0o000)

            yield* guest.remove("/work/t", RECURSIVE)

            assert.isFalse(yield* exists(guest, "/work/t"))
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should forgive a missing target but report a missing child when force is enabled",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller

            assert.isUndefined(yield* fs.remove("/missing", { force: true }))
            assert.isUndefined(yield* fs.remove("/missing/deeper", { recursive: true, force: true }))

            yield* fs.mkdir("/t")
            yield* fs.mkdir("/t/a")
            yield* write(fs, "/t/a/x")
            yield* write(fs, "/t/b")
            let removals = 0

            // Another caller removes /t/b once the walk has listed /t and before the removal reaches it.
            const beforeTreeRemoval = Effect.suspend(() =>
              ++removals === 1 ? Effect.orDie(fs.unlink("/t/b")) : Effect.void
            )

            const error = yield* Effect.flip(
              fs.remove("/t", { recursive: true, force: true }).pipe(withVolumeTestSeams({ beforeTreeRemoval }))
            )

            assert.deepStrictEqual(yield* failure(error), ["NotFound", "/t/b"])
            assert.deepStrictEqual(yield* present(fs, ["/t", "/t/a"]), [true, false])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should leave a renamed directory untouched when it moves out of the target tree",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/keep")
            yield* fs.mkdir("/work/a/g", RECURSIVE)
            yield* write(fs, "/work/a/f")
            yield* write(fs, "/work/a/g/y")
            yield* fs.mkdir("/work/z")
            yield* write(fs, "/work/z/k")
            let removals = 0

            // Another caller moves /work/z out once the walk has listed /work and before the removal reaches /work/z.
            const beforeTreeRemoval = Effect.suspend(() =>
              ++removals === 1 ? Effect.orDie(fs.rename("/work/z", "/keep/z")) : Effect.void
            )

            const error = yield* Effect.flip(
              fs.remove("/work", RECURSIVE).pipe(withVolumeTestSeams({ beforeTreeRemoval }))
            )

            // The walk reaches /work/z by its name, which no longer names it, so nothing below it is removed.
            assert.deepStrictEqual(yield* failure(error), ["NotFound", "/work/z"])
            assert.deepStrictEqual(yield* present(fs, ["/work/a", "/keep/z/k"]), [false, true])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should report a missing target unless force is enabled when the target is renamed before removal",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller

            for (const force of [false, true]) {
              yield* fs.mkdir("/work/a", RECURSIVE)
              yield* write(fs, "/work/a/f")
              yield* write(fs, "/work/b")
              let removals = 0

              // Another caller moves /work itself once the walk has listed it and before the first removal.
              const beforeTreeRemoval = Effect.suspend(() =>
                ++removals === 1 ? Effect.orDie(fs.rename("/work", "/keep")) : Effect.void
              )

              const removed = yield* Effect.result(
                fs.remove("/work", { recursive: true, force }).pipe(withVolumeTestSeams({ beforeTreeRemoval }))
              )

              const outcome = Result.isSuccess(removed) ? "removed" : yield* failure(removed.failure)

              // The walk reaches every entry through the target's name, which no longer names it, so nothing moves.
              assert.deepStrictEqual(outcome, force ? "removed" : ["NotFound", "/work"])
              assert.deepStrictEqual(yield* present(fs, ["/keep/a/f", "/keep/b"]), [true, true])
              yield* fs.remove("/keep", RECURSIVE)
            }
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should leave a replacement untouched and fail at its name when an entry changes after listing",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/keep")
            yield* fs.mkdir("/work")
            yield* write(fs, "/work/f")
            let removals = 0

            // Another caller moves /work/f out and creates a new /work/f before the removal reaches it.
            const beforeTreeRemoval = Effect.suspend(() =>
              ++removals === 1
                ? Effect.orDie(Effect.andThen(fs.rename("/work/f", "/keep/f"), write(fs, "/work/f")))
                : Effect.void
            )

            const error = yield* Effect.flip(
              fs.remove("/work", RECURSIVE).pipe(withVolumeTestSeams({ beforeTreeRemoval }))
            )

            assert.deepStrictEqual(yield* failure(error), ["NotFound", "/work/f"])
            assert.deepStrictEqual(yield* present(fs, ["/work/f", "/keep/f"]), [true, true])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should name an entry's failure under the entry when the target is an entry",
        () =>
          Effect.gen(function*() {
            const guest = yield* guestWork
            yield* guest.mkdir("/work/t/locked", RECURSIVE)
            yield* write(guest, "/work/t/locked/f")
            yield* guest.chmod("/work/t/locked", 0o555)

            const error = yield* Effect.flip(guest.remove(Vfs.Entry(yield* guest.lookup("/work"), "t"), RECURSIVE))

            assert.deepStrictEqual(yield* failure(error), ["AccessDenied", "t/locked/f"])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should reject malformed options when the target path is unresolved", () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          // SAFETY: the malformed option is the input under test; remove validates it at runtime.
          // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime validation requires an invalid typed input.
          const options = { recursive: "yes" } as unknown as Vfs.RemoveOptions

          assert.deepStrictEqual(
            yield* failure(yield* Effect.flip(fs.remove("/missing", options))),
            ["InvalidArgument", "/missing"]
          )
        }).pipe(Effect.provide(Testing.layer())))
    })
  })
})

describe("metadata mutation", () => {
  const OWNER = { uid: 9, gid: 9, groups: [], privileged: false } as const

  const EXPLICIT_TIMES = {
    access: { kind: "value", nanoseconds: 1n },
    modification: { kind: "value", nanoseconds: 2n }
  } as const

  // A clock that moves forward on every reading, so two readings in one call cannot agree.
  const tickingClock = (): Clock.Clock => {
    let now = 1_000n
    const tick = () => (now += 1_000n)

    return {
      currentTimeMillisUnsafe: () => Number(now / 1_000_000n),
      currentTimeMillis: Effect.sync(() => Number(now / 1_000_000n)),
      currentTimeNanosUnsafe: tick,
      currentTimeNanos: Effect.sync(tick),
      monotonicTimeNanosUnsafe: () => 0n,
      monotonicTimeNanos: Effect.succeed(0n),
      sleep: () => Effect.void
    }
  }

  // A file /f with four bytes, mode 0o644, owned by OWNER.
  const ownedFile = Effect.gen(function*() {
    const fs = yield* Vfs.Caller
    yield* fs.writeFile("/f", new Uint8Array([1, 2, 3, 4]), { access: "write", create: "exclusive", mode: 0o644 })
    yield* fs.chown("/f", { uid: OWNER.uid, gid: OWNER.gid })

    return yield* fs.stat("/f")
  })

  describe("setattr", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should name the first invalid attribute when multiple attributes are invalid",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller

            // SAFETY: the malformed attributes are the input under test; setattr validates them at runtime.
            const malformed = [
              { size: -1n, mode: -1 },
              { mode: 0o10000 },
              { owner: { uid: -1 } },
              { times: { access: { kind: "now" }, modification: { kind: "later" } } },
              { expected: { revision: 1 } },
              { size: 0n, extra: true }
            ] as ReadonlyArray<Vfs.SetattrOptions>

            const fields = yield* Effect.forEach(
              malformed,
              (attributes) =>
                Effect.map(Effect.flip(fs.setattr("/missing", attributes)), (error) => [error.code, error.field])
            )

            assert.deepStrictEqual(fields, [
              ["InvalidArgument", "size"],
              ["InvalidArgument", "mode"],
              ["InvalidArgument", "owner"],
              ["InvalidArgument", "times"],
              ["InvalidArgument", "expected"],
              ["InvalidArgument", "extra"]
            ])
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should return a typed failure when attributes are not an object", () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          yield* ownedFile

          const malformed: ReadonlyArray<unknown> = [null, undefined, 5, "size", [0n]]

          const codes = yield* Effect.forEach(
            malformed,
            (attributes) =>
              // SAFETY: the non-object attributes are the input under test; setattr validates them at runtime.
              Effect.map(Effect.flip(fs.setattr("/f", attributes as Vfs.SetattrOptions)), (error) => error.code)
          )

          assert.deepStrictEqual(codes, Array(malformed.length).fill("InvalidArgument"))
        }).pipe(Effect.provide(Testing.layer())))
    })

    it("should reject the same malformed attributes through the schema when setattr rejects them", () => {
      const is = Schema.is(Vfs.SetattrOptions)

      assert.isFalse(is({ size: -1n }))
      assert.isTrue(is({ size: 0n }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should leave every attribute unapplied when a later check fails", () =>
        Effect.gen(function*() {
          const before = yield* ownedFile
          const owner = yield* Testing.callerAs(OWNER)

          // The size and mode pass their checks; giving the file away does not.
          const error = yield* Effect.flip(owner.setattr("/f", { size: 0n, mode: 0o600, owner: { uid: 0 } }))

          assert.strictEqual(error.code, "NotPermitted")
          assert.strictEqual(yield* pathText(error.path), "/f")
          assert.deepStrictEqual(yield* owner.stat("/f"), before)
          assert.deepStrictEqual(yield* owner.readFile("/f"), new Uint8Array([1, 2, 3, 4]))
        }).pipe(Effect.provide(Testing.layer())))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should leave every attribute unapplied when the resize runs out of space",
        () =>
          Effect.gen(function*() {
            const before = yield* ownedFile
            const fs = yield* Vfs.Caller

            const error = yield* Effect.flip(fs.setattr("/f", { size: 64n, mode: 0o600, times: EXPLICIT_TIMES }))

            assert.strictEqual(error.code, "NoSpace")
            assert.deepStrictEqual(yield* fs.stat("/f"), before)
          }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(16) } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should apply attributes under one revision, clock reading, and event when combined setattr succeeds",
        () =>
          Effect.gen(function*() {
            yield* TestClock.setTime(5)
            yield* ownedFile
            const fs = yield* Vfs.Caller
            const volume = yield* Vfs.Volume
            const earlier = (yield* fs.mkdir("/earlier")).directory.after
            const changes = yield* Testing.collectChanges(yield* volume.watch(), 2)

            yield* fs.setattr("/f", { size: 2n, mode: 0o600, owner: { gid: 0 }, times: EXPLICIT_TIMES })
            const changed = yield* fs.stat("/f")
            const later = (yield* fs.mkdir("/later")).directory.after

            assert.deepStrictEqual(
              [changed.size, changed.mode, changed.gid, changed.atimeNs, changed.mtimeNs, changed.ctimeNs],
              [2n, 0o600, 0, 1n, 2n, 5_000_000n]
            )
            assert.strictEqual(changed.revision, earlier + 1n)
            assert.strictEqual(later, earlier + 2n)

            const seen = yield* Effect.forEach(
              yield* changes,
              (change) => Effect.map(pathText(change.path), (path) => `${change._tag} ${path}`)
            )

            assert.deepStrictEqual(seen, ["Update /f", "Create /later"])
          }).pipe(Effect.scoped, Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should use one clock reading for resize and current times when a combined setattr succeeds",
        () =>
          Effect.gen(function*() {
            yield* ownedFile
            const fs = yield* Vfs.Caller

            yield* fs.setattr("/f", { size: 2n, mode: 0o600 })
            const resized = yield* fs.stat("/f")
            assert.strictEqual(resized.mtimeNs, resized.ctimeNs)

            yield* fs.setattr("/f", { times: { access: { kind: "now" }, modification: { kind: "now" } } })
            const touched = yield* fs.stat("/f")
            assert.isAbove(Number(touched.ctimeNs), Number(resized.ctimeNs))
            assert.deepStrictEqual([touched.atimeNs, touched.mtimeNs], [touched.ctimeNs, touched.ctimeNs])
          }).pipe(Effect.provide(Testing.layer()), Effect.provideService(Clock.Clock, tickingClock()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should keep requested special mode bits when owner and size change in one setattr",
        () =>
          Effect.gen(function*() {
            yield* ownedFile
            const fs = yield* Vfs.Caller

            yield* fs.setattr("/f", { size: 0n, mode: 0o6755, owner: { uid: 0, gid: 0 } })
            assert.strictEqual((yield* fs.stat("/f")).mode, 0o6755)

            // Without a requested mode, the owner change still clears both bits.
            yield* fs.setattr("/f", { owner: { uid: 9 } })
            assert.strictEqual((yield* fs.stat("/f")).mode, 0o755)
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should fail as StaleReference naming expected, applying nothing, when the target moved past the revision",
        () =>
          Effect.gen(function*() {
            const observed = yield* ownedFile
            const fs = yield* Vfs.Caller
            yield* fs.chown("/f", { uid: 2000 })
            const before = yield* fs.stat("/f")

            const error = yield* Effect.flip(
              fs.setattr("/f", { mode: 0o4755, owner: {}, expected: { revision: observed.revision } })
            )

            assert.strictEqual(error.code, "StaleReference")
            assert.strictEqual(error.field, "expected")
            assert.strictEqual(yield* pathText(error.path), "/f")
            assert.deepStrictEqual(yield* fs.stat("/f"), before)

            yield* fs.setattr("/f", { mode: 0o4755, expected: { revision: before.revision } })
            assert.deepInclude(yield* fs.stat("/f"), { mode: 0o4755, revision: before.revision + 1n })
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should leave metadata and revision unchanged when setattr receives no attributes",
        () =>
          Effect.gen(function*() {
            const before = yield* ownedFile
            const fs = yield* Vfs.Caller
            yield* TestClock.adjust(1000)

            yield* fs.setattr("/f", {})
            yield* fs.setattr("/f", { times: { access: { kind: "omit" }, modification: { kind: "omit" } } })

            assert.deepStrictEqual(yield* fs.stat("/f"), before)
          }).pipe(Effect.provide(Testing.layer()))
      )
    })
  })
})

describe("directory namespace", () => {
  describe("directory namespace", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect("should preserve caller and base identity when directories move", () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
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
          assert.strictEqual(
            (yield* fs.stat(Vfs.Target.Path({ path: "child", relativeTo: base }))).ino,
            (yield* cwd.stat("child")).ino
          )
          assert.strictEqual((yield* cwd.stat("..")).ino, (yield* fs.stat("/new")).ino)
          assert.strictEqual((yield* Effect.flip(fs.stat("/old/work/child"))).code, "NotFound")
          assert.strictEqual((yield* fs.stat("/old")).nlink, 3)
          assert.strictEqual((yield* fs.stat("/new")).nlink, 3)
        }).pipe(Effect.provide(Testing.layer())))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should replace empty directories atomically when rename displaces one",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
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
          }).pipe(Effect.provide(Testing.layer({ volume: { maxEntries: 2 } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should preserve trees and metadata when rename rejects a cycle or nonempty target",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
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
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should preserve metadata when renaming an entry to itself at full quota",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/a")
            const root = yield* fs.stat("/")
            const a = yield* fs.stat("/a")
            yield* TestClock.adjust("1 second")
            yield* fs.rename("/a", "//a/")
            assert.deepStrictEqual(yield* fs.stat("/a"), a)
            assert.deepStrictEqual(yield* fs.stat("/"), root)
            yield* fs.rename("/a", "/b")
            assert.strictEqual((yield* fs.stat("/b")).ino, a.ino)
          }).pipe(Effect.provide(Testing.layer({ volume: { maxEntries: 1 } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should validate dot components and roots when renaming to a slashed path",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/a")

            for (const path of ["/a/.", "/a/..", "/"]) {
              assert.strictEqual((yield* Effect.flip(fs.rename(path, "/b"))).code, "InvalidArgument")
              assert.strictEqual((yield* Effect.flip(fs.rename("/a", path))).code, "InvalidArgument")
              assert.strictEqual((yield* Effect.flip(fs.rmdir(path))).code, "InvalidArgument")
            }

            // A directory may move to a missing name with a trailing slash, as on Linux.
            yield* fs.rename("/a", "/b/")
            assert.strictEqual((yield* fs.stat("/b")).kind, "directory")
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should retain handle metadata until close when an empty directory is removed",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/a")
            yield* fs.mkdir("/a/b")
            const base = yield* fs.openDirectory("/a/b")
            assert.strictEqual((yield* Effect.flip(fs.rmdir("/a"))).code, "NotEmpty")
            yield* fs.rmdir("/a/b")
            assert.strictEqual((yield* base.stat).nlink, 0)
            assert.strictEqual(
              (yield* Effect.flip(fs.mkdir(Vfs.Target.Path({ path: "child", relativeTo: base })))).code,
              "NotFound"
            )
            assert.strictEqual((yield* fs.stat("/a")).nlink, 2)
            yield* fs.mkdir("/reuse")
            yield* base.close
            assert.strictEqual((yield* Effect.flip(base.stat)).code, "InvalidHandle")
          }).pipe(Effect.provide(Testing.layer({ volume: { maxEntries: 2 } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should enforce both parent and sticky permissions when the invoking caller renames",
        () =>
          Effect.gen(function*() {
            const admin = yield* Vfs.Caller
            yield* admin.mkdir("/shared", { mode: 0o1777 })
            yield* admin.mkdir("/locked", { mode: 0o755 })
            const alice = yield* Testing.callerAs({ uid: 1, gid: 1, groups: [], privileged: false })
            const bob = yield* Testing.callerAs({ uid: 2, gid: 2, groups: [], privileged: false })
            yield* alice.mkdir("/shared/alice")
            yield* bob.mkdir("/shared/bob")
            assert.strictEqual((yield* Effect.flip(bob.rmdir("/shared/alice"))).code, "NotPermitted")
            assert.strictEqual((yield* Effect.flip(bob.rename("/shared/alice", "/shared/stolen"))).code, "NotPermitted")
            assert.strictEqual((yield* Effect.flip(bob.rename("/shared/bob", "/shared/alice"))).code, "NotPermitted")
            assert.strictEqual(
              (yield* Effect.flip(alice.rename("/shared/alice", "/locked/alice"))).code,
              "AccessDenied"
            )
            yield* alice.rename("/shared/alice", "/shared/renamed")
            yield* alice.rmdir("/shared/renamed")
            yield* admin.rmdir("/shared/bob")
          }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should use separate bases for relative paths and ignore them when paths are absolute",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/a")
            yield* fs.mkdir("/b")
            yield* fs.mkdir("/a/work")
            const a = yield* fs.openDirectory("/a")
            const b = yield* fs.openDirectory("/b")
            yield* fs.rename(
              Vfs.Target.Path({ path: "work", relativeTo: a }),
              Vfs.Target.Path({ path: "moved", relativeTo: b })
            )
            yield* fs.stat("/b/moved")
            const foreign = yield* (yield* (yield* Vfs.make()).caller()).openDirectory("/")
            assert.strictEqual(
              (yield* Effect.flip(fs.rename(Vfs.Target.Path({ path: "moved", relativeTo: foreign }), "/a/work"))).code,
              "ForeignHandle"
            )
            yield* fs.rename(
              Vfs.Target.Path({ path: "/b/moved", relativeTo: foreign }),
              Vfs.Target.Path({ path: "/a/work", relativeTo: foreign })
            )
            yield* a.close
            assert.strictEqual(
              (yield* Effect.flip(fs.rename("/a/work", Vfs.Target.Path({ path: "work", relativeTo: a })))).code,
              "InvalidHandle"
            )
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should publish parent timestamps atomically when renames compete", () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          yield* fs.mkdir("/a")
          yield* fs.mkdir("/b")
          yield* fs.mkdir("/a/work")
          yield* TestClock.adjust("1 second")

          const results = yield* Effect.all([
            Effect.result(fs.rename("/a/work", "/b/first")),
            Effect.result(fs.rename("/a/work", "/b/second"))
          ], { concurrency: "unbounded" })

          assert.strictEqual(results.filter(Predicate.isTagged("Success")).length, 1)
          const a = yield* fs.stat("/a")
          const b = yield* fs.stat("/b")
          assert.strictEqual(a.nlink, 2)
          assert.strictEqual(b.nlink, 3)
          assert.strictEqual(a.mtimeNs, b.mtimeNs)
          assert.strictEqual(a.ctimeNs, b.ctimeNs)
          assert.strictEqual(a.mtimeNs, 1_000_000_000n)
        }).pipe(Effect.provide(Testing.layer())))
    })
  })
})

describe("object references", () => {
  const bytes = (...values: Array<number>) => new Uint8Array(values)

  const name = (value: string) => new TextEncoder().encode(value)

  describe("object references", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect("should preserve object identity when links, names, or paths change", () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          yield* fs.writeFile("/a", bytes(1), { access: "write", create: "exclusive" })
          const root = yield* fs.root
          const original = yield* fs.lookup(Vfs.Entry(root, name("a")))
          yield* fs.link("/a", "/alias")
          assert.strictEqual(yield* fs.lookup(Vfs.Entry(root, name("alias"))), original)
          yield* fs.rename("/a", "/moved")
          yield* fs.writeFile("/a", bytes(2), { access: "write", create: "exclusive" })
          assert.strictEqual(yield* fs.lookup(Vfs.Entry(root, name("moved"))), original)
          assert.notStrictEqual(yield* fs.lookup(Vfs.Entry(root, name("a"))), original)
          const handle = yield* fs.open(original, { access: "read" })
          assert.deepStrictEqual(yield* handle.read(1), bytes(1))
          yield* handle.close
        }).pipe(Effect.provide(Testing.layer())))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should distinguish forged, foreign, and stale references when resolving objects",
        () =>
          Effect.gen(function*() {
            const second = yield* Vfs.make()
            const fs = yield* Vfs.Caller
            const other = yield* second.caller()
            const root = yield* fs.root
            assert.strictEqual((yield* Effect.flip(other.stat(root))).code, "ForeignReference")
            // SAFETY: The forged reference deliberately bypasses the static contract to test runtime authenticity.
            assert.strictEqual(
              (yield* Effect.flip(fs.stat({} as Vfs.ObjectReference))).code,
              "InvalidReference"
            )
            yield* fs.writeFile("/gone", bytes(1), { access: "write", create: "exclusive" })
            const gone = yield* fs.lookup(Vfs.Entry(root, name("gone")))
            yield* fs.unlink("/gone")
            assert.strictEqual((yield* Effect.flip(fs.stat(gone))).code, "StaleReference")
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should keep an unlinked file observable when its existing reader remains open",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.writeFile("/f", bytes(1, 2), { access: "write", create: "exclusive" })
            const root = yield* fs.root
            const reference = yield* fs.lookup(Vfs.Entry(root, name("f")))
            const reader = yield* fs.open(reference, { access: "read" })
            yield* fs.unlink("/f")
            assert.strictEqual((yield* fs.stat(reference)).nlink, 0)
            assert.deepStrictEqual(yield* reader.read(2), bytes(1, 2))
            assert.strictEqual((yield* Effect.flip(fs.open(reference, { access: "read" }))).code, "StaleReference")
            yield* reader.close
            assert.strictEqual((yield* Effect.flip(fs.stat(reference))).code, "StaleReference")
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should retain owned names and targets when reference paths move", () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          yield* fs.mkdir("/left")
          yield* fs.mkdir("/right")
          yield* fs.mkdir("/left/child")
          yield* fs.symlink("target", "/link")
          const root = yield* fs.root
          const left = yield* fs.lookup(Vfs.Entry(root, name("left")))
          const right = yield* fs.lookup(Vfs.Entry(root, name("right")))
          const child = yield* fs.lookup(Vfs.Entry(left, name("child")))
          assert.strictEqual(yield* fs.parent(root), root)
          assert.strictEqual(yield* fs.parent(child), left)
          yield* fs.rename("/left/child", "/right/child")
          assert.strictEqual(yield* fs.parent(child), right)

          const observation = yield* fs.readDirectory(root)
          const firstName = observation.value[0]?.name
          assert.isDefined(firstName)
          firstName[0] = 0
          const names = (yield* fs.readDirectory(root)).value.map((entry) => new TextDecoder().decode(entry.name))
          assert.deepStrictEqual(names, ["left", "right", "link"])

          const link = yield* fs.lookup(Vfs.Entry(root, name("link")))
          const target = yield* fs.readLink(link)
          target[0] = 0
          assert.deepStrictEqual(yield* fs.readLink(link), name("target"))
          yield* fs.rmdir("/right/child")
          assert.strictEqual((yield* Effect.flip(fs.parent(child))).code, "StaleReference")
        }).pipe(Effect.provide(Testing.layer())))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should recheck read authority when a caller uses an object reference",
        () =>
          Effect.gen(function*() {
            const admin = yield* Vfs.Caller
            yield* admin.writeFile("/secret", bytes(1), { access: "write", create: "exclusive", mode: 0 })
            const reference = yield* admin.lookup(Vfs.Entry(yield* admin.root, name("secret")))
            const guest = yield* Testing.callerAs({ uid: 1, gid: 1, groups: [], privileged: false })
            assert.strictEqual((yield* Effect.flip(guest.open(reference, { access: "read" }))).code, "AccessDenied")
            assert.strictEqual(yield* guest.access(reference, 0o4), 0)
            assert.strictEqual(yield* admin.access(reference, 0o4), 0o4)
            assert.strictEqual((yield* Effect.flip(guest.access(reference, 8))).code, "InvalidArgument")
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should expose metadata and link targets when the caller lacks object permission",
        () =>
          Effect.gen(function*() {
            const admin = yield* Vfs.Caller
            yield* admin.writeFile("/secret", bytes(1), { access: "write", create: "exclusive", mode: 0 })
            yield* admin.symlink("target", "/link")
            yield* admin.chmod(Vfs.Target.Path({ path: "/link", followFinalSymlink: false }), 0)
            const root = yield* admin.root
            const secret = yield* admin.lookup(Vfs.Entry(root, name("secret")))
            const link = yield* admin.lookup(Vfs.Entry(root, name("link")))
            const guest = yield* Testing.callerAs({ uid: 1, gid: 1, groups: [], privileged: false })

            assert.strictEqual((yield* guest.stat(secret)).mode, 0)
            assert.deepStrictEqual(yield* guest.readLink(link), name("target"))
            assert.strictEqual((yield* Effect.flip(guest.open(secret, { access: "read" }))).code, "AccessDenied")
          }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should recheck traversal and directory authority when a caller uses references",
        () =>
          Effect.gen(function*() {
            const admin = yield* Vfs.Caller
            yield* admin.mkdir("/directory", { mode: 0o001 })
            yield* admin.mkdir("/directory/child", { mode: 0o001 })
            const root = yield* admin.root
            const directory = yield* admin.lookup(Vfs.Entry(root, name("directory")))
            const child = yield* admin.lookup(Vfs.Entry(directory, name("child")))
            const guest = yield* Testing.callerAs({ uid: 1, gid: 1, groups: [], privileged: false })

            assert.strictEqual(yield* guest.lookup(Vfs.Entry(directory, name("child"))), child)
            assert.strictEqual(yield* guest.parent(child), directory)
            assert.strictEqual((yield* Effect.flip(guest.readDirectory(directory))).code, "AccessDenied")

            yield* admin.chmod("/directory", 0)
            assert.strictEqual(
              (yield* Effect.flip(guest.lookup(Vfs.Entry(directory, name("child"))))).code,
              "AccessDenied"
            )
            yield* admin.chmod("/directory/child", 0)
            assert.strictEqual((yield* Effect.flip(guest.parent(child))).code, "AccessDenied")
          }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should preserve bytes when validating one lookup component", () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          const root = yield* fs.root

          const invalid = [
            new Uint8Array(),
            name("."),
            name(".."),
            name("a/b"),
            new Uint8Array([0]),
            new Uint8Array(256)
          ]

          for (const component of invalid) {
            assert.strictEqual((yield* Effect.flip(fs.lookup(Vfs.Entry(root, component)))).code, "InvalidArgument")
          }

          // A string name is encoded as UTF-8 and looked up like bytes.
          assert.strictEqual((yield* Effect.flip(fs.lookup(Vfs.Entry(root, "name")))).code, "NotFound")
          const detached = new Uint8Array([1])
          structuredClone(detached, { transfer: [detached.buffer] })
          assert.strictEqual((yield* Effect.flip(fs.lookup(Vfs.Entry(root, detached)))).code, "InvalidArgument")

          const maximum = new Uint8Array(255).fill(97)
          const maximumPath = yield* Vfs.pathFromBytes(new Uint8Array([47, ...maximum]))
          yield* fs.writeFile(maximumPath, bytes(1), { access: "write", create: "exclusive" })
          yield* fs.lookup(Vfs.Entry(root, maximum))

          const opaque = new Uint8Array([0xff])
          const opaquePath = yield* Vfs.pathFromBytes(new Uint8Array([47, ...opaque]))
          yield* fs.writeFile(opaquePath, bytes(2), { access: "write", create: "exclusive" })
          const opaqueReference = yield* fs.lookup(Vfs.Entry(root, opaque))
          assert.strictEqual((yield* fs.stat(opaqueReference)).size, 1n)
        }).pipe(Effect.provide(Testing.layer())))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should reject mutations through a removed directory when a handle still holds it",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            yield* fs.mkdir("/a")
            const root = yield* fs.root
            const a = yield* fs.lookup(Vfs.Entry(root, name("a")))
            const handle = yield* fs.openDirectory("/a")
            yield* fs.rmdir("/a")
            assert.strictEqual((yield* handle.stat).nlink, 0)
            // The removed directory stops counting at rmdir, even while the handle still holds it.
            assert.deepStrictEqual(yield* (yield* Vfs.Volume).usage, { usedBytes: 0n, entries: 0 })
            assert.strictEqual((yield* Effect.flip(fs.stat(a))).code, "StaleReference")
            assert.strictEqual((yield* Effect.flip(fs.parent(a))).code, "StaleReference")
            assert.strictEqual((yield* Effect.flip(fs.mkdir(Vfs.Entry(a, name("orphan"))))).code, "StaleReference")
            yield* fs.writeFile("/f", bytes(1), { access: "write", create: "exclusive" })
            assert.strictEqual(
              (yield* Effect.flip(fs.rename(Vfs.Entry(root, name("f")), Vfs.Entry(a, name("g"))))).code,
              "StaleReference"
            )
            assert.deepStrictEqual(yield* (yield* Vfs.Volume).usage, { usedBytes: 1n, entries: 1 })
            yield* handle.close
            assert.strictEqual((yield* Effect.flip(handle.stat)).code, "InvalidHandle")
            assert.deepStrictEqual(entryNames(yield* fs.readDirectory("/")), ["f"])
            assert.deepStrictEqual(yield* (yield* Vfs.Volume).usage, { usedBytes: 1n, entries: 1 })
          }).pipe(Effect.provide(Testing.layer()))
      )
    })
  })
})

describe("reference mutations", () => {
  const name = (value: string) => new TextEncoder().encode(value)

  describe("reference mutations", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should apply umask but preserve an explicit mode when a directory is created through a reference",
        () =>
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
          }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0o077 } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should remove files and empty directories when a reference removal targets either kind",
        () =>
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
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should apply unlink and rmdir checks when a reference removes a file or directory",
        () =>
          Effect.gen(function*() {
            const fs = yield* Vfs.Caller
            const guest = yield* Testing.callerAs({ uid: 9, gid: 9, groups: [], privileged: false })
            const root = yield* fs.root
            const sticky = (yield* fs.mkdir(Vfs.Entry(root, name("sticky")), { mode: 0o1777 })).reference
            const file = yield* fs.open(Vfs.Entry(sticky, name("file")), { access: "write", create: "exclusive" })
            yield* file.handle.close

            const code = <A>(effect: Effect.Effect<A, Vfs.VfsError>) =>
              Effect.map(Effect.flip(effect), (error) => error.code)

            assert.strictEqual(yield* code(guest.remove(Vfs.Entry(sticky, name("file")))), "NotPermitted")
            assert.strictEqual(yield* code(fs.remove(Vfs.Entry(sticky, name("missing")))), "NotFound")
            assert.strictEqual(yield* code(fs.remove(Vfs.Entry(sticky, name(".")))), "InvalidArgument")
            assert.strictEqual(yield* code(fs.remove(Vfs.Entry(root, name("sticky")))), "NotEmpty")

            yield* fs.remove(Vfs.Entry(sticky, name("file")))
            const links = (yield* fs.stat(root)).nlink
            yield* fs.remove(Vfs.Entry(root, name("sticky")))
            assert.strictEqual((yield* fs.stat(root)).nlink, links - 1)
            assert.strictEqual(yield* code(fs.stat(sticky)), "StaleReference")
          }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should publish initial identity timestamps and directory changes when an entry is created through a reference",
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
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should open or create one child atomically when a writable reference handle is requested",
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
            assert.strictEqual(
              (yield* Effect.flip(fs.open(created.reference, { access: "read" }))).code,
              "StaleReference"
            )
            assert.strictEqual(
              (yield* Effect.flip(fs.link(created.reference, Vfs.Entry(root, name("resurrected"))))).code,
              "StaleReference"
            )
            yield* writer.close
            assert.strictEqual((yield* Effect.flip(fs.stat(created.reference))).code, "StaleReference")
          }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should link rename and remove the selected object when a reference identifies it",
        () =>
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

            const noOp = yield* fs.rename(
              Vfs.Entry(left.reference, name("file")),
              Vfs.Entry(right.reference, name("alias"))
            )

            assert.strictEqual(noOp._tag, "DifferentDirectories")

            if (Vfs.RenameReferenceResult.guards.DifferentDirectories(noOp)) {
              assert.strictEqual(noOp.sourceDirectory.before, noOp.sourceDirectory.after)
              assert.strictEqual(noOp.destinationDirectory.before, noOp.destinationDirectory.after)
            }

            const moved = yield* fs.rename(
              Vfs.Entry(left.reference, name("file")),
              Vfs.Entry(right.reference, name("moved"))
            )

            assert.strictEqual(moved._tag, "DifferentDirectories")

            assert.strictEqual(yield* fs.lookup(Vfs.Entry(right.reference, name("moved"))), file.reference)
            yield* fs.unlink(Vfs.Entry(right.reference, name("alias")))
            yield* fs.unlink(Vfs.Entry(right.reference, name("moved")))

            const removed = yield* fs.rmdir(Vfs.Entry(root, name("left")))
            assert.isTrue(removed.after > removed.before)
            yield* fs.rmdir(Vfs.Entry(root, name("right")))
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should report one directory change when a rename stays in its directory",
        () =>
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
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should enforce the invoking caller's authority when metadata or size is changed through a reference",
        () =>
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
          }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should leave an open target unchanged when the expected child no longer matches",
        () =>
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
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should report the parent's revision before and after every entry mutation when an entry changes",
        () =>
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
            assert.strictEqual(
              (yield* Effect.flip(fs.mkdir(Vfs.Entry(parent, name("existing"))))).code,
              "AlreadyExists"
            )
            assert.isTrue(beforeRepeat > beforeFailure)
            assert.strictEqual(yield* revision(parent), beforeRepeat)
            assert.strictEqual(yield* revision(other), otherUntouched)
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should return non-overlapping revision pairs when child creations race",
        () =>
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
          }).pipe(Effect.provide(Testing.layer()))
      )
    })
  })

  describe("reference mutation regressions", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should preserve invalid path bytes when a symbolic link is created through a reference",
        () =>
          Effect.gen(function*() {
            const caller = yield* Vfs.Caller
            const root = yield* caller.root

            const error = yield* Effect.flip(caller.symlink("\ud800", Vfs.Entry(root, name("link"))))

            assert.strictEqual(error.code, "InvalidPathEncoding")
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should reject initial timestamps when child creation is disabled", () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          const root = yield* caller.root

          const times = {
            access: { kind: "value" as const, nanoseconds: 1n },
            modification: { kind: "value" as const, nanoseconds: 2n }
          }

          const omitted = yield* Effect.flip(caller.open(Vfs.Entry(root, name("missing")), {
            access: "read",
            times
          }))

          const never = yield* Effect.flip(caller.open(Vfs.Entry(root, name("missing")), {
            access: "read",
            create: "never",
            times
          }))

          assert.strictEqual(omitted.code, "InvalidArgument")
          assert.strictEqual(never.code, "InvalidArgument")
        }).pipe(Effect.provide(Testing.layer())))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should apply the total-path limit to expanded links when a reference follows a symbolic link",
        () =>
          Effect.gen(function*() {
            const caller = yield* Vfs.Caller
            const root = yield* caller.root

            const target = yield* caller.open(Vfs.Entry(root, name("x")), {
              access: "readWrite",
              create: "exclusive"
            })

            yield* target.handle.close
            yield* caller.symlink("x", Vfs.Entry(root, name("long-name")))

            const opened = yield* caller.open(Vfs.Entry(root, name("long-name")), { access: "read" })

            assert.strictEqual(opened.reference, target.reference)
            yield* opened.handle.close
          }).pipe(Effect.provide(Testing.layer({ volume: { maxPathBytes: ByteSize.bytes(1) } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should create through a dangling final link and report the target directory change when a reference follows that link",
        () =>
          Effect.gen(function*() {
            const caller = yield* Vfs.Caller
            const root = yield* caller.root
            const target = yield* caller.mkdir(Vfs.Entry(root, name("target")))
            yield* caller.symlink("/target/new", Vfs.Entry(root, name("link")))
            const rootBefore = (yield* caller.readDirectory(root)).revision
            const targetBefore = (yield* caller.readDirectory(target.reference)).revision

            const opened = yield* caller.open(Vfs.Entry(root, name("link")), {
              access: "readWrite",
              create: "ifMissing"
            })

            assert.isTrue(opened.created)
            assert.strictEqual(opened.directory.before, targetBefore)
            assert.isTrue(opened.directory.after > opened.directory.before)
            assert.strictEqual((yield* caller.readDirectory(root)).revision, rootBefore)
            assert.strictEqual(yield* caller.lookup(Vfs.Entry(target.reference, name("new"))), opened.reference)
            yield* opened.handle.close
          }).pipe(Effect.provide(Testing.layer()))
      )
    })
  })

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
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should reject a newly present or replaced child before truncating it when creating a child through a reference",
        () =>
          Effect.gen(function*() {
            const caller = yield* Vfs.Caller
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
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should reject stale revisions or access times when opening a child through a reference",
        () =>
          Effect.gen(function*() {
            const caller = yield* Vfs.Caller
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
          }).pipe(Effect.provide(Testing.layer()))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should create initial size and ownership when creating a child through a reference without changing initial timestamps",
        () =>
          Effect.gen(function*() {
            const volume = yield* Vfs.Volume
            const caller = yield* Vfs.Caller
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
          }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0o027 } })))
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should leave no entry when initial size exceeds file or volume capacity",
        () =>
          Effect.gen(function*() {
            for (
              const [limits, code] of [
                [{ maxFileBytes: ByteSize.bytes(2) }, "FileTooLarge"],
                [{ maxBytes: ByteSize.bytes(2) }, "NoSpace"]
              ] as const
            ) {
              yield* Effect.gen(function*() {
                const volume = yield* Vfs.Volume
                const caller = yield* Vfs.Caller
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
              }).pipe(Effect.provide(Testing.layer({ volume: limits })))
            }
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should validate initial ownership and accept a caller group when creating a child",
        () =>
          Effect.gen(function*() {
            const admin = yield* Vfs.Caller
            const root = yield* admin.root
            yield* admin.chmod(root, 0o777)
            const caller = yield* Testing.callerAs({ uid: 7, gid: 8, groups: [9], privileged: false })

            for (const owner of [{ uid: 10 }, { gid: 10 }]) {
              const error = yield* Effect.flip(caller.open(Vfs.Entry(root, name("file")), {
                access: "write",
                create: "exclusive",
                owner
              }))

              assert.strictEqual(error.code, "NotPermitted")
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
          }).pipe(Effect.provide(Testing.layer()))
      )
    })
  })
})
