import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, PubSub, Queue, Scope, Stream } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { withVolumeTestSeams } from "../src/internal/testSeams.js"
import { entryNames } from "./support/text.js"

const paths = (events: Iterable<Vfs.Change>) =>
  Effect.forEach(events, (event) =>
    Vfs.pathToBytes(event.path).pipe(
      Effect.map((bytes) => `${event._tag} ${new TextDecoder().decode(bytes)}`)
    ))

describe("bounded watches", () => {
  it.effect("rejects excess admission before mutation and releases cancelled waits", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      const registered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const afterSubscribe = Deferred.succeed(registered, undefined).pipe(Effect.andThen(Deferred.await(release)))

      const watching = yield* volume.watch().pipe(
        withVolumeTestSeams({ afterSubscribe }),
        Effect.forkChild({ startImmediately: true })
      )

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
      assert.deepEqual(entryNames(yield* caller.readDirectory("/")), ["accepted"])
    }).pipe(Effect.provide(Testing.layer({ volume: { maxPendingOperations: 1 } }))))

  it.effect("releases admission when a watch is cancelled while waiting for the permit", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      const registered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const afterSubscribe = Deferred.succeed(registered, undefined).pipe(Effect.andThen(Deferred.await(release)))

      const holding = yield* volume.watch().pipe(
        withVolumeTestSeams({ afterSubscribe }),
        Effect.forkChild({ startImmediately: true })
      )

      yield* Deferred.await(registered)

      const cancelled = yield* volume.watch().pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(cancelled)

      const mutation = yield* caller.mkdir("/after-cancel").pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      const activeWatch = yield* Fiber.join(holding)
      assert.isDefined(activeWatch)
      yield* Fiber.join(mutation)
      assert.deepEqual(entryNames(yield* caller.readDirectory("/")), ["after-cancel"])
    }).pipe(Effect.provide(Testing.layer({ volume: { maxPendingOperations: 1 } }))))

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
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      const slowScope = yield* Scope.make()
      const fastScope = yield* Scope.make()
      const slow = yield* volume.watch().pipe(Scope.provide(slowScope))
      const fast = yield* volume.watch().pipe(Scope.provide(fastScope))
      const received = yield* Queue.bounded<void>(4)

      const fastConsumer = yield* Testing.collectChanges(Stream.tap(fast, () => Queue.offer(received, undefined)), 4)

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
      const fastEvents = yield* fastConsumer
      assert.deepEqual(Array.from(fastEvents, (event) => event._tag), ["Create", "Create", "Create", "Create"])
      const rescanScope = yield* Scope.make()
      const rescanWatch = yield* volume.watch().pipe(Scope.provide(rescanScope))
      const before = entryNames(yield* caller.readDirectory("/"))
      yield* caller.mkdir("/during-rescan")
      const during = yield* Stream.runHead(rescanWatch)

      const event = Option.getOrThrow(during)
      assert.strictEqual(event._tag, "Create")
      assert.deepEqual(yield* Vfs.pathToBytes(event.path), new TextEncoder().encode("/during-rescan"))

      assert.isFalse(before.includes("during-rescan"))
      assert.isTrue((entryNames(yield* caller.readDirectory("/"))).includes("during-rescan"))
      yield* caller.mkdir("/after")
      assert.deepEqual(entryNames(yield* caller.readDirectory("/")), ["a", "b", "c", "d", "during-rescan", "after"])
      yield* Scope.close(slowScope, Exit.void)
      yield* Scope.close(fastScope, Exit.void)
      yield* Scope.close(rescanScope, Exit.void)
    }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 3 } }))))

  it.effect("drops changes after the overflow marker until the consumer takes it, then resumes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      const stream = yield* volume.watch()

      yield* caller.mkdir("/a")
      yield* caller.mkdir("/b")
      yield* caller.mkdir("/c")
      yield* caller.mkdir("/d")
      assert.deepEqual(yield* paths(yield* Stream.runCollect(Stream.take(stream, 1))), ["Create /a"])
      yield* caller.mkdir("/e")
      assert.deepEqual(yield* paths(yield* Stream.runCollect(Stream.take(stream, 2))), ["Create /b", "Rescan /"])
      yield* caller.mkdir("/f")
      assert.deepEqual(yield* paths(yield* Stream.runCollect(Stream.take(stream, 1))), ["Create /f"])
    }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 3 } }))))

  it.effect("does not overflow a scoped subscriber with changes outside its scope", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/watched")
      yield* caller.mkdir("/busy")
      const everything = yield* volume.watch()
      const scoped = yield* volume.watch({ scope: yield* caller.lookup("/watched") })

      for (const name of ["a", "b", "c", "d", "e"]) yield* caller.mkdir(`/busy/${name}`)
      yield* caller.mkdir("/watched/child")

      assert.deepEqual(yield* paths(yield* Stream.runCollect(Stream.take(everything, 3))), [
        "Create /busy/a",
        "Create /busy/b",
        "Rescan /"
      ])
      assert.deepEqual(yield* paths(yield* Stream.runCollect(Stream.take(scoped, 1))), ["Create /watched/child"])
    }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 3 } }))))

  it.effect("names the scope's current path in a scoped subscriber's Rescan", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/watched")
      const scoped = yield* volume.watch({ scope: yield* caller.lookup("/watched") })

      yield* caller.rename("/watched", "/moved")
      yield* caller.mkdir("/moved/a")
      yield* caller.mkdir("/moved/b")

      assert.deepEqual(yield* paths(yield* Stream.runCollect(Stream.take(scoped, 3))), [
        "Remove /watched",
        "Create /moved",
        "Rescan /moved"
      ])
    }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 3 } }))))

  it.effect("reports the scope's removal and ends when the removal reaches the queue's last slot", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/watched")
      const scoped = yield* volume.watch({ scope: yield* caller.lookup("/watched") })

      yield* caller.mkdir("/watched/a")
      yield* caller.rmdir("/watched/a")
      yield* caller.rmdir("/watched")

      assert.deepEqual(yield* paths(yield* Stream.runCollect(scoped)), [
        "Create /watched/a",
        "Remove /watched/a",
        "Remove /watched"
      ])
    }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 3 } }))))

  it.effect("reports the scope's removal and ends when a rename replaces it at the queue's last slot", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.writeFile("/target", new Uint8Array([1]), { access: "write", create: "exclusive" })
      yield* caller.writeFile("/replacement", new Uint8Array([2]), { access: "write", create: "exclusive" })
      const scoped = yield* volume.watch({ scope: yield* caller.lookup("/target") })

      yield* caller.chmod("/target", 0o600)
      yield* caller.rename("/replacement", "/target")

      assert.deepEqual(yield* paths(yield* Stream.runCollect(scoped)), ["Update /target", "Remove /target"])
    }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 2 } }))))
})
