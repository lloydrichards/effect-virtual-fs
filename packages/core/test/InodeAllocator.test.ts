import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Exit, Layer } from "effect"
import { LiveVolume } from "../src/index.js"

const OPTIONS = {
  maxImageBytes: ByteSize.kilobytes(64),
  volume: {
    maxEntries: 100,
    maxBytes: ByteSize.kilobytes(32),
    maxFileBytes: ByteSize.kilobytes(16),
    maxPathBytes: ByteSize.bytes(1024)
  }
}

// A store whose empty image starts its inode allocator one below the largest safe integer.
const nearlyExhausted = Layer.succeed(
  LiveVolume.LiveImageStore,
  LiveVolume.LiveImageStore.of({
    loadOrCreate: (initial) =>
      Effect.sync(() =>
        new TextEncoder().encode(
          new TextDecoder().decode(initial).replace(
            /"nextInode":"2"/,
            `"nextInode":"${Number.MAX_SAFE_INTEGER - 1}"`
          )
        )
      ),
    commit: () => Effect.succeed("committed" as const)
  })
)

describe("the inode allocator", () => {
  it.effect("hands out inodes up to its limit, then reports NoSpace and keeps the volume usable", () =>
    Effect.scoped(Effect.gen(function*() {
      const volume = yield* LiveVolume.open(OPTIONS)
      const caller = yield* volume.caller()

      yield* caller.mkdir("/last")
      const refused = yield* Effect.flip(caller.mkdir("/beyond"))

      assert.strictEqual(refused.code, "NoSpace")
      assert.strictEqual((yield* caller.stat("/last")).kind, "directory")
      assert.isTrue(Exit.isSuccess(yield* Effect.exit(caller.rmdir("/last"))))
    })).pipe(Effect.provide(nearlyExhausted)))
})
