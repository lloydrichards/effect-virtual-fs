import { assert, describe } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Scheduler, Scope } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import { makeVolume, VolumeSource } from "../src/internal/virtualFileSystem.js"
import { it } from "./TestEffect.js"

const bytes = (...values: Array<number>) => new Uint8Array(values)

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

type Opener = (caller: Vfs.Caller) => Effect.Effect<unknown, Vfs.FsError, Scope.Scope>

const fileOpeners: ReadonlyArray<readonly [string, Opener]> = [
  ["open", (caller) => caller.open("/file", { access: "read" })],
  ["openReference", (caller) =>
    Effect.gen(function*() {
      const reference = yield* caller.lookupReference(yield* caller.rootReference, name("file"))

      return yield* caller.openReference(reference)
    })],
  ["openChildReference", (caller) =>
    Effect.gen(function*() {
      return yield* caller.openChildReference(yield* caller.rootReference, name("file"), { access: "read" })
    })]
]

const directoryOpeners: ReadonlyArray<readonly [string, Opener]> = [
  ["openDirectory", (caller) => caller.openDirectory("/")],
  ["withDirectory", (caller) => caller.withDirectory("/")]
]

describe("handle lifecycles", () => {
  for (const [label, opener] of [...fileOpeners, ...directoryOpeners]) {
    it.effect(`${label} is interrupted when its scope closes while it waits`, () =>
      Effect.gen(function*() {
        const { caller, hold } = yield* pausedVolume
        yield* caller.writeFile("/file", bytes(1), { access: "write", create: "exclusive" })
        const { finish } = yield* hold
        const scope = yield* Scope.make()
        const opening = yield* opener(caller).pipe(Scope.provide(scope), Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        // A directory finalizer takes the permit, so closing waits behind the held commit.
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild({ startImmediately: true }))
        yield* finish
        yield* Fiber.join(closing)
        const result = yield* Fiber.await(opening)
        assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause))
      }))
  }

  for (const [label, opener] of fileOpeners) {
    it.effect(`${label} retains no unlinked content after losing its scope or its fiber while waiting`, () =>
      Effect.gen(function*() {
        const { volume, caller, hold } = yield* pausedVolume
        yield* caller.writeFile("/file", bytes(1, 2), { access: "write", create: "exclusive" })
        const { finish } = yield* hold
        const scope = yield* Scope.make()
        const closed = yield* opener(caller).pipe(Scope.provide(scope), Effect.forkChild({ startImmediately: true }))
        const interrupted = yield* opener(caller).pipe(Effect.scoped, Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* Scope.close(scope, Exit.void)
        yield* Fiber.interrupt(interrupted)
        yield* finish
        yield* Fiber.await(closed)
        yield* caller.unlink("/file")
        assert.strictEqual((yield* volume.usage).usedBytes, 0n)
      }))
  }

  for (const [label, opener] of fileOpeners) {
    it.effect(`${label} releases what it acquired when its scope closes during acquisition`, () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const caller = yield* volume.caller()
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
      }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3)))
  }

  for (const [label, opener] of fileOpeners) {
    it.effect(`${label} is interrupted and retains nothing when its scope closes while its own commit is pending`, () =>
      Effect.gen(function*() {
        const { volume, caller, pauseNext } = yield* pausedVolume
        yield* caller.writeFile("/file", bytes(1, 2), { access: "write", create: "exclusive" })
        const { entered, release } = yield* pauseNext
        const scope = yield* Scope.make()
        const opening = yield* opener(caller).pipe(Scope.provide(scope), Effect.forkChild({ startImmediately: true }))
        yield* entered
        yield* Scope.close(scope, Exit.void)
        yield* release
        const result = yield* Fiber.await(opening)
        assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause))
        yield* caller.unlink("/file")
        assert.strictEqual((yield* volume.usage).usedBytes, 0n)
      }))
  }

  for (const [label, opener] of fileOpeners) {
    it.effect(`${label} retains nothing when its scope closes and its fiber is interrupted during its own commit`, () =>
      Effect.gen(function*() {
        const { volume, caller, pauseNext } = yield* pausedVolume
        yield* caller.writeFile("/file", bytes(1, 2), { access: "write", create: "exclusive" })
        const { entered, release } = yield* pauseNext
        const scope = yield* Scope.make()
        const opening = yield* opener(caller).pipe(Scope.provide(scope), Effect.forkChild({ startImmediately: true }))
        yield* entered
        yield* Scope.close(scope, Exit.void)
        // The commit is uninterruptible, so the interrupt stays pending until it publishes.
        const interrupting = yield* Fiber.interrupt(opening).pipe(Effect.forkChild({ startImmediately: true }))
        yield* release
        yield* Fiber.join(interrupting)
        yield* caller.unlink("/file")
        assert.strictEqual((yield* volume.usage).usedBytes, 0n)
      }))
  }

  for (const kind of ["file", "directory"] as const) {
    it.effect(`an interrupted explicit ${kind} close that waits leaves the handle open`, () =>
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
      }))
  }

  it.effect("does not create a file for an exclusive open whose scope closes while it waits", () =>
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
    }))

  it.effect("keeps the cursor in place when a durable write is rejected", () =>
    Effect.scoped(Effect.gen(function*() {
      const { caller, reject } = yield* pausedVolume
      const handle = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
      yield* handle.write(bytes(1))
      yield* reject(true)
      assert.strictEqual((yield* Effect.flip(handle.write(bytes(2)))).code, "StorageRejected")
      yield* reject(false)
      yield* handle.write(bytes(3))
      assert.deepStrictEqual(yield* caller.readFile("/file"), bytes(1, 3))
    })))

  it.effect("keeps a file open for a retry when its explicit close is refused as busy", () =>
    Effect.gen(function*() {
      const { volume, handle, finish } = yield* busyWithUnlinkedOpen(yield* Effect.scope)
      const refused = yield* Effect.flip(handle.close).pipe(Effect.forkChild({ startImmediately: true }))
      yield* finish
      assert.strictEqual((yield* Fiber.join(refused)).code, "VolumeBusy")
      assert.strictEqual((yield* volume.usage).usedBytes, 2n)
      yield* handle.close
      assert.strictEqual((yield* volume.usage).usedBytes, 0n)
    }))

  it.effect("releases a file whose scope closes while the volume is busy", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const { volume, finish } = yield* busyWithUnlinkedOpen(scope)
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild({ startImmediately: true }))
      yield* finish
      yield* Fiber.join(closing)
      assert.strictEqual((yield* volume.usage).usedBytes, 0n)
    }))

  it.effect("releases a file whose scope close is interrupted while it waits", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const { volume, finish } = yield* busyWithUnlinkedOpen(scope)
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild({ startImmediately: true }))
      // Cleanup is uninterruptible, so the interrupt returns only once the release has run after the hold.
      const interrupting = yield* Fiber.interrupt(closing).pipe(Effect.forkChild({ startImmediately: true }))
      yield* finish
      yield* Fiber.join(interrupting)
      assert.strictEqual((yield* volume.usage).usedBytes, 0n)
    }))
})
