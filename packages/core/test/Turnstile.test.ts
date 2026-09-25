import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Exit, Fiber, Stream } from "effect"
import { LiveVolume } from "../src/index.js"

const MAX_IMAGE_BYTES = ByteSize.kilobytes(256)

interface Pause {
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}

// A live volume whose next commit waits until the test releases it.
const pausable = Effect.gen(function*() {
  let pending: Pause | undefined
  const image = yield* LiveVolume.prepareEmptyImage()

  const session = yield* LiveVolume.openImage(image, MAX_IMAGE_BYTES, () =>
    Effect.suspend(() => {
      const pause = pending

      if (pause === undefined) return Effect.succeed("committed" as const)
      pending = undefined

      return Deferred.succeed(pause.entered, undefined).pipe(
        Effect.andThen(Deferred.await(pause.release)),
        Effect.as("committed" as const)
      )
    }))

  const pauseNext = Effect.gen(function*() {
    const pause: Pause = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
    pending = pause

    return { entered: Deferred.await(pause.entered), release: Deferred.succeed(pause.release, undefined) }
  })

  return { caller: yield* session.volume.caller(), pauseNext, volume: session.volume }
})

describe("the change turnstile", () => {
  it.effect("keeps a queued change ahead of a watcher reacting to the change before it", () =>
    Effect.gen(function*() {
      const { caller, pauseNext, volume } = yield* pausable
      const events = yield* volume.watch

      // The watcher wakes while the first change still holds every permit, and stats what the second creates.
      const watcher = yield* events.pipe(
        Stream.take(1),
        Stream.runDrain,
        Effect.andThen(Effect.exit(caller.stat("/y"))),
        Effect.forkChild({ startImmediately: true })
      )

      const pause = yield* pauseNext
      const first = yield* caller.mkdir("/x").pipe(Effect.forkChild({ startImmediately: true }))
      yield* pause.entered
      const second = yield* caller.mkdir("/y").pipe(Effect.forkChild({ startImmediately: true }))

      for (let i = 0; i < 4; i++) yield* Effect.yieldNow
      assert.isUndefined(second.pollUnsafe())
      yield* pause.release
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(watcher)))
    }))

  it.effect("passes the turn on when a waiter is interrupted", () =>
    Effect.gen(function*() {
      const { caller, pauseNext } = yield* pausable
      const pause = yield* pauseNext
      const first = yield* caller.mkdir("/x").pipe(Effect.forkChild({ startImmediately: true }))
      yield* pause.entered
      const abandoned = yield* caller.mkdir("/gone").pipe(Effect.forkChild({ startImmediately: true }))
      const later = yield* caller.mkdir("/z").pipe(Effect.forkChild({ startImmediately: true }))

      for (let i = 0; i < 4; i++) yield* Effect.yieldNow
      yield* Fiber.interrupt(abandoned)
      yield* pause.release
      yield* Fiber.join(first)
      yield* Fiber.join(later)

      assert.strictEqual((yield* caller.stat("/z")).kind, "directory")
      assert.isTrue(Exit.isFailure(yield* Effect.exit(caller.stat("/gone"))))
    }))
})
