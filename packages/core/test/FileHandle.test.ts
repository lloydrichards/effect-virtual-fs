import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Cause, Deferred, Effect, Exit, Fiber, Scheduler, Scope } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { makeVolume, VolumeSource } from "../src/internal/virtualFileSystem.js"
import { entryNames, text } from "./support/text.js"

const bytes = (...values: Array<number>) => new Uint8Array(values)

describe("regular files", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should share file content but isolate offsets when multiple handles access it",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          const a = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
          const input = bytes(1, 2, 3)
          const write = a.write(input)
          input[0] = 4
          assert.strictEqual(yield* write, 3)
          input[0] = 9
          const b = yield* fs.open("/f", { access: "read" })
          const read = yield* b.read(2)
          assert.deepStrictEqual(read, bytes(4, 2))
          read[0] = 8
          assert.deepStrictEqual((yield* a.pread(3, 0n)).bytes, bytes(4, 2, 3))
          assert.strictEqual(yield* a.seek(0n, "current"), 3n)
          assert.deepStrictEqual(yield* b.read(5), bytes(3))
          assert.deepStrictEqual(yield* b.read(1), bytes())
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should preserve offsets and zero-fill gaps when truncating or using positional I/O",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          const f = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
          yield* f.write(bytes(1, 2, 3))
          yield* f.seek(8n, "start")
          yield* f.truncate(1n)
          assert.strictEqual(yield* f.seek(0n, "current"), 8n)
          yield* f.write(bytes(7))
          assert.deepStrictEqual((yield* f.pread(10, 0n)).bytes, bytes(1, 0, 0, 0, 0, 0, 0, 0, 7))
          yield* f.pwrite(bytes(6), 1n)
          assert.strictEqual(yield* f.seek(0n, "current"), 9n)
          assert.strictEqual((yield* Effect.flip(f.seek(-10n, "current"))).code, "InvalidArgument")
          assert.strictEqual(yield* f.seek(0n, "current"), 9n)
          assert.strictEqual((yield* Effect.flip(f.pread(1, 1n << 64n))).code, "InvalidArgument")
          assert.strictEqual((yield* Effect.flip(f.pwrite(bytes(1), 1n << 64n))).code, "InvalidArgument")
          assert.strictEqual(yield* f.seek(1n, "data"), 1n)
          assert.strictEqual(yield* f.seek(1n, "hole"), 9n)
          assert.strictEqual((yield* Effect.flip(f.seek(9n, "data"))).code, "NoData")
          assert.strictEqual(yield* f.seek(0n, "current"), 9n)
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should append atomically while preserving offsets when positional writes use an append handle",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          const a = yield* fs.open("/f", { access: "readWrite", append: true, create: "ifMissing" })
          const b = yield* fs.open("/f", { access: "write", append: true })
          yield* Effect.all([a.write(bytes(1, 1)), b.write(bytes(2, 2))], { concurrency: "unbounded" })
          const data = (yield* a.pread(4, 0n)).bytes
          assert.isTrue(data.join() === "1,1,2,2" || data.join() === "2,2,1,1")
          const position = yield* a.seek(0n, "current")
          yield* a.pwrite(bytes(9), 0n)
          assert.strictEqual(yield* a.seek(0n, "current"), position)
          assert.strictEqual((yield* a.pread(1, 0n)).bytes[0], 9)
          yield* a.seek(0n, "start")
          yield* a.write(bytes())
          assert.strictEqual(yield* a.seek(0n, "current"), 0n)
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should preserve file state when capacity limits reject growth",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          const f = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
          yield* f.write(bytes(1, 2, 3, 4))
          assert.strictEqual(yield* f.write(bytes(5, 6, 7)), 2)
          const before = yield* f.stat
          assert.strictEqual((yield* Effect.flip(f.write(bytes(8)))).code, "NoSpace")
          assert.strictEqual((yield* Effect.flip(f.truncate(7n))).code, "NoSpace")
          assert.deepStrictEqual(yield* f.stat, before)
          assert.strictEqual(yield* f.pwrite(bytes(9), 1n), 1)
          yield* f.truncate(4n)
          assert.strictEqual((yield* Effect.flip(f.pwrite(bytes(8), 6n))).code, "NoSpace")
          assert.strictEqual(yield* f.pwrite(bytes(8, 9), 5n), 1)
          assert.deepStrictEqual((yield* f.pread(9, 0n)).bytes, bytes(1, 9, 3, 4, 0, 8))
        }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(6) } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should retain content charge when an unlinked file still has open handles",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const fs = yield* Vfs.Caller
          const a = yield* fs.open("/f", { access: "readWrite", create: "exclusive" })
          const b = yield* fs.open("/f", { access: "read" })
          yield* a.write(bytes(1, 2))
          yield* fs.unlink("/f")
          assert.deepStrictEqual(yield* volume.usage, { usedBytes: 2n, entries: 0 })
          assert.strictEqual((yield* a.stat).nlink, 0)
          const replacement = yield* fs.open("/f", { access: "write", create: "exclusive" })
          assert.strictEqual((yield* Effect.flip(replacement.write(bytes(3)))).code, "NoSpace")
          yield* a.close
          assert.deepStrictEqual(yield* b.read(2), bytes(1, 2))
          yield* b.close
          assert.deepStrictEqual(yield* volume.usage, { usedBytes: 0n, entries: 1 })
          assert.strictEqual(yield* replacement.write(bytes(3, 4)), 2)
          assert.strictEqual((yield* Effect.flip(a.close)).code, "InvalidHandle")
          assert.strictEqual((yield* Effect.flip(a.read(0))).code, "InvalidHandle")
        }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(2), maxEntries: 1 } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should avoid creating a file when scoped acquisition cannot retain its handle",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          const scope = yield* Scope.make()
          yield* Scope.close(scope, Exit.void)

          const result = yield* Effect.exit(
            fs.open("/f", { access: "write", create: "exclusive" }).pipe(Scope.provide(scope))
          )

          assert.isTrue(Exit.isFailure(result))
          assert.strictEqual((yield* Effect.flip(fs.stat("/f"))).code, "NotFound")
          const liveScope = yield* Scope.make()
          const f = yield* fs.open("/f", { access: "write", create: "exclusive" }).pipe(Scope.provide(liveScope))
          yield* Scope.close(liveScope, Exit.void)
          assert.strictEqual((yield* Effect.flip(f.write(bytes()))).code, "InvalidHandle")
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should preserve content when file kind, access, creation, or bounds checks fail",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          const f = yield* fs.open("/f", { access: "readWrite", create: "exclusive", mode: 0o400 })
          yield* f.write(bytes(1, 2, 3))
          assert.strictEqual((yield* Effect.flip(f.write(bytes(3)))).code, "FileTooLarge")
          const guest = yield* Testing.callerAs({ uid: 0, gid: 0, groups: [], privileged: false })
          assert.strictEqual(
            (yield* Effect.flip(guest.open("/f", { access: "write", truncate: true }))).code,
            "AccessDenied"
          )
          assert.deepStrictEqual((yield* f.pread(3, 0n)).bytes, bytes(1, 2))
          assert.strictEqual(
            (yield* Effect.flip(fs.open("/f", { access: "write", create: "exclusive" }))).code,
            "AlreadyExists"
          )
          assert.strictEqual((yield* Effect.flip(fs.open("/", { access: "read" }))).code, "IsDirectory")
          assert.strictEqual((yield* Effect.flip(fs.stat("/f/.."))).code, "NotDirectory")
          assert.strictEqual((yield* Effect.flip(fs.stat("/f/"))).code, "NotDirectory")
          const read = yield* fs.open("/f", { access: "read" })
          assert.strictEqual((yield* Effect.flip(read.write(bytes()))).code, "InvalidHandle")
          assert.strictEqual((yield* Effect.flip(read.truncate(0n))).code, "InvalidHandle")
        }).pipe(Effect.provide(Testing.layer({ volume: { maxFileBytes: ByteSize.bytes(2) } })))
    )
  })
})

describe("whole-file byte ownership", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should capture independent bytes on each execution when a write effect is reused",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          const input = new Uint8Array([0, 1, 2, 0])
          const write = fs.writeFile("/f", input.subarray(1, 3), { access: "write", create: "ifMissing" })
          input[1] = 3
          yield* write
          input[1] = 4
          assert.deepStrictEqual(yield* fs.readFile("/f"), new Uint8Array([3, 2]))
          const handle = yield* fs.open("/f", { access: "write" })
          yield* handle.pwrite(new Uint8Array([9]), 0n)
          assert.deepStrictEqual(input, new Uint8Array([0, 4, 2, 0]))
          yield* write
          input.fill(0)
          const output = yield* fs.readFile("/f")
          assert.deepStrictEqual(output, new Uint8Array([4, 2]))
          output.fill(8)
          assert.deepStrictEqual(yield* fs.readFile("/f"), new Uint8Array([4, 2]))
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should read current metadata and reject operations when a handle is explicitly closed",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          const directory = yield* caller.openDirectory("/")
          const file = yield* caller.open("/f", { access: "readWrite", create: "exclusive" })
          const stat = file.stat
          const sync = file.sync
          const close = file.close
          const directoryStat = directory.stat
          const directoryClose = directory.close
          const before = yield* stat
          const directoryBefore = yield* directoryStat
          yield* sync
          yield* file.write(new Uint8Array([1, 2]))
          yield* caller.mkdir("/child")
          assert.strictEqual((yield* stat).size, 2n)
          assert.strictEqual(before.size, 0n)
          assert.strictEqual((yield* directoryStat).nlink, directoryBefore.nlink + 1)
          yield* sync
          yield* close
          assert.strictEqual((yield* Effect.flip(stat)).code, "InvalidHandle")
          assert.strictEqual((yield* Effect.flip(sync)).code, "InvalidHandle")
          assert.strictEqual((yield* Effect.flip(close)).code, "InvalidHandle")
          yield* directoryClose
          assert.strictEqual((yield* Effect.flip(directoryStat)).code, "InvalidHandle")
          assert.strictEqual((yield* Effect.flip(directoryClose)).code, "InvalidHandle")
        }).pipe(Effect.provide(Testing.layer()))
    )
  })
})

describe("whole-file symlink replacement", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should replace only the final link and publish its destination when quota is full",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const fs = yield* Vfs.Caller
          yield* fs.writeFile("/target", new Uint8Array([42]), { access: "write", create: "exclusive" })
          yield* fs.symlink("/target", "/link")

          const watcher = yield* Testing.collectChanges(yield* volume.watch(), 1)

          yield* fs.writeFile("/link", new Uint8Array(7), {
            access: "write",
            create: "ifMissing",
            truncate: true,
            replaceFinalSymlink: true
          })
          assert.strictEqual(
            (yield* fs.stat(Vfs.Target.Path({ path: "/link", followFinalSymlink: false }))).kind,
            "file"
          )
          assert.deepStrictEqual(yield* fs.readFile("/target"), new Uint8Array([42]))
          const events = yield* watcher
          assert.strictEqual(events.length, 1)
          const event = events[0]
          assert.isDefined(event)
          assert.strictEqual(event._tag, "Update")
          assert.deepStrictEqual(yield* Vfs.pathToBytes(event.path), new TextEncoder().encode("/link"))
          assert.deepStrictEqual([...(entryNames(yield* fs.readDirectory("/")))].sort(), ["link", "target"])
        }).pipe(Effect.provide(Testing.layer({ volume: { maxEntries: 2, maxBytes: ByteSize.bytes(8) } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should retain linked target charges and metadata when replacement exceeds quota",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          yield* fs.symlink("/", "/a")
          yield* fs.link("/a", "/b")
          const before = yield* fs.stat(Vfs.Target.Path({ path: "/a", followFinalSymlink: false }))
          const root = yield* fs.stat("/")

          const failure = yield* Effect.flip(fs.writeFile("/a", new Uint8Array([1]), {
            access: "write",
            create: "ifMissing",
            truncate: true,
            replaceFinalSymlink: true
          }))

          assert.strictEqual(failure.code, "NoSpace")
          assert.deepStrictEqual(yield* fs.stat(Vfs.Target.Path({ path: "/a", followFinalSymlink: false })), before)
          assert.deepStrictEqual(yield* fs.stat("/"), root)
          assert.strictEqual(text(yield* fs.readLink("/b")), "/")
          yield* fs.unlink("/b")
          yield* fs.writeFile("/a", new Uint8Array([1]), {
            access: "write",
            create: "ifMissing",
            truncate: true,
            replaceFinalSymlink: true
          })
          assert.deepStrictEqual(yield* fs.readFile("/a"), new Uint8Array([1]))
        }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(1) } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should require namespace authority and retain no-follow behavior when replacing a target",
      () =>
        Effect.gen(function*() {
          const root = yield* Vfs.Caller
          yield* root.mkdir("/sticky", { mode: 0o1777 })
          yield* root.chmod("/sticky", 0o1777)
          yield* root.symlink("missing", "/sticky/link")
          const other = yield* Testing.callerAs({ uid: 1, gid: 1, groups: [], privileged: false })
          const options = { access: "write", create: "ifMissing", truncate: true } as const
          assert.strictEqual(
            (yield* Effect.flip(other.writeFile("/sticky/link", new Uint8Array([1]), {
              ...options,
              replaceFinalSymlink: true
            }))).code,
            "NotPermitted"
          )
          assert.strictEqual(
            (yield* Effect.flip(root.writeFile("/sticky/link", new Uint8Array([1]), {
              ...options,
              followFinalSymlink: false
            }))).code,
            "SymlinkLoop"
          )
          assert.strictEqual(text(yield* root.readLink("/sticky/link")), "missing")
        }).pipe(Effect.provide(Testing.layer()))
    )
  })
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should preserve bytes when a replacement requests an unauthorized mode",
      () =>
        Effect.gen(function*() {
          const root = yield* Vfs.Caller
          yield* root.writeFile("/file", new Uint8Array([42]), { access: "write", create: "exclusive" })
          yield* root.chmod("/file", 0o666)
          const before = yield* root.stat("/file")
          const other = yield* Testing.callerAs({ uid: 1, gid: 1, groups: [], privileged: false })
          assert.strictEqual(
            (yield* Effect.flip(other.writeFile("/file", new Uint8Array([9]), {
              access: "write",
              truncate: true,
              finalMode: 0o600
            }))).code,
            "NotPermitted"
          )
          assert.deepStrictEqual(yield* root.stat("/file"), before)
          assert.deepStrictEqual(yield* root.readFile("/file"), new Uint8Array([42]))
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should keep the entry's position when a file replaces a symbolic link",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          yield* fs.symlink("missing", "/link")
          yield* fs.mkdir("/z")
          yield* fs.writeFile("/link", new Uint8Array([1]), {
            access: "write",
            create: "ifMissing",
            truncate: true,
            replaceFinalSymlink: true,
            followFinalSymlink: false
          })
          assert.deepStrictEqual(entryNames(yield* fs.readDirectory("/")), ["link", "z"])
          assert.strictEqual(
            (yield* fs.stat(Vfs.Target.Path({ path: "/link", followFinalSymlink: false }))).kind,
            "file"
          )
        }).pipe(Effect.provide(Testing.layer()))
    )
  })
})

const name = (value: string) => new TextEncoder().encode(value)

interface Pause {
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}

// A staged volume whose paused commit holds the permit until released, so later operations queue behind it.
const pausedVolumeWith = Effect.fnUntraced(function*(options?: Vfs.VolumeOptions) {
  let pause: Pause | undefined
  let outcome: "committed" | "rejected" = "committed"

  const { volume } = yield* makeVolume(VolumeSource.Empty(), options, {
    commit: () =>
      Effect.suspend(() => {
        const paused = pause

        if (paused === undefined) return Effect.succeed(outcome)
        pause = undefined

        return Deferred.succeed(paused.entered, undefined).pipe(
          Effect.andThen(Deferred.await(paused.release)),
          Effect.as("committed" as const)
        )
      })
  })

  const caller = yield* volume.caller()

  // Pauses the next commit, returning the effects that await its start and release it.
  const pauseNext = Effect.gen(function*() {
    const paused: Pause = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
    pause = paused

    return { entered: Deferred.await(paused.entered), release: Deferred.succeed(paused.release, undefined) }
  })

  // Starts a mutation that holds the permit and returns, once it does, the effect that lets it finish.
  const hold = Effect.gen(function*() {
    const { entered, release } = yield* pauseNext
    const holder = yield* caller.mkdir("/held").pipe(Effect.forkChild({ startImmediately: true }))
    yield* entered

    return { finish: Effect.andThen(release, Fiber.join(holder)) }
  })

  const reject = (rejected: boolean) =>
    Effect.sync(() => {
      outcome = rejected ? "rejected" : "committed"
    })

  return { volume, caller, hold, pauseNext, reject }
})

const pausedVolume = pausedVolumeWith()

// A busy volume with an unlinked two-byte file still open, so its release is visible in `usedBytes`.
const busyWithUnlinkedOpen = Effect.fnUntraced(function*(scope: Scope.Scope) {
  const paused = yield* pausedVolumeWith({ maxPendingOperations: 1 })
  yield* paused.caller.writeFile("/file", bytes(1, 2), { access: "write", create: "exclusive" })
  const handle = yield* paused.caller.open("/file", { access: "read" }).pipe(Scope.provide(scope))
  yield* paused.caller.unlink("/file")
  const { finish } = yield* paused.hold
  const waiter = yield* paused.caller.stat("/").pipe(Effect.forkChild({ startImmediately: true }))

  return { ...paused, handle, finish: Effect.andThen(finish, Fiber.join(waiter)) }
})

type Opener = (caller: Vfs.Caller) => Effect.Effect<unknown, Vfs.VfsError, Scope.Scope>

const fileOpeners: ReadonlyArray<readonly [string, Opener]> = [
  ["open", (caller) => caller.open("/file", { access: "read" })],
  ["openReference", (caller) =>
    Effect.gen(function*() {
      const reference = yield* caller.lookup(Vfs.Entry(yield* caller.root, name("file")))

      return yield* caller.open(reference, { access: "read" })
    })],
  ["openChildReference", (caller) =>
    Effect.gen(function*() {
      return yield* caller.open(Vfs.Entry(yield* caller.root, name("file")), { access: "read" })
    })]
]

const directoryOpeners: ReadonlyArray<readonly [string, Opener]> = [
  ["openDirectory", (caller) => caller.openDirectory("/")],
  ["withDirectory", (caller) => caller.withDirectory("/")]
]

describe("handle lifecycles", () => {
  for (const [label, opener] of [...fileOpeners, ...directoryOpeners]) {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        `should interrupt ${label} when its scope closes while acquisition waits`,
        () =>
          Effect.gen(function*() {
            const { caller, hold } = yield* pausedVolume
            yield* caller.writeFile("/file", bytes(1), { access: "write", create: "exclusive" })
            const { finish } = yield* hold
            const scope = yield* Scope.make()

            const opening = yield* opener(caller).pipe(
              Scope.provide(scope),
              Effect.forkChild({ startImmediately: true })
            )

            yield* Effect.yieldNow
            // A directory finalizer takes the permit, so closing waits behind the held commit.
            const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild({ startImmediately: true }))
            yield* finish
            yield* Fiber.join(closing)
            const result = yield* Fiber.await(opening)
            assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause))
          })
      )
    })
  }

  for (const [label, opener] of fileOpeners) {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        `should release unlinked content when ${label} loses its scope or fiber while waiting`,
        () =>
          Effect.gen(function*() {
            const { volume, caller, hold } = yield* pausedVolume
            yield* caller.writeFile("/file", bytes(1, 2), { access: "write", create: "exclusive" })
            const { finish } = yield* hold
            const scope = yield* Scope.make()

            const closed = yield* opener(caller).pipe(
              Scope.provide(scope),
              Effect.forkChild({ startImmediately: true })
            )

            const interrupted = yield* opener(caller).pipe(Effect.scoped, Effect.forkChild({ startImmediately: true }))
            yield* Effect.yieldNow
            yield* Scope.close(scope, Exit.void)
            yield* Fiber.interrupt(interrupted)
            yield* finish
            yield* Fiber.await(closed)
            yield* caller.unlink("/file")
            assert.strictEqual((yield* volume.usage).usedBytes, 0n)
          })
      )
    })
  }

  for (const [label, opener] of fileOpeners) {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        `should release acquired resources when ${label} scope closes during acquisition`,
        () =>
          Effect.gen(function*() {
            const volume = yield* Vfs.Volume
            const caller = yield* Vfs.Caller
            yield* caller.writeFile("/file", bytes(1, 2), { access: "write", create: "exclusive" })

            // Each attempt closes the scope a few more yields in, sweeping the close across the acquisition.
            for (let delay = 0; delay < 64; delay++) {
              const scope = yield* Scope.make()

              yield* Effect.all([
                opener(caller).pipe(Scope.provide(scope), Effect.exit),
                Effect.andThen(Effect.repeat(Effect.yieldNow, { times: delay }), Scope.close(scope, Exit.void))
              ], { concurrency: "unbounded" })
            }

            yield* caller.unlink("/file")
            assert.deepStrictEqual(yield* volume.usage, { usedBytes: 0n, entries: 0 })
          }).pipe(Effect.provide(Testing.layer()), Effect.provideService(Scheduler.MaxOpsBeforeYield, 3))
      )
    })
  }

  for (const [label, opener] of fileOpeners) {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        `should interrupt ${label} and release resources when its scope closes during a pending commit`,
        () =>
          Effect.gen(function*() {
            const { volume, caller, pauseNext } = yield* pausedVolume
            yield* caller.writeFile("/file", bytes(1, 2), { access: "write", create: "exclusive" })
            const { entered, release } = yield* pauseNext
            const scope = yield* Scope.make()

            const opening = yield* opener(caller).pipe(
              Scope.provide(scope),
              Effect.forkChild({ startImmediately: true })
            )

            yield* entered
            yield* Scope.close(scope, Exit.void)
            yield* release
            const result = yield* Fiber.await(opening)
            assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause))
            yield* caller.unlink("/file")
            assert.strictEqual((yield* volume.usage).usedBytes, 0n)
          })
      )
    })
  }

  for (const [label, opener] of fileOpeners) {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        `should release resources when ${label} scope and fiber close during its pending commit`,
        () =>
          Effect.gen(function*() {
            const { volume, caller, pauseNext } = yield* pausedVolume
            yield* caller.writeFile("/file", bytes(1, 2), { access: "write", create: "exclusive" })
            const { entered, release } = yield* pauseNext
            const scope = yield* Scope.make()

            const opening = yield* opener(caller).pipe(
              Scope.provide(scope),
              Effect.forkChild({ startImmediately: true })
            )

            yield* entered
            yield* Scope.close(scope, Exit.void)
            // The commit is uninterruptible, so the interrupt stays pending until it publishes.
            const interrupting = yield* Fiber.interrupt(opening).pipe(Effect.forkChild({ startImmediately: true }))
            yield* release
            yield* Fiber.join(interrupting)
            yield* caller.unlink("/file")
            assert.strictEqual((yield* volume.usage).usedBytes, 0n)
          })
      )
    })
  }

  for (const kind of ["file", "directory"] as const) {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        `should leave the handle open when an explicit ${kind} close is interrupted while waiting`,
        () =>
          Effect.gen(function*() {
            const { caller, hold } = yield* pausedVolume

            const handle = kind === "file"
              ? yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
              : yield* caller.openDirectory("/")

            const { finish } = yield* hold
            const closing = yield* handle.close.pipe(Effect.forkChild({ startImmediately: true }))
            // Returns only once the waiting close has stopped, which must not wait for the held commit.
            yield* Fiber.interrupt(closing)
            yield* finish
            yield* handle.stat
            yield* handle.close
          })
      )
    })
  }

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should avoid creating a file when an exclusive open loses its scope while waiting",
      () =>
        Effect.gen(function*() {
          const { caller, hold } = yield* pausedVolume
          const { finish } = yield* hold
          const scope = yield* Scope.make()

          const opening = yield* caller.open("/new", { access: "write", create: "exclusive" }).pipe(
            Scope.provide(scope),
            Effect.forkChild({ startImmediately: true })
          )

          yield* Effect.yieldNow
          yield* Scope.close(scope, Exit.void)
          yield* finish
          yield* Fiber.await(opening)
          assert.strictEqual((yield* Effect.flip(caller.stat("/new"))).code, "NotFound")
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should preserve the cursor when a durable write is rejected",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const { caller, reject } = yield* pausedVolume
          const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
          yield* handle.write(bytes(1))
          yield* reject(true)
          assert.strictEqual((yield* Effect.flip(handle.write(bytes(2)))).code, "StorageRejected")
          yield* reject(false)
          yield* handle.write(bytes(3))
          assert.deepStrictEqual(yield* caller.readFile("/file"), bytes(1, 3))
        }))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should keep a file open for retry when explicit close is refused as busy",
      () =>
        Effect.gen(function*() {
          const { volume, handle, finish } = yield* busyWithUnlinkedOpen(yield* Effect.scope)
          const refused = yield* Effect.flip(handle.close).pipe(Effect.forkChild({ startImmediately: true }))
          yield* finish
          assert.strictEqual((yield* Fiber.join(refused)).code, "VolumeBusy")
          assert.strictEqual((yield* volume.usage).usedBytes, 2n)
          yield* handle.close
          assert.strictEqual((yield* volume.usage).usedBytes, 0n)
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should release a file when its scope closes while the volume is busy", () =>
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const { volume, finish } = yield* busyWithUnlinkedOpen(scope)
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild({ startImmediately: true }))
        yield* finish
        yield* Fiber.join(closing)
        assert.strictEqual((yield* volume.usage).usedBytes, 0n)
      }))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should release a file when its scope close is interrupted while waiting",
      () =>
        Effect.gen(function*() {
          const scope = yield* Scope.make()
          const { volume, finish } = yield* busyWithUnlinkedOpen(scope)
          const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild({ startImmediately: true }))
          // Cleanup is uninterruptible, so the interrupt returns only once the release has run after the hold.
          const interrupting = yield* Fiber.interrupt(closing).pipe(Effect.forkChild({ startImmediately: true }))
          yield* finish
          yield* Fiber.join(interrupting)
          assert.strictEqual((yield* volume.usage).usedBytes, 0n)
        })
    )
  })
})
