import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import { setRegistrationHook } from "../src/internal/virtualFileSystem/testHooks.js"

describe("volume watch", () => {
  it.effect("does not lose a change while a watcher is registering", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      const subscribed = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const clearHook = setRegistrationHook(volume, {
        afterSubscribe: Deferred.succeed(subscribed, undefined).pipe(Effect.andThen(Deferred.await(release)))
      })
      yield* Effect.addFinalizer(() => Effect.sync(clearHook))

      const watcher = yield* volume.watch.pipe(
        Effect.flatMap(Stream.runHead),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(subscribed)
      const mutation = yield* caller.mkdir("/during-registration").pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.succeed(release, undefined)

      yield* Fiber.join(mutation)
      const event = yield* Fiber.join(watcher)
      assert.strictEqual(event._tag, "Some")
      if (event._tag === "None") return
      assert.strictEqual(event.value._tag, "Create")
      assert.deepStrictEqual(
        yield* Vfs.pathToBytes(event.value.path),
        new TextEncoder().encode("/during-registration")
      )
    }))

  it.effect("does not deadlock when registration uses an already-closed scope", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const scope = yield* Scope.make()
      yield* Scope.close(scope, Exit.void)
      const stream = yield* volume.watch.pipe(Scope.provide(scope))
      assert.isDefined(stream)
    }))
})
