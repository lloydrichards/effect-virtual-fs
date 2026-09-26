import { assert, describe, it } from "@effect/vitest"
import { Effect, Encoding, Result, Schema } from "effect"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"

const bytes = (...values: Array<number>) => new Uint8Array(values)

const IDENTITY = Vfs.VolumeIdentity.make("0123456789abcdef0123456789abcdef")

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
})
