import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Predicate, Scope, Stream } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { withVolumeTestSeams } from "../src/internal/testSeams.js"

describe("volume watch", () => {
  it.effect("publishes one Create event for a child with initial size", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      const stream = yield* volume.watch()

      const watcher = yield* Testing.collectChanges(stream, 2)

      const opened = yield* caller.open(Vfs.Entry(yield* caller.root, new TextEncoder().encode("sized")), {
        access: "read",
        create: "exclusive",
        initialSize: 3n
      })

      yield* opened.handle.close
      yield* caller.mkdir("/sentinel")

      const events = yield* watcher
      const changes: Array<string> = []

      for (const event of events) {
        changes.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
      }

      assert.deepStrictEqual(changes, ["Create /sized", "Create /sentinel"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("does not lose a change while a watcher is registering", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      const subscribed = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const afterSubscribe = Deferred.succeed(subscribed, undefined).pipe(Effect.andThen(Deferred.await(release)))

      const watcher = yield* volume.watch().pipe(
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
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("registers nothing and returns an ended stream when the scope is already closed", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      const scope = yield* Scope.make()
      yield* Scope.close(scope, Exit.void)
      const dead = yield* volume.watch().pipe(Scope.provide(scope))
      const live = yield* volume.watch()
      yield* caller.mkdir("/after")
      assert.strictEqual((yield* Stream.runHead(dead))._tag, "None")
      const event = yield* Stream.runHead(live)
      assert.strictEqual(event._tag, "Some")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("registers nothing when another fiber closes the scope while registration waits", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      const scope = yield* Scope.make()
      const held = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      // A registration in flight holds the volume until released, so the second one waits for the permit.
      const first = yield* volume.watch().pipe(
        withVolumeTestSeams({
          afterSubscribe: Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release)))
        }),
        Effect.forkChild({ startImmediately: true })
      )

      yield* Deferred.await(held)
      const waiting = yield* volume.watch().pipe(Scope.provide(scope), Effect.forkChild({ startImmediately: true }))

      for (let i = 0; i < 4; i++) yield* Effect.yieldNow
      yield* Scope.close(scope, Exit.void)
      yield* Deferred.succeed(release, undefined)
      const live = yield* Fiber.join(first)
      const dead = yield* Fiber.join(waiting)
      yield* caller.mkdir("/after")
      assert.strictEqual((yield* Stream.runHead(dead))._tag, "None")
      assert.strictEqual((yield* Stream.runHead(live))._tag, "Some")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports every hard link path when a file's metadata changes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/dir")
      yield* caller.writeFile("/dir/original", new Uint8Array([1]), { access: "write", create: "ifMissing" })
      yield* caller.link("/dir/original", "/alias")

      const stream = yield* volume.watch()

      const watcher = yield* Testing.collectChanges(stream, 2)

      yield* caller.chmod("/dir/original", 0o600)

      const events = yield* watcher
      const paths: Array<string> = []

      for (const event of events) {
        assert.strictEqual(event._tag, "Update")
        paths.push(new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
      }

      assert.deepStrictEqual(paths.sort(), ["/alias", "/dir/original"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports a nested directory's own path when its metadata changes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/parent")
      yield* caller.mkdir("/parent/child")

      const stream = yield* volume.watch()

      const watcher = yield* Testing.collectChanges(stream, 1)

      yield* caller.chmod("/parent/child", 0o700)

      const events = yield* watcher
      const paths: Array<string> = []

      for (const event of events) paths.push(new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))

      assert.deepStrictEqual(paths, ["/parent/child"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect(
    "stays silent when a removed directory's metadata changes through an open handle",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/parent")
        yield* caller.mkdir("/parent/child")
        const removed = yield* caller.openDirectory("/parent/child")
        yield* caller.rmdir("/parent/child")

        const stream = yield* volume.watch()

        const watcher = yield* Testing.collectChanges(stream, 1)

        yield* caller.chmod(removed, 0o700)
        yield* caller.mkdir("/sentinel")

        const events = yield* watcher
        const paths: Array<string> = []

        for (const event of events) {
          paths.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
        }

        assert.deepStrictEqual(paths, ["Create /sentinel"])
      }).pipe(Effect.provide(Testing.layer()))
  )

  it.effect(
    "stays silent when a rename-displaced directory's metadata changes through an open handle",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/source")
        yield* caller.mkdir("/target")
        const displaced = yield* caller.openDirectory("/target")
        yield* caller.rename("/source", "/target")

        const stream = yield* volume.watch()

        const watcher = yield* Testing.collectChanges(stream, 1)

        yield* caller.utimes(displaced, { access: { kind: "now" }, modification: { kind: "now" } })
        yield* caller.mkdir("/sentinel")

        const events = yield* watcher
        const paths: Array<string> = []

        for (const event of events) {
          paths.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
        }

        assert.deepStrictEqual(paths, ["Create /sentinel"])
      }).pipe(Effect.provide(Testing.layer()))
  )

  it.effect("reports the root path when the root directory's own metadata changes", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller

      const stream = yield* volume.watch()

      const watcher = yield* Testing.collectChanges(stream, 1)

      yield* caller.chmod("/", 0o700)
      yield* caller.mkdir("/sentinel")

      const events = yield* watcher
      const paths: Array<string> = []

      for (const event of events) {
        paths.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
      }

      assert.deepStrictEqual(paths, ["Update /"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect(
    "reports the new path when a moved directory's metadata changes through an open handle",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/origin")
        yield* caller.mkdir("/origin/moved")
        yield* caller.mkdir("/destination")
        const moved = yield* caller.openDirectory("/origin/moved")
        yield* caller.rename("/origin/moved", "/destination/moved")

        const stream = yield* volume.watch()

        const watcher = yield* Testing.collectChanges(stream, 1)

        yield* caller.chmod(moved, 0o700)

        const events = yield* watcher
        const paths: Array<string> = []

        for (const event of events) {
          paths.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
        }

        assert.deepStrictEqual(paths, ["Update /destination/moved"])
      }).pipe(Effect.provide(Testing.layer()))
  )

  it.effect(
    "stays silent when an unlinked file's metadata changes through an open handle",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/orphan", new Uint8Array([1]), { access: "write", create: "ifMissing" })
        const handle = yield* caller.open("/orphan", { access: "read" })
        yield* caller.unlink("/orphan")

        const stream = yield* volume.watch()

        const watcher = yield* Testing.collectChanges(stream, 1)

        yield* caller.chmod(handle, 0o600)
        yield* caller.mkdir("/sentinel")

        const events = yield* watcher
        const paths: Array<string> = []

        for (const event of events) {
          paths.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
        }

        assert.deepStrictEqual(paths, ["Create /sentinel"])
      }).pipe(Effect.provide(Testing.layer()))
  )

  it.effect("publishes Remove then Create for a rename", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/a")
      yield* caller.mkdir("/b")
      yield* caller.writeFile("/a/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })

      const stream = yield* volume.watch()

      const watcher = yield* Testing.collectChanges(stream, 2)

      yield* caller.rename("/a/f", "/b/g")

      const events = yield* watcher
      const changes: Array<string> = []

      for (const event of events) {
        changes.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
      }

      assert.deepStrictEqual(changes, ["Remove /a/f", "Create /b/g"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("publishes only the source and destination for a rename over an occupied name", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.writeFile("/x", new Uint8Array([1]), { access: "write", create: "ifMissing" })
      yield* caller.writeFile("/y", new Uint8Array([2]), { access: "write", create: "ifMissing" })

      const stream = yield* volume.watch()

      const watcher = yield* Testing.collectChanges(stream, 3)

      yield* caller.rename("/x", "/y")
      yield* caller.mkdir("/sentinel")

      const events = yield* watcher
      const changes: Array<string> = []

      for (const event of events) {
        changes.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
      }

      assert.deepStrictEqual(changes, ["Remove /x", "Create /y", "Create /sentinel"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("publishes nothing for a rename between two names of one file", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })
      yield* caller.link("/f", "/alias")

      const stream = yield* volume.watch()

      const watcher = yield* Testing.collectChanges(stream, 1)

      yield* caller.rename("/f", "/alias")
      yield* caller.mkdir("/sentinel")

      const events = yield* watcher
      const changes: Array<string> = []

      for (const event of events) {
        changes.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
      }

      assert.deepStrictEqual(changes, ["Create /sentinel"])
      assert.strictEqual((yield* caller.stat("/f")).ino, (yield* caller.stat("/alias")).ino)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("publishes every current name of a hard-linked file after one name moved", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/dir")
      yield* caller.writeFile("/dir/original", new Uint8Array([1]), { access: "write", create: "ifMissing" })
      yield* caller.link("/dir/original", "/alias")
      yield* caller.rename("/dir/original", "/dir/moved")

      const stream = yield* volume.watch()

      const watcher = yield* Testing.collectChanges(stream, 2)

      yield* caller.chmod("/alias", 0o600)

      const events = yield* watcher
      const changes: Array<string> = []

      for (const event of events) {
        changes.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
      }

      assert.deepStrictEqual(changes.sort(), ["Update /alias", "Update /dir/moved"])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("publishes a moved directory's descendant updates at the new path", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      yield* caller.mkdir("/old")
      yield* caller.mkdir("/old/work")
      yield* caller.writeFile("/old/work/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })
      yield* caller.rename("/old", "/new")

      const stream = yield* volume.watch()

      const watcher = yield* Testing.collectChanges(stream, 1)

      yield* caller.chmod("/new/work/f", 0o600)

      const events = yield* watcher
      const changes: Array<string> = []

      for (const event of events) {
        changes.push(event._tag + " " + new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
      }

      assert.deepStrictEqual(changes, ["Update /new/work/f"])
    }).pipe(Effect.provide(Testing.layer())))
})
