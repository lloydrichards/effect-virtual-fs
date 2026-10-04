import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LiveVolume, type VirtualFileSystem as Vfs } from "../src/index.js"

const options = {
  maxImageBytes: ByteSize.kilobytes(64),
  volume: { maxBytes: ByteSize.kilobytes(32), maxFileBytes: ByteSize.kilobytes(16) }
}

const stores = () => {
  const images = new Map<string, Uint8Array>()
  const active = new Set<string>()
  let opened = 0
  let closed = 0

  const layer = (key: string) =>
    Layer.effect(
      LiveVolume.LiveImageStore,
      Effect.gen(function*() {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            assert.isFalse(active.has(key), "a store must have only one owner")
            active.add(key)
            opened++
          }),
          () =>
            Effect.sync(() => {
              active.delete(key)
              closed++
            })
        )

        return LiveVolume.LiveImageStore.of({
          loadOrCreate: (initial) => Effect.sync(() => images.get(key) ?? initial),
          commit: (image) =>
            Effect.sync(() => {
              images.set(key, new Uint8Array(image))

              return "committed" as const
            })
        })
      })
    )

  return { layer, active, images, opened: () => opened, closed: () => closed }
}

describe("live volume registry", () => {
  it.layer(BunCrypto.layer)((it) => {
    for (const idleTimeToLive of [0, 10]) {
      it.effect(`waits for store cleanup before reopening with idle duration ${idleTimeToLive}`, () =>
        Effect.gen(function*() {
          const closing = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let opened = 0
          const fixture = stores()

          const registry = yield* LiveVolume.makeRegistry({
            volume: options,
            idleTimeToLive,
            store: (key: string) =>
              Layer.effect(
                LiveVolume.LiveImageStore,
                Effect.gen(function*() {
                  yield* Effect.acquireRelease(
                    Effect.sync(() => {
                      opened++
                    }),
                    () =>
                      opened === 1
                        ? Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(release)))
                        : Effect.void
                  )

                  return yield* LiveVolume.LiveImageStore.pipe(Effect.provide(fixture.layer(key)))
                })
              )
          })

          const first = yield* Scope.make()
          yield* registry.get("a").pipe(Effect.provideService(Scope.Scope, first))
          const close = yield* Scope.close(first, Exit.void).pipe(Effect.forkChild)

          if (idleTimeToLive > 0) yield* TestClock.adjust(idleTimeToLive)
          yield* Deferred.await(closing)
          const abandoned = yield* registry.get("a").pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* Fiber.interrupt(abandoned)
          const second = yield* registry.get("a").pipe(Effect.forkChild)
          yield* Effect.yieldNow
          const openedWhileRetiring = opened
          // A retiring key must not block unrelated stores.
          yield* registry.get("b")
          const openedWithOtherKey = opened
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(close)
          yield* Fiber.join(second)
          assert.strictEqual(openedWhileRetiring, 1)
          assert.strictEqual(openedWithOtherKey, 2)
          assert.strictEqual(opened, 3)
        }))
    }

    for (const capacity of [0, -1, 1.5, NaN, Infinity]) {
      it.effect(`rejects capacity ${capacity} before acquiring storage`, () =>
        Effect.gen(function*() {
          const fixture = stores()
          const error = yield* Effect.flip(LiveVolume.makeRegistry({ store: fixture.layer, volume: options, capacity }))
          assert.strictEqual(error.code, "InvalidArgument")
          assert.strictEqual(error.operation, "LiveVolume.makeRegistry")
          assert.strictEqual(error.field, "capacity")
          assert.strictEqual(fixture.opened(), 0)
        }))
    }

    it.effect("rejects an invalid idle duration as a typed argument failure", () =>
      Effect.gen(function*() {
        const fixture = stores()

        const error = yield* Effect.flip(LiveVolume.makeRegistry({
          store: fixture.layer,
          volume: options,
          // @ts-expect-error Exercise an invalid value supplied by an untyped caller.
          idleTimeToLive: "invalid"
        }))

        assert.strictEqual(error.code, "InvalidArgument")
        assert.strictEqual(error.field, "idleTimeToLive")
        assert.strictEqual(fixture.opened(), 0)
      }))

    it.effect("captures the same volume configuration for every key when the registry is created", () =>
      Effect.gen(function*() {
        const fixture = stores()
        const volume = { ...options.volume, maxEntries: 1 }
        const registry = yield* LiveVolume.makeRegistry({ store: fixture.layer, volume: { ...options, volume } })
        volume.maxEntries = 10

        for (const key of ["a", "b"]) {
          const caller = yield* (yield* registry.get(key)).caller()
          yield* caller.mkdir("/first")
          assert.strictEqual((yield* Effect.flip(caller.mkdir("/second"))).code, "NoSpace")
        }
      }))

    it.effect("builds independent store state even when its Layer is already provided by the parent", () => {
      let built = 0
      let closed = 0

      const sharedLayer = Layer.effect(
        LiveVolume.LiveImageStore,
        Effect.gen(function*() {
          let image: Uint8Array | undefined
          yield* Effect.acquireRelease(Effect.sync(() => built++), () => Effect.sync(() => closed++))

          return LiveVolume.LiveImageStore.of({
            loadOrCreate: (initial) => Effect.sync(() => image ?? initial),
            commit: (candidate) =>
              Effect.sync(() => {
                image = new Uint8Array(candidate)

                return "committed" as const
              })
          })
        })
      )

      return Effect.gen(function*() {
        const registry = yield* LiveVolume.makeRegistry({ store: (_key: string) => sharedLayer, volume: options })
        const aScope = yield* Scope.make()
        const a = yield* registry.get("a").pipe(Effect.provideService(Scope.Scope, aScope))
        const b = yield* registry.get("b")
        const callerA = yield* a.caller()
        yield* callerA.mkdir("/only-a")
        assert.strictEqual((yield* Effect.flip((yield* b.caller()).stat("/only-a"))).code, "NotFound")
        assert.strictEqual(built, 3)
        yield* Scope.close(aScope, Exit.void)
        assert.strictEqual(closed, 1)
        yield* b.snapshot
      }).pipe(Effect.provide(sharedLayer))
    })

    it.effect("shares one acquisition while concurrent borrowers wait for storage", () =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const proceed = yield* Deferred.make<void>()
        const fixture = stores()

        const registry = yield* LiveVolume.makeRegistry({
          volume: options,
          store: (key: string) =>
            fixture.layer(key).pipe(
              Layer.tap(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed))))
            )
        })

        const a = yield* Scope.make()
        const b = yield* Scope.make()
        const first = yield* registry.get("a").pipe(Effect.provideService(Scope.Scope, a), Effect.forkChild)
        yield* Deferred.await(entered)
        const second = yield* registry.get("a").pipe(Effect.provideService(Scope.Scope, b), Effect.forkChild)
        yield* Deferred.succeed(proceed, undefined)
        const volume = yield* Fiber.join(first)
        assert.strictEqual(yield* Fiber.join(second), volume)
        assert.strictEqual(fixture.opened(), 1)
        yield* Scope.close(a, Exit.void)
        assert.strictEqual(fixture.closed(), 0)
        yield* (yield* volume.caller()).mkdir("/still-open")
        yield* Scope.close(b, Exit.void)
        assert.strictEqual(fixture.closed(), 1)
        assert.strictEqual((yield* Effect.flip(volume.snapshot)).code, "VolumeUnavailable")
      }))

    it.effect("reopens committed content after the final borrower releases storage", () =>
      Effect.gen(function*() {
        const fixture = stores()
        const registry = yield* LiveVolume.makeRegistry({ store: fixture.layer, volume: options })

        const first = yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* registry.get("a")
          yield* (yield* volume.caller()).writeFile("/saved", new Uint8Array([4, 5]), {
            access: "write",
            create: "exclusive"
          })

          return volume
        }))

        assert.strictEqual(fixture.closed(), 1)
        yield* Effect.scoped(Effect.gen(function*() {
          const second = yield* registry.get("a")
          assert.notStrictEqual(second, first)
          assert.deepStrictEqual(yield* (yield* second.caller()).readFile("/saved"), new Uint8Array([4, 5]))
        }))
        assert.strictEqual(fixture.opened(), 2)
        assert.strictEqual(fixture.closed(), 2)
      }))

    it.effect("keeps different storage keys isolated", () =>
      Effect.gen(function*() {
        const fixture = stores()
        const registry = yield* LiveVolume.makeRegistry({ store: fixture.layer, volume: options })
        const a = yield* registry.get("a")
        const b = yield* registry.get("b")
        assert.notStrictEqual(a, b)
        yield* (yield* a.caller()).mkdir("/only-a")
        assert.strictEqual((yield* Effect.flip((yield* b.caller()).stat("/only-a"))).code, "NotFound")
        assert.deepStrictEqual([...fixture.active].sort(), ["a", "b"])
      }))

    it.effect("reuses an idle volume until its timeout and then closes storage", () =>
      Effect.gen(function*() {
        const fixture = stores()

        const registry = yield* LiveVolume.makeRegistry({
          store: fixture.layer,
          volume: options,
          idleTimeToLive: "1 second"
        })

        const first = yield* Effect.scoped(registry.get("a"))
        yield* TestClock.adjust("500 millis")
        assert.strictEqual(yield* Effect.scoped(registry.get("a")), first)
        yield* TestClock.adjust("600 millis")
        assert.strictEqual(fixture.closed(), 0)
        yield* TestClock.adjust("400 millis")
        assert.strictEqual(fixture.closed(), 1)
        const second = yield* registry.get("a")
        assert.notStrictEqual(second, first)
      }))

    it.effect("counts distinct and idle volumes toward capacity without closing active borrowers", () =>
      Effect.gen(function*() {
        const fixture = stores()

        const registry = yield* LiveVolume.makeRegistry({
          store: fixture.layer,
          volume: options,
          capacity: 1,
          idleTimeToLive: "1 second"
        })

        const a = yield* Effect.scoped(registry.get("a"))
        const error = yield* Effect.flip(registry.get("b"))
        assert.strictEqual(error._tag, "ExceededCapacityError")
        assert.strictEqual(yield* Effect.scoped(registry.get("a")), a)
        yield* TestClock.adjust("1 second")
        yield* registry.get("b")
        assert.deepStrictEqual([...fixture.active], ["b"])
      }))

    it.effect("releases a failed acquisition and permits a later retry", () =>
      Effect.gen(function*() {
        const fixture = stores()
        let attempts = 0

        const registry = yield* LiveVolume.makeRegistry({
          volume: options,
          store: (key: string) =>
            fixture.layer(key).pipe(
              Layer.tap(() => Effect.suspend(() => ++attempts === 1 ? Effect.fail("opening failed") : Effect.void))
            )
        })

        assert.strictEqual(yield* Effect.scoped(Effect.flip(registry.get("a"))), "opening failed")
        assert.strictEqual(fixture.closed(), 1)
        yield* registry.get("a")
        assert.strictEqual(attempts, 2)
      }))

    it.effect("keeps a shared acquisition alive when one waiting borrower is interrupted", () =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const proceed = yield* Deferred.make<void>()
        const fixture = stores()

        const registry = yield* LiveVolume.makeRegistry({
          volume: options,
          store: (key: string) =>
            fixture.layer(key).pipe(
              Layer.tap(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed))))
            )
        })

        const retained = yield* Scope.make()
        const first = yield* registry.get("a").pipe(Effect.provideService(Scope.Scope, retained), Effect.forkChild)
        yield* Deferred.await(entered)
        const cancelled = yield* Effect.scoped(registry.get("a")).pipe(Effect.forkChild)
        yield* Fiber.interrupt(cancelled)
        yield* Deferred.succeed(proceed, undefined)
        yield* (yield* Fiber.join(first)).snapshot
        assert.strictEqual(fixture.closed(), 0)
        yield* Scope.close(retained, Exit.void)
        assert.strictEqual(fixture.closed(), 1)
      }))

    it.effect("releases storage when opening a corrupt image fails", () =>
      Effect.gen(function*() {
        const fixture = stores()
        fixture.images.set("a", new Uint8Array([255]))
        const registry = yield* LiveVolume.makeRegistry({ store: fixture.layer, volume: options })
        const error = yield* Effect.scoped(Effect.flip(registry.get("a")))
        assert.strictEqual("code" in error ? error.code : error._tag, "CorruptStore")
        assert.strictEqual(fixture.closed(), 1)
        fixture.images.delete("a")
        yield* registry.get("a")
        assert.strictEqual(fixture.opened(), 2)
      }))

    it.effect("shuts down the volume before storage even when its owner closes with a borrower alive", () =>
      Effect.gen(function*() {
        let volume: Vfs.Volume | undefined
        let shutdownObserved = false
        const fixture = stores()
        const owner = yield* Scope.make()
        const borrower = yield* Scope.make()

        const registry = yield* LiveVolume.makeRegistry({
          volume: options,
          store: (key: string) =>
            fixture.layer(key).pipe(Layer.tap(() =>
              Effect.addFinalizer(() =>
                Effect.gen(function*() {
                  assert.strictEqual(
                    (yield* Effect.flip(volume!.snapshot).pipe(Effect.orDie)).code,
                    "VolumeUnavailable"
                  )
                  shutdownObserved = true
                })
              )
            ))
        }).pipe(Effect.provideService(Scope.Scope, owner))

        volume = yield* registry.get("a").pipe(Effect.provideService(Scope.Scope, borrower))
        yield* Scope.close(owner, Exit.void)
        assert.isTrue(shutdownObserved)
        assert.strictEqual(fixture.closed(), 1)
        const exit = yield* Effect.exit(registry.get("a"))
        assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
        yield* Scope.close(borrower, Exit.void)
        assert.strictEqual(fixture.closed(), 1)
      }))

    it.effect("closes storage when the sole borrower cancels an unfinished acquisition", () =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const proceed = yield* Deferred.make<void>()
        const fixture = stores()

        const registry = yield* LiveVolume.makeRegistry({
          volume: options,
          store: (key: string) =>
            fixture.layer(key).pipe(
              Layer.tap(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed))))
            )
        })

        const opening = yield* Effect.scoped(registry.get("a")).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(opening)
        assert.strictEqual(fixture.closed(), 1)
        assert.strictEqual(fixture.active.size, 0)
        yield* Deferred.succeed(proceed, undefined)
        yield* registry.get("a")
        assert.strictEqual(fixture.opened(), 2)
      }))

    it.effect("keeps handles independent and reclaims unlinked content only after both close", () =>
      Effect.gen(function*() {
        const fixture = stores()
        const registry = yield* LiveVolume.makeRegistry({ store: fixture.layer, volume: options })
        const volume = yield* registry.get("a")
        const a = yield* (yield* volume.caller()).open("/file", { access: "readWrite", create: "exclusive" })
        yield* a.write(new Uint8Array([7, 8]))
        const other = yield* registry.get("a")
        const caller = yield* other.caller()
        const b = yield* caller.open("/file", { access: "read" })
        assert.deepStrictEqual(yield* b.read(1), new Uint8Array([7]))
        assert.strictEqual(yield* a.seek(0n, "current"), 2n)
        yield* caller.unlink("/file")
        assert.deepStrictEqual(yield* volume.usage, { usedBytes: 2n, entries: 0 })
        yield* a.close
        assert.deepStrictEqual(yield* volume.usage, { usedBytes: 2n, entries: 0 })
        assert.deepStrictEqual(yield* b.read(1), new Uint8Array([8]))
        yield* b.close
        assert.deepStrictEqual(yield* volume.usage, { usedBytes: 0n, entries: 0 })
        assert.strictEqual((yield* Effect.flip(b.read(1))).code, "InvalidHandle")
      }))
  })
})
