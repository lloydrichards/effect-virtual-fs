import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, it } from "@effect/vitest"
import { Crypto, Effect, FileSystem, Layer } from "effect"
import { layerDeterministicCrypto } from "../src/internal/crypto.js"
import * as MemoryFileSystem from "../src/MemoryFileSystem.js"

// A caller-supplied service stands in for a platform implementation such as
// `NodeCrypto` or `BunCrypto`.
const suppliedCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size).fill(7),
    digest: (_algorithm, data) => Effect.succeed(data)
  })
)

it.effect("mints a filesystem without a platform crypto service", () =>
  Effect.gen(function*() {
    const fs = yield* MemoryFileSystem.makeCrypto

    yield* fs.writeFileString("/tmp/greeting.txt", "hello")

    assert.strictEqual(yield* fs.readFileString("/tmp/greeting.txt"), "hello")
  }))

it.effect("gives each volume its own identity and incarnation", () =>
  Effect.gen(function*() {
    const first = yield* Vfs.make().pipe(Effect.provide(layerDeterministicCrypto))
    const second = yield* Vfs.make().pipe(Effect.provide(layerDeterministicCrypto))

    assert.notStrictEqual(first.identity, second.identity)
    assert.notStrictEqual(first.incarnation, second.incarnation)
    assert.notStrictEqual(String(first.identity), String(first.incarnation))
  }))

it.effect("takes a caller-supplied crypto service", () =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem

    yield* fs.writeFileString("/tmp/greeting.txt", "hello")

    assert.strictEqual(yield* fs.readFileString("/tmp/greeting.txt"), "hello")
  }).pipe(Effect.provide(MemoryFileSystem.layer.pipe(Layer.provide(suppliedCrypto)))))
