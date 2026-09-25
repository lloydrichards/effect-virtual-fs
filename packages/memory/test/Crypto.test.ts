import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { assert, it } from "@effect/vitest"
import { Crypto, Effect, FileSystem, Layer } from "effect"
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

it.effect("should mint a usable filesystem when no platform crypto service is provided", () =>
  Effect.gen(function*() {
    const fs = yield* MemoryFileSystem.make

    yield* fs.writeFileString("/tmp/greeting.txt", "hello")

    assert.strictEqual(yield* fs.readFileString("/tmp/greeting.txt"), "hello")
  }))

it.effect("should give each core volume a distinct identity and incarnation without a crypto service", () =>
  Effect.gen(function*() {
    const first = yield* Vfs.make()
    const second = yield* Vfs.make()

    assert.notStrictEqual(first.identity, second.identity)
    assert.notStrictEqual(first.incarnation, second.incarnation)
    assert.notStrictEqual(String(first.identity), String(first.incarnation))
  }))

it.effect("should draw identities from a supplied crypto service when one is in context", () =>
  Effect.gen(function*() {
    const volume = yield* Vfs.make()

    assert.strictEqual(volume.identity, "07".repeat(16))
    assert.strictEqual(volume.incarnation, "07".repeat(16))
  }).pipe(Effect.provide(suppliedCrypto)))

it.effect("should mint a usable filesystem when a caller supplies crypto", () =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem

    yield* fs.writeFileString("/tmp/greeting.txt", "hello")

    assert.strictEqual(yield* fs.readFileString("/tmp/greeting.txt"), "hello")
  }).pipe(Effect.provide(MemoryFileSystem.layer.pipe(Layer.provide(suppliedCrypto)))))
