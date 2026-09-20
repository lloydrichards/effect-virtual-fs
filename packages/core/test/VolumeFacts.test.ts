import { assert, it } from "@effect/vitest"
import { ByteSize, Crypto, Effect, Layer } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const cryptoLayer = (...values: ReadonlyArray<number>) => {
  let index = 0

  return Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => new Uint8Array(size).fill(values[index++] ?? 0),
      digest: (_algorithm, data) => Effect.succeed(data)
    })
  )
}

it.effect("publishes the memory volume's durability, stable identity, and incarnation", () =>
  Effect.gen(function*() {
    const volume = yield* Vfs.make()

    assert.strictEqual(volume.durability, "memory-only")
    assert.strictEqual(volume.identity, "11111111111111111111111111111111")
    assert.strictEqual(volume.incarnation, "22222222222222222222222222222222")
  }).pipe(Effect.provide(cryptoLayer(0x11, 0x22))))

it.effect("preserves a supplied identity while minting a new incarnation", () => {
  const identity = Vfs.VolumeIdentity.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")

  return Effect.gen(function*() {
    const original = yield* Vfs.make({ identity })
    const restored = yield* Vfs.fromSnapshot(yield* original.snapshot, { identity })

    assert.strictEqual(original.identity, identity)
    assert.strictEqual(restored.identity, identity)
    assert.strictEqual(original.incarnation, "11111111111111111111111111111111")
    assert.strictEqual(restored.incarnation, "22222222222222222222222222222222")
  }).pipe(Effect.provide(cryptoLayer(0x11, 0x22)))
})

it.effect("mints an independent identity when restoring without one", () =>
  Effect.gen(function*() {
    const original = yield* Vfs.make()
    const restored = yield* Vfs.fromSnapshot(yield* original.snapshot)

    assert.strictEqual(original.identity, "11111111111111111111111111111111")
    assert.strictEqual(original.incarnation, "22222222222222222222222222222222")
    assert.strictEqual(restored.identity, "33333333333333333333333333333333")
    assert.strictEqual(restored.incarnation, "44444444444444444444444444444444")
  }).pipe(Effect.provide(cryptoLayer(0x11, 0x22, 0x33, 0x44))))

it.effect("publishes effective limits and samples live usage across writes and restore", () =>
  Effect.gen(function*() {
    const volume = yield* Vfs.make({
      maxBytes: ByteSize.bytes(20),
      maxEntries: 3,
      maxPathBytes: ByteSize.bytes(64)
    })

    const caller = yield* volume.caller()

    assert.deepStrictEqual(volume.limits, {
      maxBytes: ByteSize.bytes(20),
      maxFileBytes: ByteSize.bytes(0xffffffff),
      maxEntries: 3,
      maxPathBytes: ByteSize.bytes(64),
      maxPendingOperations: 64,
      maxWatchEvents: 256
    })
    assert.deepStrictEqual(yield* volume.usage, { usedBytes: 0n, entries: 0 })

    yield* caller.mkdir("/dir")
    yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
    assert.deepStrictEqual(yield* volume.usage, { usedBytes: 3n, entries: 2 })

    yield* caller.truncate("/file", 1n)
    assert.deepStrictEqual(yield* volume.usage, { usedBytes: 1n, entries: 2 })

    const restored = yield* Vfs.fromSnapshot(yield* volume.snapshot, { maxFileBytes: ByteSize.bytes(5) })
    assert.strictEqual(restored.limits.maxFileBytes, ByteSize.bytes(5))
    assert.deepStrictEqual(yield* restored.usage, { usedBytes: 1n, entries: 2 })
  }).pipe(Effect.provide(cryptoLayer(0x11, 0x22, 0x33, 0x44))))

it.effect("keeps unlinked open content charged until the final handle closes", () =>
  Effect.scoped(Effect.gen(function*() {
    const volume = yield* Vfs.make({ maxBytes: ByteSize.bytes(3) })
    const caller = yield* volume.caller()
    const file = yield* caller.open("/file", { access: "readWrite", create: "exclusive" })
    yield* file.write(new Uint8Array([1, 2, 3]))
    yield* caller.unlink("/file")

    assert.deepStrictEqual(yield* volume.usage, { usedBytes: 3n, entries: 0 })
    yield* file.close
    assert.deepStrictEqual(yield* volume.usage, { usedBytes: 0n, entries: 0 })
  })).pipe(Effect.provide(cryptoLayer(0x11, 0x22))))

it("orders the published durability levels from weakest to strongest", () => {
  const levels: ReadonlyArray<Vfs.VolumeDurability> = [
    "memory-only",
    "survives-process-crash",
    "survives-operating-system-crash",
    "survives-power-loss"
  ]

  for (let actual = 0; actual < levels.length; actual++) {
    for (let required = 0; required < levels.length; required++) {
      assert.strictEqual(Vfs.isVolumeDurabilityAtLeast(levels[actual]!, levels[required]!), actual >= required)
    }
  }
})
