import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { make, WriteResult } from "../src/internal/liveImageProtocol.js"
import { storeFailures } from "../src/internal/storeSupport.js"

const empty = new Uint8Array()

const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

const loading = storeFailures("Protocol.loadOrCreate")

it.layer(NodeCrypto.layer)("live-image creation protocol", (it) => {
  it.effect("loads the winner of a create-only race and uses its token", () =>
    Effect.gen(function*() {
      let reads = 0
      const expected: Array<string | undefined> = []

      const { store } = yield* make({
        maxImage: 16n,
        loading,
        storage: {
          read: Effect.sync(() =>
            reads++ === 0 ? null : { image: empty, generation: "3", digest: hash, token: "winner" }
          ),
          compareAndSwap: (token) =>
            Effect.sync(() => {
              expected.push(token)

              return token === undefined ? WriteResult.Conflict() : WriteResult.Written({ token: "next" })
            })
        }
      })

      assert.deepStrictEqual(yield* store.loadOrCreate(new Uint8Array([1])), empty)
      assert.strictEqual(yield* store.commit(empty), "committed")
      assert.deepStrictEqual(expected, [undefined, "winner"])
    }))

  it.effect("freezes when cancellation follows a create conflict during winner lookup", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      let reads = 0
      let writes = 0

      const { store, isAvailable } = yield* make({
        maxImage: 16n,
        loading,
        storage: {
          read: Effect.suspend(() => {
            if (reads++ === 0) return Effect.succeed(null)

            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
          }),
          compareAndSwap: () =>
            Effect.sync(() => {
              writes++

              return WriteResult.Conflict()
            })
        }
      })

      const initializing = yield* Effect.forkChild(store.loadOrCreate(empty))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(initializing)
      const result = yield* Fiber.await(initializing)
      assert.isTrue(Exit.isFailure(result))

      if (Exit.isFailure(result)) assert.isTrue(Cause.hasInterrupts(result.cause))
      assert.isFalse(yield* isAvailable)
      assert.strictEqual((yield* Effect.flip(store.loadOrCreate(empty))).code, "Storage")
      assert.strictEqual(yield* store.commit(empty), "unknown")
      assert.deepStrictEqual([reads, writes], [2, 1])
    }))

  it.effect("releases the initialization claim after a definite create rejection", () =>
    Effect.gen(function*() {
      let attempts = 0

      const { store } = yield* make({
        maxImage: 16n,
        loading,
        storage: {
          read: Effect.succeed(null),
          compareAndSwap: () =>
            Effect.sync(() =>
              attempts++ === 0
                ? WriteResult.Rejected({})
                : WriteResult.Written({ token: "created" })
            )
        }
      })

      assert.strictEqual((yield* Effect.flip(store.loadOrCreate(empty))).code, "Storage")
      assert.deepStrictEqual(yield* store.loadOrCreate(empty), empty)
      assert.strictEqual(attempts, 2)
    }))

  it.effect("does not read or retry an uncertain creation", () =>
    Effect.gen(function*() {
      let reads = 0
      let writes = 0

      const { store } = yield* make({
        maxImage: 16n,
        loading,
        storage: {
          read: Effect.sync(() => {
            reads++

            return null
          }),
          compareAndSwap: () =>
            Effect.sync(() => {
              writes++

              return WriteResult.Unknown({})
            })
        }
      })

      assert.strictEqual((yield* Effect.flip(store.loadOrCreate(empty))).code, "Storage")
      assert.strictEqual((yield* Effect.flip(store.loadOrCreate(empty))).code, "Storage")
      assert.deepStrictEqual([reads, writes], [1, 1])
    }))
})
