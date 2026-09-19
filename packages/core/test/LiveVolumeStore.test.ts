import { assert, describe } from "@effect/vitest"
import { ByteSize, Effect, Layer } from "effect"
import { LiveVolume } from "../src/index.js"
import { it } from "./TestEffect.js"

const options = {
  maxImageBytes: ByteSize.kilobytes(64),
  volume: {
    maxEntries: 100,
    maxBytes: ByteSize.kilobytes(32),
    maxFileBytes: ByteSize.kilobytes(16),
    maxPathBytes: ByteSize.bytes(1024)
  }
}

describe("live image store service", () => {
  it.effect("opens and commits through an injected store Layer", () => {
    let image: Uint8Array | undefined

    const store = Layer.succeed(
      LiveVolume.LiveImageStore,
      LiveVolume.LiveImageStore.of({
        loadOrCreate: (initial) => Effect.succeed(image ?? initial),
        commit: (candidate) =>
          Effect.sync(() => {
            image = candidate

            return "committed" as const
          })
      })
    )

    return Effect.gen(function*() {
      yield* Effect.scoped(Effect.gen(function*() {
        const volume = yield* LiveVolume.open(options)
        yield* (yield* volume.caller()).writeFile("/saved", new Uint8Array([4, 5]), {
          access: "write",
          create: "exclusive"
        })
      }))

      yield* Effect.scoped(Effect.gen(function*() {
        const volume = yield* LiveVolume.open(options)
        assert.deepEqual(yield* (yield* volume.caller()).readFile("/saved"), new Uint8Array([4, 5]))
      }))
    }).pipe(Effect.provide(store))
  })

  it.effect("keeps a rejected commit out of the visible volume", () =>
    Effect.scoped(Effect.gen(function*() {
      const volume = yield* LiveVolume.open(options)
      const caller = yield* volume.caller()
      assert.strictEqual((yield* Effect.flip(caller.mkdir("/rejected"))).code, "StorageRejected")
      assert.strictEqual((yield* Effect.flip(caller.stat("/rejected"))).code, "NotFound")
    })).pipe(Effect.provide(Layer.succeed(
      LiveVolume.LiveImageStore,
      LiveVolume.LiveImageStore.of({
        loadOrCreate: (initial) => Effect.succeed(initial),
        commit: () => Effect.succeed("rejected" as const)
      })
    ))))
})
