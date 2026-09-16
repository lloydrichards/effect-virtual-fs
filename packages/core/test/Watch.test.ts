import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Predicate, Scope, Stream } from "effect"
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

      if (Predicate.isTagged("None")(event)) return
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

  it.effect("reports every hard link path when a file's metadata changes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      yield* caller.mkdir("/dir")
      yield* caller.writeFile("/dir/original", new Uint8Array([1]), { access: "write", create: "ifMissing" })
      yield* caller.link("/dir/original", "/alias")

      const stream = yield* volume.watch

      const watcher = yield* Stream.runCollect(Stream.take(stream, 2)).pipe(
        Effect.forkChild({ startImmediately: true })
      )

      yield* caller.chmod("/dir/original", 0o600)

      const events = yield* Fiber.join(watcher)
      const paths: Array<string> = []

      for (const event of events) {
        assert.strictEqual(event._tag, "Update")
        paths.push(new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
      }

      assert.deepStrictEqual(paths.sort(), ["/alias", "/dir/original"])
    }))

  it.effect("reports a nested directory's own path when its metadata changes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      yield* caller.mkdir("/parent")
      yield* caller.mkdir("/parent/child")

      const stream = yield* volume.watch

      const watcher = yield* Stream.runCollect(Stream.take(stream, 1)).pipe(
        Effect.forkChild({ startImmediately: true })
      )

      yield* caller.chmod("/parent/child", 0o700)

      const events = yield* Fiber.join(watcher)
      const paths: Array<string> = []

      for (const event of events) paths.push(new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))

      assert.deepStrictEqual(paths, ["/parent/child"])
    }))
})
