import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Cause, Clock, Deferred, Effect, Exit, Fiber, Layer, Result, Scheduler, Scope } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const identity = (uid: number, privileged = false, groups: ReadonlyArray<number> = []) => ({
  uid,
  gid: uid,
  groups,
  privileged
})

describe("directory volumes", () => {
  it.effect("shares a namespace between callers and isolates separate executions", () =>
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
    }))

  it.effect("initializes directory metadata and updates the parent link count", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller({ identity: identity(12, true), umask: 0o027 })
      const root = yield* caller.stat("/")
      assert.deepStrictEqual([root.uid, root.gid, root.mode, root.size, root.nlink], [0, 0, 0o755, 0n, 2])
      yield* caller.mkdir("/work", { mode: 0o7777 })
      const work = yield* caller.stat("/work")
      assert.deepStrictEqual([work.uid, work.gid, work.mode, work.size, work.nlink], [12, 0, 0o1750, 0n, 2])
      assert.strictEqual((yield* caller.stat("/")).nlink, 3)
    }))

  it.effect("checks owner permissions without falling through and keeps privilege explicit", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller()
      yield* admin.mkdir("/locked", { mode: 0o007 })
      const unprivilegedRoot = yield* volume.caller({ identity: identity(0) })
      assert.strictEqual((yield* Effect.flip(unprivilegedRoot.mkdir("/locked/child"))).code, "AccessDenied")
      const privileged = yield* volume.caller({ identity: identity(91, true) })
      yield* privileged.mkdir("/locked/child")
      assert.strictEqual((yield* privileged.stat("/locked/child")).uid, 91)
    }))

  it.effect("uses supplementary groups captured separately on each caller execution", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller({ umask: 0 })
      yield* admin.mkdir("/shared", { mode: 0o070 })
      const groups = [99]
      const construct = volume.caller({ identity: identity(42, false, groups) })
      groups[0] = 0
      const allowed = yield* construct
      groups[0] = 99
      const denied = yield* construct
      yield* allowed.mkdir("/shared/child")
      assert.strictEqual((yield* Effect.flip(denied.stat("/shared/child"))).code, "AccessDenied")
    }))

  it.effect("keeps root and child callers alive after a parent derived scope closes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const root = yield* volume.caller()
      yield* root.mkdir("/work")
      const parentScope = yield* Scope.make()
      const parent = yield* root.withDirectory("/work").pipe(Scope.provide(parentScope))
      const child = yield* parent.withDirectory(".")
      const pending = parent.stat(".")
      yield* Scope.close(parentScope, Exit.void)
      assert.strictEqual((yield* Effect.flip(pending)).code, "ClosedCaller")
      assert.strictEqual((yield* child.stat(".")).ino, (yield* root.stat("/work")).ino)
      assert.strictEqual((yield* root.stat(".")).ino, (yield* root.stat("/")).ino)
    }))

  it.effect("ignores unused absolute bases but rejects relevant foreign and closed bases", () =>
    Effect.gen(function*() {
      const a = yield* (yield* Vfs.make()).caller()
      const b = yield* (yield* Vfs.make()).caller()
      const base = yield* b.openDirectory("/")
      yield* base.close
      yield* a.mkdir("/ok", { relativeTo: base })
      assert.strictEqual((yield* Effect.flip(a.stat("ok", { relativeTo: base }))).code, "ForeignHandle")
      const own = yield* a.openDirectory("/")
      yield* own.close
      assert.strictEqual((yield* Effect.flip(a.stat("ok", { relativeTo: own }))).code, "InvalidHandle")
      assert.strictEqual((yield* Effect.flip(own.close)).code, "InvalidHandle")
    }))

  it.effect("does not transfer opener privilege through a directory base", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const admin = yield* volume.caller()
      yield* admin.mkdir("/private", { mode: 0o700 })
      const base = yield* admin.openDirectory("/private")
      const guest = yield* volume.caller({ identity: identity(123) })
      assert.strictEqual((yield* Effect.flip(guest.stat(".", { relativeTo: base }))).code, "AccessDenied")
      assert.strictEqual((yield* guest.stat("/private")).mode, 0o700)
      assert.strictEqual((yield* Effect.flip(guest.openDirectory("/private"))).code, "AccessDenied")
    }))

  it.effect("retains exact byte names and owns each exported buffer", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
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
    }))

  it.effect("applies optional byte limits at volume use before normalizing separators", () =>
    Effect.gen(function*() {
      const limited = yield* (yield* Vfs.make({ maxPathBytes: ByteSize.bytes(3) })).caller()
      const unlimited = yield* (yield* Vfs.make()).caller()
      const path = yield* Vfs.pathFromBytes(new TextEncoder().encode("/é"))
      yield* limited.mkdir(path)
      assert.strictEqual((yield* Effect.flip(limited.stat("//é"))).code, "PathTooLong")
      yield* unlimited.mkdir("longer")
      const longer = yield* Vfs.pathFromBytes(new TextEncoder().encode("longer"))
      yield* unlimited.stat(longer)
      assert.strictEqual((yield* Effect.flip(limited.stat(longer))).code, "PathTooLong")
    }))

  it.effect("does not charge root or change parent metadata on quota rejection", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make({ maxEntries: 0 })).caller()
      const before = yield* caller.stat("/")
      assert.strictEqual((yield* Effect.flip(caller.mkdir("/child"))).code, "NoSpace")
      assert.deepStrictEqual(yield* caller.stat("/"), before)
      assert.strictEqual((yield* Effect.flip(caller.stat("/child"))).code, "NotFound")
    }))

  it.effect("provides the same caller through the optional Effect service", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      yield* caller.mkdir("work")
      const read = Effect.gen(function*() {
        return yield* (yield* Vfs.CurrentFileSystem).stat("work")
      })
      const direct = yield* read.pipe(Effect.provideService(Vfs.CurrentFileSystem, caller))
      const layered = yield* read.pipe(Effect.provide(Layer.succeed(Vfs.CurrentFileSystem, caller)))
      assert.deepStrictEqual(direct, layered)
    }))
})

describe("input and mutation boundaries", () => {
  it.effect("rejects invalid configurations with their field and supports lazy option capture", () =>
    Effect.gen(function*() {
      for (const maxEntries of [-1, 1.5, Infinity, NaN]) {
        const error = yield* Effect.flip(Vfs.make({ maxEntries }))
        assert.strictEqual(error._tag, "ConfigurationError")
        assert.strictEqual(error.field, "maxEntries")
      }
      for (const maxPathBytes of [0, -1, 1.5, Infinity]) {
        // @ts-expect-error exercises runtime rejection outside the public ByteSize contract
        assert.strictEqual((yield* Effect.flip(Vfs.make({ maxPathBytes }))).field, "maxPathBytes")
      }
      assert.strictEqual((yield* Effect.flip(Vfs.make({ maxPathBytes: ByteSize.zero }))).field, "maxPathBytes")
      assert.strictEqual(
        (yield* Effect.flip(Vfs.make({ maxFileBytes: ByteSize.bytes(0x1_0000_0000) }))).field,
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
      assert.strictEqual((yield* Effect.flip(volume.caller({ umask: 0o1000 }))).field, "umask")
      assert.strictEqual((yield* Effect.flip(volume.caller({ identity: identity(-1) }))).field, "identity")
    }))

  it.effect("rejects malformed paths and mode arguments without changing the namespace", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
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
        assert.strictEqual(error.path, path)
      }
      for (const mode of [-1, 0o10000, 0.5, Infinity]) {
        assert.strictEqual((yield* Effect.flip(caller.mkdir("bad", { mode }))).code, "InvalidArgument")
      }
      assert.deepStrictEqual(yield* caller.stat("/"), before)
    }))

  it.effect("rejects shared and detached views while copying ordinary subarrays", () =>
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
    }))

  it.effect("preserves literal names and resolves dot components through existing directories", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      for (const name of ["work", "back\\slash", "%2f", "é", "e\u0301", "line\nfeed", "😀"]) yield* caller.mkdir(name)
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
    }))

  it.effect("uses byte component boundaries and accepts long paths when no total bound is configured", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
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
    }))

  it.effect("does not create missing parents or change metadata on duplicate creation", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
      const before = yield* caller.stat("/")
      assert.strictEqual((yield* Effect.flip(caller.mkdir("/missing/child"))).code, "NotFound")
      assert.deepStrictEqual(yield* caller.stat("/"), before)
      yield* caller.mkdir("/one")
      const after = yield* caller.stat("/")
      assert.strictEqual((yield* Effect.flip(caller.mkdir("/one"))).code, "AlreadyExists")
      assert.deepStrictEqual(yield* caller.stat("/"), after)
    }))

  it.effect("serializes competing creates and quota accounting", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make({ maxEntries: 1 })).caller()
      const results = yield* Effect.forEach([caller.mkdir("/same"), caller.mkdir("/same")], Effect.result, {
        concurrency: "unbounded"
      })
      assert.strictEqual(results.filter(Result.isSuccess).length, 1)
      assert.deepStrictEqual(results.filter(Result.isFailure).map((result) => result.failure.code), ["AlreadyExists"])
      assert.strictEqual((yield* caller.stat("/")).nlink, 3)
      assert.strictEqual((yield* Effect.flip(caller.mkdir("/another"))).code, "NoSpace")
    }))
})

describe("authority, time, and resource lifetime", () => {
  it.effect("requires parent write/search but not read, and checks inaccessible prefixes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const owner = yield* volume.caller({ identity: identity(7, true), umask: 0 })
      yield* owner.mkdir("/work", { mode: 0o300 })
      yield* owner.mkdir("/work/public", { mode: 0o777 })
      const sameUser = yield* volume.caller({ identity: identity(7) })
      yield* sameUser.mkdir("/work/new")
      const guest = yield* volume.caller({ identity: identity(9) })
      assert.strictEqual((yield* Effect.flip(guest.stat("/work/public"))).code, "AccessDenied")
      assert.strictEqual((yield* Effect.flip(guest.mkdir("/new-root-entry"))).code, "AccessDenied")
    }))

  it.effect("captures the volume clock and publishes related timestamps together", () =>
    Effect.gen(function*() {
      const original = yield* Clock.clockWith(Effect.succeed)
      let time = 10n
      let samples = 0
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => Number(time / 1_000_000n),
        currentTimeMillis: Effect.sync(() => Number(time / 1_000_000n)),
        currentTimeNanosUnsafe: () => {
          samples += 1
          return time
        },
        currentTimeNanos: Effect.sync(() => time),
        monotonicTimeNanosUnsafe: () => original.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: original.monotonicTimeNanos,
        sleep: (duration) => original.sleep(duration)
      }
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
    }))

  it.effect("keeps separately scoped handles alive after their originating caller closes", () =>
    Effect.gen(function*() {
      const root = yield* (yield* Vfs.make()).caller()
      yield* root.mkdir("/work")
      const scope = yield* Scope.make()
      const caller = yield* root.withDirectory("/work").pipe(Scope.provide(scope))
      const handle = yield* caller.openDirectory(".")
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual((yield* handle.stat).ino, (yield* root.stat("/work")).ino)
      assert.strictEqual((yield* Effect.flip(caller.stat("/work", { relativeTo: handle }))).code, "ClosedCaller")
    }))

  it.effect("releases on scope exit and tolerates prior explicit close", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
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
    }))

  it.effect("interruption before starting a mutation leaves no entry", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
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
    }))

  it.effect("interruption releases acquired resources without rolling back committed directories", () =>
    Effect.gen(function*() {
      const caller = yield* (yield* Vfs.make()).caller()
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
    }))
})

it.effect("does not retain a directory or deadlock when the acquisition scope is already closed", () =>
  Effect.gen(function*() {
    const caller = yield* (yield* Vfs.make()).caller()
    const scope = yield* Scope.make()
    yield* Scope.close(scope, Exit.void)
    const result = yield* caller.openDirectory("/").pipe(Scope.provide(scope), Effect.exit)
    assert.isTrue(Exit.isFailure(result))
    if (Exit.isFailure(result)) assert.isTrue(Cause.hasInterruptsOnly(result.cause))
    yield* caller.mkdir("/after")
    assert.strictEqual((yield* caller.stat("/")).nlink, 3)
  }))

it.effect("coordinates scope closure with acquisition without returning a live escaped reference", () =>
  Effect.gen(function*() {
    const caller = yield* (yield* Vfs.make()).caller()
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
  }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 64)))

it.effect("orders handle observation against explicit close", () =>
  Effect.gen(function*() {
    const caller = yield* (yield* Vfs.make()).caller()
    const handle = yield* caller.openDirectory("/")
    const [observation] = yield* Effect.all([
      handle.stat.pipe(Effect.result),
      handle.close
    ], { concurrency: "unbounded" })
    if (Result.isFailure(observation)) assert.strictEqual(observation.failure.code, "InvalidHandle")
    else assert.strictEqual(observation.success.ino, (yield* caller.stat("/")).ino)
    assert.strictEqual((yield* Effect.flip(handle.stat)).code, "InvalidHandle")
  }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 64)))
