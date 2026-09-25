import { assert, describe } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import type { VirtualFileSystem as Vfs } from "../src/index.js"
import { makeVolume, VolumeSource } from "../src/internal/virtualFileSystem.js"
import { it } from "./TestEffect.js"

const bytes = (...values: Array<number>) => new Uint8Array(values)

const name = (value: string) => new TextEncoder().encode(value)

// A staged volume whose next commit holds the permit until released, so later operations queue behind it.
const pausedVolume = Effect.gen(function*() {
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  let pause = false
  let outcome: "committed" | "rejected" = "committed"

  const { volume } = yield* makeVolume(VolumeSource.Empty(), undefined, {
    commit: () =>
      pause
        ? Effect.sync(() => {
          pause = false
        }).pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Deferred.await(release)),
          Effect.as("committed" as const)
        )
        : Effect.succeed(outcome)
  })

  const caller = yield* volume.caller()

  // Starts a mutation that holds the permit and returns, once it does, the effect that lets it finish.
  const hold = Effect.gen(function*() {
    pause = true
    const holder = yield* caller.mkdir("/held").pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(entered)

    return { finish: Effect.andThen(Deferred.succeed(release, undefined), Fiber.join(holder)) }
  })

  const reject = (rejected: boolean) =>
    Effect.sync(() => {
      outcome = rejected ? "rejected" : "committed"
    })

  return { volume, caller, hold, reject }
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

describe("handle lifecycles", () => {
  for (const [label, opener] of fileOpeners) {
    it.effect(`${label} is interrupted when its scope closes while it waits`, () =>
      Effect.gen(function*() {
        const { caller, hold } = yield* pausedVolume
        yield* caller.writeFile("/file", bytes(1), { access: "write", create: "exclusive" })
        const { finish } = yield* hold
        const scope = yield* Scope.make()
        const opening = yield* opener(caller).pipe(Scope.provide(scope), Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* Scope.close(scope, Exit.void)
        yield* finish
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
})
