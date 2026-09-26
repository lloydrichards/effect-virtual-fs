import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, Predicate, PubSub, Queue, Scope, Stream } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import { withVolumeTestSeams } from "../src/internal/testSeams.js"
import { entryNames, pathText } from "./support/text.js"

describe("volume watch", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should publish one Create event when a child is created with initial size",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const caller = yield* Vfs.Caller
          const watcher = yield* Testing.collectChanges(yield* volume.watch(), 2)

          const opened = yield* caller.open(Vfs.Entry(yield* caller.root, new TextEncoder().encode("sized")), {
            access: "read",
            create: "exclusive",
            initialSize: 3n
          })

          yield* opened.handle.close
          yield* caller.mkdir("/sentinel")

          const events = yield* watcher
          const changes = yield* rendered(events)

          assert.deepStrictEqual(changes, ["Create /sized", "Create /sentinel"])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should deliver a change when a watcher is registering concurrently", () =>
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
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should register nothing and return an ended stream when the scope is already closed",
      () =>
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
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should register nothing when another fiber closes the scope while registration waits",
      () =>
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
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should report every hard link path when a file's metadata changes", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/dir")
        yield* caller.writeFile("/dir/original", new Uint8Array([1]), { access: "write", create: "ifMissing" })
        yield* caller.link("/dir/original", "/alias")

        const watcher = yield* Testing.collectChanges(yield* volume.watch(), 2)

        yield* caller.chmod("/dir/original", 0o600)

        const events = yield* watcher
        const paths: Array<string> = []

        for (const event of events) {
          assert.strictEqual(event._tag, "Update")
          paths.push(new TextDecoder().decode(yield* Vfs.pathToBytes(event.path)))
        }

        assert.deepStrictEqual(paths.sort(), ["/alias", "/dir/original"])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should stay silent when unlinked objects change through open handles",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const caller = yield* Vfs.Caller
          yield* caller.mkdir("/parent")
          yield* caller.mkdir("/parent/child")
          const removed = yield* caller.openDirectory("/parent/child")
          yield* caller.rmdir("/parent/child")
          yield* caller.mkdir("/source")
          yield* caller.mkdir("/target")
          const displaced = yield* caller.openDirectory("/target")
          yield* caller.rename("/source", "/target")
          yield* caller.writeFile("/orphan", new Uint8Array([1]), { access: "write", create: "ifMissing" })
          const orphan = yield* caller.open("/orphan", { access: "read" })
          yield* caller.unlink("/orphan")

          const watcher = yield* Testing.collectChanges(yield* volume.watch(), 1)

          yield* caller.chmod(removed, 0o700)
          yield* caller.utimes(displaced, { access: { kind: "now" }, modification: { kind: "now" } })
          yield* caller.chmod(orphan, 0o600)
          yield* caller.mkdir("/sentinel")

          const events = yield* watcher
          const paths = yield* rendered(events)

          assert.deepStrictEqual(paths, ["Create /sentinel"])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should report the root path when the root directory's own metadata changes",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const caller = yield* Vfs.Caller

          const watcher = yield* Testing.collectChanges(yield* volume.watch(), 1)

          yield* caller.chmod("/", 0o700)
          yield* caller.mkdir("/sentinel")

          const events = yield* watcher
          const paths = yield* rendered(events)

          assert.deepStrictEqual(paths, ["Update /"])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should report the current nested path when metadata changes by path or moved handle",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const caller = yield* Vfs.Caller
          yield* caller.mkdir("/origin")
          yield* caller.mkdir("/origin/moved")
          yield* caller.mkdir("/destination")
          const moved = yield* caller.openDirectory("/origin/moved")
          yield* caller.rename("/origin/moved", "/destination/moved")

          const watcher = yield* Testing.collectChanges(yield* volume.watch(), 2)

          yield* caller.chmod("/destination/moved", 0o700)
          yield* caller.chmod(moved, 0o600)

          const events = yield* watcher
          const paths = yield* rendered(events)

          assert.deepStrictEqual(paths, ["Update /destination/moved", "Update /destination/moved"])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should publish Remove then Create when an entry is renamed", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/a")
        yield* caller.mkdir("/b")
        yield* caller.writeFile("/a/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })

        const watcher = yield* Testing.collectChanges(yield* volume.watch(), 2)

        yield* caller.rename("/a/f", "/b/g")

        const events = yield* watcher
        const changes = yield* rendered(events)

        assert.deepStrictEqual(changes, ["Remove /a/f", "Create /b/g"])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should publish only source and destination changes when a rename replaces an occupied name",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const caller = yield* Vfs.Caller
          yield* caller.writeFile("/x", new Uint8Array([1]), { access: "write", create: "ifMissing" })
          yield* caller.writeFile("/y", new Uint8Array([2]), { access: "write", create: "ifMissing" })

          const watcher = yield* Testing.collectChanges(yield* volume.watch(), 3)

          yield* caller.rename("/x", "/y")
          yield* caller.mkdir("/sentinel")

          const events = yield* watcher
          const changes = yield* rendered(events)

          assert.deepStrictEqual(changes, ["Remove /x", "Create /y", "Create /sentinel"])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should publish no change when a rename joins two names of one file", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })
        yield* caller.link("/f", "/alias")

        const watcher = yield* Testing.collectChanges(yield* volume.watch(), 1)

        yield* caller.rename("/f", "/alias")
        yield* caller.mkdir("/sentinel")

        const events = yield* watcher
        const changes = yield* rendered(events)

        assert.deepStrictEqual(changes, ["Create /sentinel"])
        assert.strictEqual((yield* caller.stat("/f")).ino, (yield* caller.stat("/alias")).ino)
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should publish every current name of a hard-linked file when one name moved",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const caller = yield* Vfs.Caller
          yield* caller.mkdir("/dir")
          yield* caller.writeFile("/dir/original", new Uint8Array([1]), { access: "write", create: "ifMissing" })
          yield* caller.link("/dir/original", "/alias")
          yield* caller.rename("/dir/original", "/dir/moved")

          const watcher = yield* Testing.collectChanges(yield* volume.watch(), 2)

          yield* caller.chmod("/alias", 0o600)

          const events = yield* watcher
          const changes = yield* rendered(events)

          assert.deepStrictEqual(changes.sort(), ["Update /alias", "Update /dir/moved"])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should publish descendant updates at the new path when their directory is moved",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const caller = yield* Vfs.Caller
          yield* caller.mkdir("/old")
          yield* caller.mkdir("/old/work")
          yield* caller.writeFile("/old/work/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })
          yield* caller.rename("/old", "/new")

          const watcher = yield* Testing.collectChanges(yield* volume.watch(), 1)

          yield* caller.chmod("/new/work/f", 0o600)

          const events = yield* watcher
          const changes = yield* rendered(events)

          assert.deepStrictEqual(changes, ["Update /new/work/f"])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })
})

const rendered = (events: Iterable<Vfs.Change>) =>
  Effect.forEach(events, (event) => Effect.map(pathText(event.path), (path) => `${event._tag} ${path}`))

// A scoped watch on `path`, registered before it returns.
const watchAt = Effect.fnUntraced(function*(path: string, options?: { readonly recursive?: boolean }) {
  const volume = yield* Vfs.Volume
  const caller = yield* Vfs.Caller

  return yield* volume.watch({ ...options, scope: yield* caller.lookup(path) })
})

const file = (caller: Vfs.Caller, path: string) =>
  caller.writeFile(path, new Uint8Array([1]), { access: "write", create: "ifMissing" })

describe("scoped watch", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should report only changes beneath the scope when a scoped watcher observes a tree",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          yield* caller.mkdir("/a")
          yield* caller.mkdir("/b")
          const changes = yield* Testing.collectChanges(yield* watchAt("/a"), 3)

          yield* caller.mkdir("/b/outside")
          yield* caller.mkdir("/a/inside")
          yield* caller.mkdir("/a/inside/deep")
          yield* caller.chmod("/a", 0o700)

          assert.deepStrictEqual(yield* rendered(yield* changes), [
            "Create /a/inside",
            "Create /a/inside/deep",
            "Update /a"
          ])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should report only the scope and its direct children when not recursive",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          yield* caller.mkdir("/a")
          const changes = yield* Testing.collectChanges(yield* watchAt("/a", { recursive: false }), 3)

          yield* caller.mkdir("/a/child")
          yield* caller.mkdir("/a/child/grandchild")
          yield* caller.chmod("/a/child/grandchild", 0o700)
          yield* caller.chmod("/a", 0o700)
          yield* caller.chmod("/a/child", 0o700)

          assert.deepStrictEqual(yield* rendered(yield* changes), ["Create /a/child", "Update /a", "Update /a/child"])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should report only the root's direct children when an unscoped watch is nonrecursive",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const caller = yield* Vfs.Caller
          const changes = yield* Testing.collectChanges(yield* volume.watch({ recursive: false }), 2)

          yield* caller.mkdir("/a")
          yield* caller.mkdir("/a/nested")
          yield* caller.mkdir("/b")

          assert.deepStrictEqual(yield* rendered(yield* changes), ["Create /a", "Create /b"])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should keep reporting at the new paths when an ancestor of the scope is renamed",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          yield* caller.mkdir("/project")
          yield* caller.mkdir("/project/work")
          const changes = yield* Testing.collectChanges(yield* watchAt("/project/work"), 1)

          yield* caller.rename("/project", "/renamed")
          yield* caller.mkdir("/renamed/work/out")

          assert.deepStrictEqual(yield* rendered(yield* changes), ["Create /renamed/work/out"])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should report a scope rename and keep watching when the scoped directory moves",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          yield* caller.mkdir("/work")
          const changes = yield* Testing.collectChanges(yield* watchAt("/work"), 3)

          yield* caller.rename("/work", "/moved")
          yield* caller.mkdir("/moved/out")

          assert.deepStrictEqual(yield* rendered(yield* changes), [
            "Remove /work",
            "Create /moved",
            "Create /moved/out"
          ])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should report Remove and Create for cross-scope moves when an entry crosses the scope boundary",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          yield* caller.mkdir("/in")
          yield* caller.mkdir("/out")
          yield* caller.mkdir("/in/leaving")
          yield* file(caller, "/out/arriving")
          const changes = yield* Testing.collectChanges(yield* watchAt("/in"), 3)

          yield* caller.rename("/in/leaving", "/out/left")
          yield* caller.rename("/out/arriving", "/in/arrived")
          // The moved-out directory is no longer in the scope, so its changes are not reported.
          yield* caller.mkdir("/out/left/later")
          yield* caller.mkdir("/in/sentinel")

          assert.deepStrictEqual(yield* rendered(yield* changes), [
            "Remove /in/leaving",
            "Create /in/arrived",
            "Create /in/sentinel"
          ])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should report Remove and end when the scope directory is removed", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/work")
        const stream = yield* watchAt("/work")

        yield* caller.mkdir("/work/child")
        yield* caller.rmdir("/work/child")
        yield* caller.rmdir("/work")
        yield* caller.mkdir("/work")

        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
          "Create /work/child",
          "Remove /work/child",
          "Remove /work"
        ])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should report Remove and end when a rename replaces the scope", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* file(caller, "/target")
        yield* file(caller, "/replacement")
        const stream = yield* watchAt("/target")

        yield* caller.chmod("/target", 0o600)
        yield* caller.rename("/replacement", "/target")

        assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), ["Update /target", "Remove /target"])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should keep watching an object when another hard-link name still exists",
      () =>
        Effect.gen(function*() {
          const caller = yield* Vfs.Caller
          yield* file(caller, "/f")
          yield* caller.link("/f", "/alias")
          const stream = yield* watchAt("/f")

          yield* caller.unlink("/alias")
          yield* caller.chmod("/f", 0o600)
          yield* caller.unlink("/f")

          assert.deepStrictEqual(yield* rendered(yield* Stream.runCollect(stream)), [
            "Remove /alias",
            "Update /f",
            "Remove /f"
          ])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should reject the scope when its reference is stale or foreign", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/gone")
        const gone = yield* caller.lookup("/gone")
        yield* caller.rmdir("/gone")
        const other = yield* Vfs.make()
        const foreign = yield* (yield* other.caller()).root

        assert.strictEqual((yield* Effect.flip(volume.watch({ scope: gone }))).code, "StaleReference")
        assert.strictEqual((yield* Effect.flip(volume.watch({ scope: foreign }))).code, "ForeignReference")

        // SAFETY: a forged reference stands in for a scope from an untyped caller, which the decoder must reject.
        const forged = Object.freeze({}) as Vfs.ObjectReference
        const invalid = yield* Effect.flip(volume.watch({ scope: forged }))
        assert.strictEqual(invalid.code, "InvalidArgument")
        assert.strictEqual(invalid.field, "scope")
      }).pipe(Effect.provide(Testing.layer())))
  })
})

const paths = (events: Iterable<Vfs.Change>) =>
  Effect.forEach(events, (event) =>
    Vfs.pathToBytes(event.path).pipe(
      Effect.map((bytes) => `${event._tag} ${new TextDecoder().decode(bytes)}`)
    ))

describe("bounded watches", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should reject excess admission before mutation and release cancelled waits when the queue is full",
      () =>
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
        }).pipe(Effect.provide(Testing.layer({ volume: { maxPendingOperations: 1 } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should release admission when a watch is cancelled while waiting for the permit",
      () =>
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
        }).pipe(Effect.provide(Testing.layer({ volume: { maxPendingOperations: 1 } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should publish to an active subscriber when another subscriber is stalled",
      () =>
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
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should signal overflow per subscriber while allowing writes when one subscriber falls behind",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const caller = yield* Vfs.Caller
          const slowScope = yield* Scope.make()
          const fastScope = yield* Scope.make()
          const slow = yield* volume.watch().pipe(Scope.provide(slowScope))
          const fast = yield* volume.watch().pipe(Scope.provide(fastScope))
          const received = yield* Queue.bounded<void>(4)

          const fastConsumer = yield* Testing.collectChanges(
            Stream.tap(fast, () => Queue.offer(received, undefined)),
            4
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
        }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 3 } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should drop changes when the overflow marker until the consumer takes it, then resumes",
      () =>
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
        }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 3 } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should keep a scoped subscriber below overflow when changes occur outside its scope",
      () =>
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
        }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 3 } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should name the current scope path in Rescan when the scope moves", () =>
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
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should report scope removal and end when the removal fills the queue", () =>
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
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should report scope removal and end when a replacing rename fills the queue",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const caller = yield* Vfs.Caller
          yield* caller.writeFile("/target", new Uint8Array([1]), { access: "write", create: "exclusive" })
          yield* caller.writeFile("/replacement", new Uint8Array([2]), { access: "write", create: "exclusive" })
          const scoped = yield* volume.watch({ scope: yield* caller.lookup("/target") })

          yield* caller.chmod("/target", 0o600)
          yield* caller.rename("/replacement", "/target")

          assert.deepEqual(yield* paths(yield* Stream.runCollect(scoped)), ["Update /target", "Remove /target"])
        }).pipe(Effect.provide(Testing.layer({ volume: { maxWatchEvents: 2 } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should create independent subscriptions when the same watch effect runs again",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const caller = yield* Vfs.Caller
          const watch = volume.watch()
          const firstScope = yield* Scope.make()
          const secondScope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
          yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
          const first = yield* watch.pipe(Scope.provide(firstScope))
          const second = yield* watch.pipe(Scope.provide(secondScope))
          yield* caller.mkdir("/both")
          const firstEvents = yield* first.pipe(Stream.take(1), Stream.runCollect)
          const secondEvents = yield* second.pipe(Stream.take(1), Stream.runCollect)
          assert.strictEqual(firstEvents.length, 1)
          assert.deepStrictEqual(secondEvents, firstEvents)
          yield* Scope.close(firstScope, Exit.void)
          yield* caller.mkdir("/second")
          const remaining = yield* second.pipe(Stream.take(1), Stream.runCollect)
          assert.strictEqual(remaining.length, 1)
          const event = remaining[0]
          assert.isDefined(event)
          assert.deepStrictEqual(yield* Vfs.pathToBytes(event.path), new TextEncoder().encode("/second"))
        }).pipe(Effect.provide(Testing.layer()))
    )
  })
})
