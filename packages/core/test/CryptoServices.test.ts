import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const encoder = new TextEncoder()

// Effect's platform-neutral services, without a Node or Bun platform layer.
const webCrypto = Layer.mergeAll(Digest.layerWebCrypto, SecureRandom.layerWebCrypto)

describe("crypto services", () => {
  it.layer(webCrypto)((it) => {
    it.effect("should restore a snapshot delta when only WebCrypto Digest and SecureRandom are provided", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({
          entries: [{ kind: "file", path: "/greeting", bytes: new Uint8Array() }]
        })

        const before = yield* volume.snapshot
        const caller = yield* volume.caller()
        const bytes = encoder.encode("héllo 🌍")

        yield* caller.writeFile("/greeting", bytes, { access: "write", truncate: true })
        const delta = yield* Vfs.diffSnapshots(before, yield* volume.snapshot)
        const restored = yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(before, delta))

        assert.deepStrictEqual(yield* (yield* restored.caller()).readFile("/greeting"), bytes)
      }))
  })
})
