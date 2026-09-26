import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Encoding, Layer, Random, Result, Schema } from "effect"
import { LiveVolume, Testing, VirtualFileSystem as Vfs } from "../src/index.js"

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
  it.effect("round-trips through the schema and resolves to the same reference", () =>
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
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("names an object, not a path: aliases and renames keep the key", () =>
    Effect.gen(function*() {
      const fs = yield* Vfs.Caller
      yield* fs.writeFile("/a", bytes(1), { access: "write", create: "exclusive" })
      yield* fs.link("/a", "/alias")
      const key = yield* keyOf("/a")
      assert.deepStrictEqual(yield* keyOf("/alias"), key)
      yield* fs.rename("/a", "/moved")
      assert.deepStrictEqual(yield* keyOf("/moved"), key)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("goes stale once its object is gone, and not while a handle holds an unlinked file", () =>
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
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("refuses forged references, other volumes' references and keys, and malformed keys", () =>
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
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("cannot be guessed: a neighbouring inode number or an altered tag names nothing", () =>
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

  // A seeded Random reproduces a volume's identity and epoch, which every key carries. The secret behind the tag
  // must not follow the seed, or one key would be enough to rebuild it and forge a key for any other inode.
  it.effect("cannot be forged by replaying the Random seed: two volumes under one seed get different tags", () =>
    Effect.gen(function*() {
      const seeded = Effect.fnUntraced(function*() {
        const volume = yield* Vfs.make()

        return yield* volume.referenceKey(yield* (yield* volume.caller()).root)
      }, Random.withSeed("reference-key-secret"))

      const first = yield* seeded()
      const second = yield* seeded()

      assert.deepStrictEqual(second.identity, first.identity)
      assert.deepStrictEqual(second.epoch, first.epoch)
      assert.notDeepEqual(second.tag, first.tag)
    }))

  it.effect("never resolves in a restore or an overlay, even under the same identity", () =>
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
    }).pipe(Effect.provide(Testing.layer({ volume: { identity: IDENTITY } }))))

  it.effect("resolves to the same object after a live volume reopens", () =>
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

  // Documented rather than detected: a live image has one writer, so a copy served beside it is outside the contract.
  it.effect("resolves across two volumes opened from one image, which share its identity and epoch", () =>
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
    }))
})
