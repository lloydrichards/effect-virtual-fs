import { LiveVolume } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it } from "@effect/vitest"
import { ByteSize, Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import * as R2 from "../src/R2Store.js"
import { liveImageStoreContract } from "./helpers/liveImageStoreContract.js"
import { storeFixture } from "./helpers/storeFixture.js"

liveImageStoreContract({
  name: "R2",
  fixture: storeFixture("R2"),
  pendingWritesCompleteOnClose: true,
  rollback: false
})

const empty = new Uint8Array()

const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

const open = Effect.fnUntraced(function*(client: R2.R2Client) {
  const context = yield* Layer.build(
    R2.layer({ key: "live", maxImageBytes: ByteSize.bytes(16) }).pipe(
      Layer.provide(Layer.succeed(R2.Client, client))
    )
  )

  return Context.get(context, LiveVolume.LiveImageStore)
})

it.layer(NodeCrypto.layer)("create-only R2 initialization", (it) => {
  it.effect("loads the winning image and commits against its ETag after a create conflict", () =>
    Effect.gen(function*() {
      let reads = 0
      const conditions: Array<Parameters<R2.R2Client["write"]>[4]> = []

      const store = yield* open({
        read: () => Effect.sync(() => reads++ === 0 ? null : { bytes: empty, generation: "3", digest, etag: "winner" }),
        write: (_key, _bytes, _generation, _digest, condition) =>
          Effect.sync(() => {
            conditions.push(condition)

            return "ifNoneMatch" in condition ? null : { etag: "next" }
          })
      })

      assert.deepStrictEqual(yield* store.loadOrCreate(Uint8Array.of(1)), empty)
      assert.strictEqual(yield* store.commit(empty), "committed")
      assert.deepStrictEqual(conditions, [{ ifNoneMatch: "*" }, { ifMatch: "winner" }])
    }))

  it.effect("stops using the store if the caller cancels while waiting for the winner", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let reads = 0
      let writes = 0

      const store = yield* open({
        read: () =>
          Effect.suspend(() =>
            reads++ === 0 ? Effect.succeed(null) : Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(null)
            )
          ),
        write: () =>
          Effect.sync(() => {
            writes++

            return null
          })
      })

      yield* Effect.gen(function*() {
        const loading = yield* Effect.forkChild(store.loadOrCreate(empty))
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(loading)
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(loading)))
        assert.strictEqual((yield* Effect.flip(store.loadOrCreate(empty))).code, "Storage")
        assert.strictEqual(yield* store.commit(empty), "unknown")
        assert.deepStrictEqual([reads, writes], [2, 1])
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
    }))

  it.effect("does not read or retry a creation acknowledged without an ETag", () =>
    Effect.gen(function*() {
      let reads = 0
      let writes = 0

      const store = yield* open({
        read: () =>
          Effect.sync(() => {
            reads++

            return null
          }),
        write: () =>
          Effect.sync(() => {
            writes++

            return { etag: "" }
          })
      })

      for (let attempt = 0; attempt < 2; attempt++) {
        assert.strictEqual((yield* Effect.flip(store.loadOrCreate(empty))).code, "Storage")
      }

      assert.deepStrictEqual([reads, writes], [1, 1])
    }))
})
