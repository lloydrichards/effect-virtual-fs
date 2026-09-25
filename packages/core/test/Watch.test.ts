import { assert, describe } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Predicate, Scope, Stream } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import { withVolumeTestSeams } from "../src/internal/testSeams.js"

import { it } from "./TestEffect.js"

describe("volume watch", () => {
  it.effect("publishes one Create event for a child with initial size", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      const stream = yield* volume.watch

      const watcher = yield* Stream.runCollect(Stream.take(stream, 2)).pipe(
        Effect.forkChild({ startImmediately: true })
      )

      const opened = yield* caller.openChildReference(
        yield* caller.rootReference,
        new TextEncoder().encode("sized"),
        { access: "read", create: "exclusive", initialSize: 3n }
      )

      yield* opened.handle.close
      yield* caller.mkdir("/sentinel")

      const events = yield* Fiber.join(watcher)
      const changes: Array<string> = []

      for (const event of events) {
        changes.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
      }

      assert.deepStrictEqual(changes, ["Create /sized", "Create /sentinel"])
    }))

  it.effect("does not lose a change while a watcher is registering", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      const subscribed = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const afterSubscribe = Deferred.succeed(subscribed, undefined).pipe(Effect.andThen(Deferred.await(release)))

      const watcher = yield* volume.watch.pipe(
        withVolumeTestSeams({ afterSubscribe }),
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

  it.effect(
    "stays silent when a removed directory's metadata changes through an open handle",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const caller = yield* volume.caller()
        yield* caller.mkdir("/parent")
        yield* caller.mkdir("/parent/child")
        const removed = yield* caller.openDirectory("/parent/child")
        yield* caller.rmdir("/parent/child")

        const stream = yield* volume.watch

        const watcher = yield* Stream.runCollect(Stream.take(stream, 1)).pipe(
          Effect.forkChild({ startImmediately: true })
        )

        yield* caller.chmodHandle(removed, 0o700)
        yield* caller.mkdir("/sentinel")

        const events = yield* Fiber.join(watcher)
        const paths: Array<string> = []

        for (const event of events) {
          paths.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
        }

        assert.deepStrictEqual(paths, ["Create /sentinel"])
      })
  )

  it.effect(
    "stays silent when a rename-displaced directory's metadata changes through an open handle",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const caller = yield* volume.caller()
        yield* caller.mkdir("/source")
        yield* caller.mkdir("/target")
        const displaced = yield* caller.openDirectory("/target")
        yield* caller.rename("/source", "/target")

        const stream = yield* volume.watch

        const watcher = yield* Stream.runCollect(Stream.take(stream, 1)).pipe(
          Effect.forkChild({ startImmediately: true })
        )

        yield* caller.utimesHandle(displaced, { access: { kind: "now" }, modification: { kind: "now" } })
        yield* caller.mkdir("/sentinel")

        const events = yield* Fiber.join(watcher)
        const paths: Array<string> = []

        for (const event of events) {
          paths.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
        }

        assert.deepStrictEqual(paths, ["Create /sentinel"])
      })
  )

  it.effect("reports the root path when the root directory's own metadata changes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()

      const stream = yield* volume.watch

      const watcher = yield* Stream.runCollect(Stream.take(stream, 1)).pipe(
        Effect.forkChild({ startImmediately: true })
      )

      yield* caller.chmod("/", 0o700)
      yield* caller.mkdir("/sentinel")

      const events = yield* Fiber.join(watcher)
      const paths: Array<string> = []

      for (const event of events) {
        paths.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
      }

      assert.deepStrictEqual(paths, ["Update /"])
    }))

  it.effect(
    "reports the new path when a moved directory's metadata changes through an open handle",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const caller = yield* volume.caller()
        yield* caller.mkdir("/origin")
        yield* caller.mkdir("/origin/moved")
        yield* caller.mkdir("/destination")
        const moved = yield* caller.openDirectory("/origin/moved")
        yield* caller.rename("/origin/moved", "/destination/moved")

        const stream = yield* volume.watch

        const watcher = yield* Stream.runCollect(Stream.take(stream, 1)).pipe(
          Effect.forkChild({ startImmediately: true })
        )

        yield* caller.chmodHandle(moved, 0o700)

        const events = yield* Fiber.join(watcher)
        const paths: Array<string> = []

        for (const event of events) {
          paths.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
        }

        assert.deepStrictEqual(paths, ["Update /destination/moved"])
      })
  )

  it.effect(
    "stays silent when an unlinked file's metadata changes through an open handle",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const caller = yield* volume.caller()
        yield* caller.writeFile("/orphan", new Uint8Array([1]), { access: "write", create: "ifMissing" })
        const handle = yield* caller.open("/orphan", { access: "read" })
        yield* caller.unlink("/orphan")

        const stream = yield* volume.watch

        const watcher = yield* Stream.runCollect(Stream.take(stream, 1)).pipe(
          Effect.forkChild({ startImmediately: true })
        )

        yield* caller.chmodHandle(handle, 0o600)
        yield* caller.mkdir("/sentinel")

        const events = yield* Fiber.join(watcher)
        const paths: Array<string> = []

        for (const event of events) {
          paths.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
        }

        assert.deepStrictEqual(paths, ["Create /sentinel"])
      })
  )
})
