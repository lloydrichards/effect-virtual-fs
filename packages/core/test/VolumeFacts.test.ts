import { assert, it } from "@effect/vitest"
import { Crypto, Effect, Layer } from "effect"
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
