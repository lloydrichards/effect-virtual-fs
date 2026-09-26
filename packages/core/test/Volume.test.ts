import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Crypto, Effect, Encoding, Layer, Result, Schema } from "effect"
import { LiveVolume, Testing, VirtualFileSystem as Vfs } from "../src/index.js"

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

it.layer(BunCrypto.layer)((it) => {
  it.effect(
    "should publish durability identity and incarnation when a memory volume is constructed",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()

        assert.strictEqual(volume.durability, "memory-only")
        assert.strictEqual(volume.identity, "11111111111111111111111111111111")
        assert.strictEqual(volume.incarnation, "22222222222222222222222222222222")
      }).pipe(Effect.provide(cryptoLayer(0x11, 0x22)))
  )
})

it.layer(BunCrypto.layer)((it) => {
  it.effect("should retain the supplied identity and mint a new incarnation when a volume is restored", () => {
    const identity = Vfs.VolumeIdentity.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")

    return Effect.gen(function*() {
      const original = yield* Vfs.make({ identity })
      const restored = yield* Vfs.fromSnapshot(yield* original.snapshot, { identity })

      assert.strictEqual(original.identity, identity)
      assert.strictEqual(restored.identity, identity)
      assert.strictEqual(original.incarnation, "11111111111111111111111111111111")
      assert.strictEqual(restored.incarnation, "44444444444444444444444444444444")
    }).pipe(Effect.provide(cryptoLayer(0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88)))
  })
})

it.layer(BunCrypto.layer)((it) => {
  it.effect("should mint an independent identity when restoring without one", () =>
    Effect.gen(function*() {
      const original = yield* Vfs.make()
      const restored = yield* Vfs.fromSnapshot(yield* original.snapshot)

      assert.strictEqual(original.identity, "11111111111111111111111111111111")
      assert.strictEqual(original.incarnation, "22222222222222222222222222222222")
      assert.strictEqual(restored.identity, "55555555555555555555555555555555")
      assert.strictEqual(restored.incarnation, "66666666666666666666666666666666")
    }).pipe(Effect.provide(cryptoLayer(0x11, 0x22, 0x33, 0x44, 0x55, 0x66))))
})

it.layer(BunCrypto.layer)((it) => {
  it.effect(
    "should draw each construction's reference-key epoch after its incarnation when constructing a volume",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const key = yield* volume.referenceKey(yield* (yield* volume.caller()).root)

        assert.deepStrictEqual(key.identity, new Uint8Array(16).fill(0x11))
        assert.deepStrictEqual(key.epoch, new Uint8Array(16).fill(0x33))
      }).pipe(Effect.provide(cryptoLayer(0x11, 0x22, 0x33)))
  )
})

it.layer(BunCrypto.layer)((it) => {
  it.effect(
    "should report effective limits and changing usage when files are written or restored",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller

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
      }).pipe(Effect.provide(
        Testing.layer({ volume: { maxBytes: ByteSize.bytes(20), maxEntries: 3, maxPathBytes: ByteSize.bytes(64) } })
          .pipe(
            Layer.provideMerge(cryptoLayer(0x11, 0x22, 0x33, 0x44))
          )
      ))
  )
})

it("should order durability levels from weakest to strongest when comparing published tiers", () => {
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

const HEX_128 = /^[0-9a-f]{32}$/

describe("volume identity with Crypto", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should mint distinct 128-bit values when creating identities and incarnations",
      () =>
        Effect.gen(function*() {
          const first = yield* Vfs.make()
          const second = yield* Vfs.make()

          assert.match(first.identity, HEX_128)
          assert.match(first.incarnation, HEX_128)
          assert.notStrictEqual(first.identity, second.identity)
          assert.notStrictEqual(first.incarnation, second.incarnation)
        }).pipe(Effect.provide(BunCrypto.layer))
    )
  })
})

const bytes = (...values: Array<number>) => new Uint8Array(values)

const IDENTITY = Vfs.VolumeIdentity.make("0123456789abcdef0123456789abcdef")

const liveOptions = {
  maxImageBytes: ByteSize.kilobytes(64),
  volume: {
    maxEntries: 100,
    maxBytes: ByteSize.kilobytes(32),
    maxFileBytes: ByteSize.kilobytes(16),
    maxPathBytes: ByteSize.bytes(1024)
  }
}

// A store that keeps its one image in memory, so a test can reopen the volume it committed.
const memoryStore = () => {
  let image: Uint8Array | undefined

  return Layer.succeed(
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
}

const keyOf = Effect.fnUntraced(function*(path: string) {
  const volume = yield* Vfs.Volume

  return yield* volume.referenceKey(yield* (yield* Vfs.Caller).lookup(path))
})

describe("reference keys", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should round-trip through the schema and resolve to the same object when a serialized key is decoded",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const fs = yield* Vfs.Caller
          yield* fs.writeFile("/f", bytes(1), { access: "write", create: "exclusive" })
          const reference = yield* fs.lookup("/f")
          const key = yield* volume.referenceKey(reference)

          const encoded = yield* Schema.encodeEffect(Vfs.ReferenceKey)(key)
          assert.strictEqual(encoded.ino, String((yield* fs.stat(reference)).ino))
          assert.strictEqual(
            encoded.identity,
            Encoding.encodeBase64(Result.getOrThrow(Encoding.decodeHex(volume.identity)))
          )
          assert.lengthOf(Result.getOrThrow(Encoding.decodeBase64(encoded.epoch)), 16)

          const text = yield* Schema.encodeEffect(Schema.fromJsonString(Vfs.ReferenceKey))(key)
          const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Vfs.ReferenceKey))(text)
          assert.strictEqual(yield* volume.resolveReferenceKey(decoded), reference)
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should keep the same key for an object when its path is aliased or renamed",
      () =>
        Effect.gen(function*() {
          const fs = yield* Vfs.Caller
          yield* fs.writeFile("/a", bytes(1), { access: "write", create: "exclusive" })
          yield* fs.link("/a", "/alias")
          const key = yield* keyOf("/a")
          assert.deepStrictEqual(yield* keyOf("/alias"), key)
          yield* fs.rename("/a", "/moved")
          assert.deepStrictEqual(yield* keyOf("/moved"), key)
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should remain valid for an unlinked file and go stale after deletion when the last open handle closes",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const fs = yield* Vfs.Caller
          yield* fs.mkdir("/d")
          yield* fs.writeFile("/f", bytes(1), { access: "write", create: "exclusive" })
          const directoryReference = yield* fs.lookup("/d")
          const fileReference = yield* fs.lookup("/f")
          const directory = yield* volume.referenceKey(directoryReference)
          const file = yield* volume.referenceKey(fileReference)
          const reader = yield* fs.open("/f", { access: "read" })

          yield* fs.rmdir("/d")
          yield* fs.unlink("/f")
          assert.strictEqual((yield* Effect.flip(volume.resolveReferenceKey(directory))).code, "StaleReference")
          assert.strictEqual((yield* Effect.flip(volume.referenceKey(directoryReference))).code, "StaleReference")
          assert.strictEqual((yield* fs.stat(yield* volume.resolveReferenceKey(file))).nlink, 0)
          assert.deepStrictEqual(yield* volume.referenceKey(fileReference), file)

          yield* reader.close
          assert.strictEqual((yield* Effect.flip(volume.resolveReferenceKey(file))).code, "StaleReference")
          assert.strictEqual((yield* Effect.flip(volume.referenceKey(fileReference))).code, "StaleReference")
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should refuse forged and foreign references when a key is malformed or belongs to another volume",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const other = yield* Vfs.make()
          const otherRoot = yield* (yield* other.caller()).root
          const key = yield* volume.referenceKey(yield* (yield* Vfs.Caller).root)

          // SAFETY: the forged reference deliberately bypasses the static contract to test runtime authenticity.
          const forged = {} as Vfs.ObjectReference
          assert.strictEqual((yield* Effect.flip(volume.referenceKey(forged))).code, "InvalidReference")
          assert.strictEqual((yield* Effect.flip(volume.referenceKey(otherRoot))).code, "ForeignReference")
          assert.strictEqual((yield* Effect.flip(other.resolveReferenceKey(key))).code, "ForeignReference")

          for (
            const malformed of [{ ...key, ino: 0n }, { ...key, epoch: key.epoch.subarray(1) }, {
              ...key,
              tag: key.tag.subarray(1)
            }, {}]
          ) {
            // SAFETY: a key from the wire is typed only once decoded; these skip decoding to reach the runtime check.
            const failure = yield* Effect.flip(volume.resolveReferenceKey(malformed as Vfs.ReferenceKey))
            assert.strictEqual(failure.code, "InvalidReference")
          }

          const wire = yield* Schema.encodeEffect(Vfs.ReferenceKey)(key)
          assert.isTrue(Result.isFailure(Schema.decodeResult(Vfs.ReferenceKey)({ ...wire, ino: "-1" })))
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should reject guessed keys when an inode number or tag is altered", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const fs = yield* Vfs.Caller
        yield* fs.mkdir("/secret", { mode: 0o700 })
        yield* fs.writeFile("/secret/f", bytes(42), { access: "write", create: "exclusive" })
        const root = yield* volume.referenceKey(yield* fs.root)
        const secret = yield* keyOf("/secret/f")
        const altered = secret.tag.slice()
        altered[0] = altered[0]! ^ 1

        for (
          const forged of [{ ...root, ino: secret.ino }, { ...root, ino: root.ino + 1n }, { ...secret, tag: altered }]
        ) {
          assert.strictEqual((yield* Effect.flip(volume.resolveReferenceKey(forged))).code, "InvalidReference")
        }

        // An inode number no object holds fails the same way, so a guess cannot tell used numbers from free ones.
        assert.strictEqual(
          (yield* Effect.flip(volume.resolveReferenceKey({ ...root, ino: 1_000n }))).code,
          "InvalidReference"
        )
        assert.notDeepEqual(root.tag, secret.tag)
        assert.lengthOf(secret.tag, 16)
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should derive reference-key tags from the supplied Crypto bytes", () =>
      Effect.gen(function*() {
        const first = yield* Vfs.make({ identity: IDENTITY })
        const second = yield* Vfs.make({ identity: IDENTITY })
        const firstKey = yield* first.referenceKey(yield* (yield* first.caller()).root)
        const secondKey = yield* second.referenceKey(yield* (yield* second.caller()).root)

        assert.deepStrictEqual(secondKey.identity, firstKey.identity)
        assert.deepStrictEqual(secondKey.epoch, firstKey.epoch)
        assert.strictEqual(Encoding.encodeHex(firstKey.tag), "5c9dea8d3ddda0cc23db0873f30caa04")
        assert.strictEqual(Encoding.encodeHex(secondKey.tag), "9555879bfc92f3010843f8ec5d343df1")
      }).pipe(Effect.provide(cryptoLayer(0x11, 0x22, 0x33, 0x11, 0x22, 0x44))))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should not resolve an old key when a snapshot is restored or overlaid",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const fs = yield* Vfs.Caller
          yield* fs.writeFile("/f", bytes(1), { access: "write", create: "exclusive" })
          const key = yield* keyOf("/f")
          const snapshot = yield* volume.snapshot

          const restored = yield* Vfs.fromSnapshot(snapshot, { identity: IDENTITY })
          const overlay = yield* Vfs.makeOverlay(snapshot, { identity: IDENTITY })
          const fixture = yield* Vfs.fromFixture({ entries: [] }, { identity: IDENTITY })

          for (const fork of [restored, overlay, fixture]) {
            assert.strictEqual(fork.identity, volume.identity)
            assert.strictEqual((yield* Effect.flip(fork.resolveReferenceKey(key))).code, "ForeignReference")
          }

          // The restore keeps the inode number, so only the epoch tells the two objects apart.
          const forked = yield* restored.referenceKey(yield* (yield* restored.caller()).lookup("/f"))
          assert.strictEqual(forked.ino, key.ino)
          assert.notDeepEqual(forked.epoch, key.epoch)
        }).pipe(Effect.provide(Testing.layer({ volume: { identity: IDENTITY } })))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should resolve to the same object when a live volume reopens", () =>
      Effect.gen(function*() {
        const opened = yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(liveOptions)
          const fs = yield* volume.caller()
          yield* fs.mkdir("/d")
          yield* fs.writeFile("/d/kept", bytes(7), { access: "write", create: "exclusive" })
          yield* fs.writeFile("/held", bytes(8), { access: "write", create: "exclusive" })
          const kept = yield* volume.referenceKey(yield* fs.lookup("/d/kept"))
          const held = yield* volume.referenceKey(yield* fs.lookup("/held"))
          // Unlinked while a handle holds it; after the reopen nothing does.
          yield* fs.open("/held", { access: "read" })
          yield* fs.unlink("/held")

          return { kept, held, incarnation: volume.incarnation }
        }))

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(liveOptions)
          const fs = yield* volume.caller()
          assert.notStrictEqual(volume.incarnation, opened.incarnation)

          const kept = yield* volume.resolveReferenceKey(opened.kept)
          assert.strictEqual(kept, yield* fs.lookup("/d/kept"))
          assert.deepStrictEqual(yield* fs.readFile(kept), bytes(7))
          assert.deepStrictEqual(yield* volume.referenceKey(kept), opened.kept)
          assert.strictEqual((yield* Effect.flip(volume.resolveReferenceKey(opened.held))).code, "StaleReference")
        }))
      }).pipe(Effect.provide(memoryStore())))
  })

  // Documented rather than detected: a live image has one writer, so a copy served beside it is outside the contract.
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should resolve the same object across volumes when both volumes open the same image",
      () =>
        Effect.gen(function*() {
          const image = yield* LiveVolume.prepareEmptyImage()
          const commit = () => Effect.succeed("committed" as const)
          const a = yield* LiveVolume.openImage(image, liveOptions.maxImageBytes, commit)
          const b = yield* LiveVolume.openImage(image, liveOptions.maxImageBytes, commit)
          const inA = yield* a.volume.caller()
          const inB = yield* b.volume.caller()
          yield* inA.writeFile("/a", bytes(1), { access: "write", create: "exclusive" })
          yield* inB.writeFile("/b", bytes(2), { access: "write", create: "exclusive" })

          const key = yield* a.volume.referenceKey(yield* inA.lookup("/a"))
          assert.strictEqual(yield* b.volume.resolveReferenceKey(key), yield* inB.lookup("/b"))
          yield* a.shutdown
          yield* b.shutdown
        })
    )
  })
})
