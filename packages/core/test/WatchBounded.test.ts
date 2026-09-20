import { assert, describe } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, PubSub, Queue, Scope, Stream } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import { setRegistrationHook } from "../src/internal/virtualFileSystem/testHooks.js"
import { it } from "./TestEffect.js"

describe("bounded watches", () => {
  it.effect("rejects excess admission before mutation and releases cancelled waits", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make({ maxPendingOperations: 1 })
      const caller = yield* volume.caller()
      const registered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const clear = setRegistrationHook(volume, {
        afterSubscribe: Deferred.succeed(registered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      })

      yield* Effect.addFinalizer(() => Effect.sync(clear))
      const watching = yield* volume.watch.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(registered)
      const waiting = yield* caller.mkdir("/cancelled").pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      const busy = yield* Effect.flip(caller.mkdir("/rejected"))
      assert.strictEqual(busy.code, "VolumeBusy")
      yield* Fiber.interrupt(waiting)

      const accepted = yield* caller.mkdir("/accepted").pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      const registeredWatch = yield* Fiber.join(watching)
      assert.isDefined(registeredWatch)
      yield* Fiber.join(accepted)
      assert.deepEqual(Array.from(yield* caller.readDirectory("/")), ["accepted"])
    }))

  it.effect("releases admission when a watch is cancelled while waiting for the permit", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make({ maxPendingOperations: 1 })
      const caller = yield* volume.caller()
      const registered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const clear = setRegistrationHook(volume, {
        afterSubscribe: Deferred.succeed(registered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      })

      yield* Effect.addFinalizer(() => Effect.sync(clear))
      const holding = yield* volume.watch.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(registered)

      const cancelled = yield* volume.watch.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(cancelled)

      const mutation = yield* caller.mkdir("/after-cancel").pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      const activeWatch = yield* Fiber.join(holding)
      assert.isDefined(activeWatch)
      yield* Fiber.join(mutation)
      assert.deepEqual(Array.from(yield* caller.readDirectory("/")), ["after-cancel"])
    }))

  it.effect("probes unsafe PubSub publication with a stalled and an active subscriber", () =>
    Effect.gen(function*() {
      const hub = yield* PubSub.bounded<number>(2)
      const slow = yield* PubSub.subscribe(hub)
      const fast = yield* PubSub.subscribe(hub)
      assert.isTrue(PubSub.publishUnsafe(hub, 1))
      assert.deepEqual(yield* PubSub.take(fast), 1)
      assert.isTrue(PubSub.publishUnsafe(hub, 2))
      assert.deepEqual(yield* PubSub.take(fast), 2)
      assert.isFalse(PubSub.publishUnsafe(hub, 3))
      assert.deepEqual(yield* PubSub.take(slow), 1)
    }))

  it.effect("signals overflow independently for each subscriber and permits more writes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make({ maxWatchEvents: 3 })
      const caller = yield* volume.caller()
      const slowScope = yield* Scope.make()
      const fastScope = yield* Scope.make()
      const slow = yield* volume.watch.pipe(Scope.provide(slowScope))
      const fast = yield* volume.watch.pipe(Scope.provide(fastScope))
      const received = yield* Queue.bounded<void>(4)

      const fastConsumer = yield* Stream.runCollect(
        Stream.take(Stream.tap(fast, () => Queue.offer(received, undefined)), 4)
      ).pipe(
        Effect.forkChild({ startImmediately: true })
      )

      yield* caller.mkdir("/a")
      yield* Queue.take(received)
      yield* caller.mkdir("/b")
      yield* Queue.take(received)
      yield* caller.mkdir("/c")
      yield* Queue.take(received)
      yield* caller.mkdir("/d")
      yield* Queue.take(received)
      const slowEvents = yield* Stream.runCollect(Stream.take(slow, 3))
      assert.deepEqual(Array.from(slowEvents, (event) => event._tag), ["Create", "Create", "Rescan"])
      const fastEvents = yield* Fiber.join(fastConsumer)
      assert.deepEqual(Array.from(fastEvents, (event) => event._tag), ["Create", "Create", "Create", "Create"])
      const rescanScope = yield* Scope.make()
      const rescanWatch = yield* volume.watch.pipe(Scope.provide(rescanScope))
      const before = Array.from(yield* caller.readDirectory("/"))
      yield* caller.mkdir("/during-rescan")
      const during = yield* Stream.runHead(rescanWatch)

      const event = Option.getOrThrow(during)
      assert.strictEqual(event._tag, "Create")
      assert.deepEqual(yield* Vfs.pathToBytes(event.path), new TextEncoder().encode("/during-rescan"))

      assert.isFalse(before.includes("during-rescan"))
      assert.isTrue(Array.from(yield* caller.readDirectory("/")).includes("during-rescan"))
      yield* caller.mkdir("/after")
      assert.deepEqual(Array.from(yield* caller.readDirectory("/")), ["a", "b", "c", "d", "during-rescan", "after"])
      yield* Scope.close(slowScope, Exit.void)
      yield* Scope.close(fastScope, Exit.void)
      yield* Scope.close(rescanScope, Exit.void)
    }))
})
