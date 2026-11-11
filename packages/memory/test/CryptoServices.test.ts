import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { MemoryFileSystem } from "../src/index.js"

// Effect's platform-neutral services, without a Node or Bun platform layer.
const memory = MemoryFileSystem.layer.pipe(
  Layer.provide(Layer.mergeAll(Digest.layerWebCrypto, SecureRandom.layerWebCrypto))
)

describe("crypto services", () => {
  it.layer(memory)((it) => {
    it.effect("should build the FileSystem service when only WebCrypto Digest and SecureRandom are provided", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem

        yield* fs.writeFileString("/greeting", "héllo 🌍")

        assert.strictEqual(yield* fs.readFileString("/greeting"), "héllo 🌍")
      }))
  })
})
