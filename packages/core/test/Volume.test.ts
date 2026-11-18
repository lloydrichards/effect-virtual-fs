/* eslint-disable effecttsgo/async-function */
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import {
  ByteSize,
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  pipe,
  PlatformError,
  Predicate,
  Result,
  Scheduler,
  Schema,
  Scope,
  Stream
} from "effect"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Base64 from "effect/encoding/Base64"
import * as Hex from "effect/encoding/Hex"
import * as TestClock from "effect/testing/TestClock"
import { BytePath, LiveVolume, Target, Testing, VirtualFileSystem as Vfs, Volume } from "../src/index.js"
import { describeTree } from "./support/describeTree.js"
import { assertHardLinkedSymlinks, hardLinkedSymlinks } from "./support/hardLinkedSymlinks.js"
import { entryNames, text } from "./support/text.js"

const cryptoLayer = (...values: ReadonlyArray<number>) => {
  let index = 0

  return Layer.mergeAll(
    Layer.succeed(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size).fill(values[index++] ?? 0))
    ),
    Layer.succeed(
      Digest.Digest,
      Digest.Digest.of({
        digest: (_algorithm, data) => Effect.succeed(data),
        digestHex: (_algorithm, data) => Effect.succeed(Hex.encode(data))
      })
    )
  )
}

it.layer(BunCrypto.layer)((it) => {
  it.effect("should retain crypto provider failures as defects during construction and snapshot hashing", () =>
    Effect.gen(function*() {
      const secureRandom = yield* SecureRandom.SecureRandom
      const digester = yield* Digest.Digest
      const failure = PlatformError.badArgument({ module: "Crypto", method: "test", description: "provider failed" })

      const random = yield* Effect.exit(
        Vfs.make().pipe(Effect.provideService(SecureRandom.SecureRandom, {
          ...secureRandom,
          randomBytes: () => Effect.die(failure)
        }))
      )

      const volume = yield* Vfs.make()

      const snapshot = yield* volume.snapshot

      const digest = yield* Effect.exit(
        Vfs.diffSnapshots(snapshot, snapshot).pipe(Effect.provideService(Digest.Digest, {
          ...digester,
          digest: () => Effect.die(failure)
        }))
      )

      const results: ReadonlyArray<Exit.Exit<unknown, unknown>> = [random, digest]

      for (const result of results) {
        assert.isTrue(Exit.isFailure(result))

        if (Exit.isFailure(result)) {
          assert.isTrue(Cause.hasDies(result.cause))
          assert.isFalse(Cause.hasFails(result.cause))
          assert.strictEqual(Cause.squash(result.cause), failure)
        }
      }
    }))

  it.effect("should reject null caller options instead of constructing a privileged caller", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      // @ts-expect-error Exercise malformed options received from JavaScript.
      const result = yield* Effect.flip(volume.caller(null))
      assert.strictEqual(result.code, "InvalidArgument")
      assert.strictEqual(result.operation, "caller")
    }))

  it.effect(
    "should publish durability identity and incarnation when memory volumes are constructed",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const next = yield* Vfs.make()

        assert.strictEqual(volume.durability, "memory-only")
        assert.strictEqual(volume.identity, "11111111111111111111111111111111")
        assert.strictEqual(volume.incarnation, "22222222222222222222222222222222")
        assert.notStrictEqual(next.identity, volume.identity)
        assert.notStrictEqual(next.incarnation, volume.incarnation)
      }).pipe(Effect.provide(cryptoLayer(0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88)))
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
    for (const close of ["explicitly", "with the scope"] as const) {
      it.effect(`keeps a reference key live until its last unlinked handle closes ${close}`, () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.make({ maxEntries: 2, maxBytes: ByteSize.bytes(1) })
          const caller = yield* volume.caller()

          const key = yield* Effect.scoped(Effect.gen(function*() {
            const handle = yield* caller.open("/file", { access: "write", create: "exclusive" })
            yield* handle.write(Uint8Array.of(7))
            const reference = yield* caller.lookup("/file")
            const key = yield* volume.referenceKey(reference)
            yield* caller.link("/file", "/alias")
            yield* caller.unlink("/file")
            assert.strictEqual(yield* caller.lookup("/alias"), reference)
            yield* caller.unlink("/alias")
            assert.strictEqual(yield* volume.resolveReferenceKey(key), reference)
            assert.deepStrictEqual(yield* volume.usage, { entries: 0, usedBytes: 1n })

            if (close === "explicitly") {
              yield* handle.close
              assert.strictEqual((yield* Effect.flip(volume.resolveReferenceKey(key))).code, "StaleReference")
            }

            return key
          }))

          assert.strictEqual((yield* Effect.flip(volume.resolveReferenceKey(key))).code, "StaleReference")
          assert.deepStrictEqual(yield* volume.usage, { entries: 0, usedBytes: 0n })
          yield* caller.writeFile("/next", Uint8Array.of(8), { access: "write", create: "exclusive" })
        }))
    }

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
            Base64.encode(Result.getOrThrow(Hex.decode(volume.identity)))
          )
          assert.lengthOf(Result.getOrThrow(Base64.decode(encoded.epoch)), 16)

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
        assert.strictEqual(Hex.encode(firstKey.tag), "5c9dea8d3ddda0cc23db0873f30caa04")
        assert.strictEqual(Hex.encode(secondKey.tag), "9555879bfc92f3010843f8ec5d343df1")
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

describe("restored volume parity", () => {
  const bytes = (value: string) => new TextEncoder().encode(value)

  const fixture: Vfs.Fixture = {
    ...hardLinkedSymlinks,
    entries: [
      ...hardLinkedSymlinks.entries,
      { kind: "hardLink", path: "/peer", target: "/a/target" },
      { kind: "directory", path: "/cache" },
      { kind: "file", path: "/cache/old", bytes: bytes("obsolete") }
    ]
  }

  const compare = Effect.fnUntraced(function*<A, E>(
    scenario: (caller: Vfs.Caller) => Effect.Effect<A, E, Scope.Scope>,
    options?: (usage: Vfs.VolumeUsage) => Vfs.VolumeOptions
  ) {
    yield* TestClock.setTime(0)
    const source = yield* Vfs.fromFixture(fixture)
    const base = yield* source.snapshot
    const limits = options?.(yield* source.usage)
    const overlay = yield* Vfs.makeOverlay(base, limits)
    const restored = yield* Vfs.fromSnapshot(base, limits)
    const outcomes = []

    for (const volume of [restored, overlay]) {
      yield* TestClock.setTime(1_000)
      const caller = yield* volume.caller()
      // Settle relatime reads before watching; observation must not masquerade as a mutation.
      yield* describeTree(caller)
      const watch = yield* volume.watch()
      const result = yield* scenario(caller)
      const state = yield* describeTree(caller)
      yield* caller.mkdir("/sentinel")

      const events = yield* watch.pipe(
        Stream.mapEffect((event) => Effect.map(Vfs.pathToBytes(event.path), (path) => `${event._tag} ${text(path)}`)),
        Stream.takeUntil((event) => event === "Create /sentinel"),
        Stream.runCollect
      )

      outcomes.push({ result, state, events, usage: yield* volume.usage })
    }

    assert.deepStrictEqual(outcomes[1], outcomes[0], "overlay differs from restored snapshot")

    return outcomes[1]!
  })

  describe("overlay parity with restored snapshots", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect("should retain old handles and aliases when a file is edited, unlinked and recreated", () =>
        Effect.gen(function*() {
          const { result: observed } = yield* compare(Effect.fnUntraced(function*(caller) {
            const reference = yield* caller.lookup("/a/target")
            const old = yield* caller.open("/a/target", { access: "readWrite" })
            yield* old.pwrite(bytes("edited"), 0n)
            yield* caller.unlink("/a/target")
            yield* caller.writeFile("/a/target", bytes("fresh"), { access: "write", create: "exclusive" })

            return {
              old: text((yield* old.pread(16, 0n)).bytes),
              peer: text(yield* caller.readFile("/peer")),
              current: text(yield* caller.readFile("/a/link")),
              peerRetainsIdentity: (yield* caller.lookup("/peer")) === reference,
              recreatedHasNewIdentity: (yield* caller.lookup("/a/target")) !== reference
            }
          }))

          assert.deepStrictEqual(observed, {
            old: "edited",
            peer: "edited",
            current: "fresh",
            peerRetainsIdentity: true,
            recreatedHasNewIdentity: true
          })
        }))

      it.effect("should retain directory callers and relative links when a base directory moves", () =>
        Effect.gen(function*() {
          const { result: observed } = yield* compare(Effect.fnUntraced(function*(caller) {
            const directory = yield* caller.openDirectory("/c")
            const reference = yield* caller.lookup("/c")
            yield* caller.rename("/c", "/moved")

            return {
              relative: text(yield* caller.readFile(Vfs.Target.Path({ path: "link", relativeTo: directory }))),
              path: text(yield* caller.readFile("/moved/link")),
              sameDirectory: (yield* caller.lookup("/moved")) === reference,
              oldPath: (yield* Effect.flip(caller.stat("/c"))).code
            }
          }))

          assert.deepStrictEqual(observed, { relative: "c", path: "c", sameDirectory: true, oldPath: "NotFound" })
        }))

      it.effect("should keep replaced destination handles readable when renaming over a base file", () =>
        Effect.gen(function*() {
          const { result: observed } = yield* compare(Effect.fnUntraced(function*(caller) {
            const old = yield* caller.open("/b/target", { access: "read" })
            yield* caller.rename("/a/target", "/b/target")

            return {
              oldDestination: text((yield* old.pread(16, 0n)).bytes),
              currentDestination: text(yield* caller.readFile("/b/link")),
              missingSourceTarget: (yield* Effect.flip(caller.readFile("/a/link"))).code,
              peerSharesDestination: (yield* caller.lookup("/peer")) === (yield* caller.lookup("/b/target"))
            }
          }))

          assert.deepStrictEqual(observed, {
            oldDestination: "b",
            currentDestination: "a",
            missingSourceTarget: "NotFound",
            peerSharesDestination: true
          })
        }))

      it.effect("should keep deleted children absent when a base directory is removed and recreated", () =>
        Effect.gen(function*() {
          const { result: observed } = yield* compare(Effect.fnUntraced(function*(caller) {
            const old = yield* caller.lookup("/cache")
            yield* caller.unlink("/cache/old")
            yield* caller.rmdir("/cache")
            yield* caller.mkdir("/cache")

            return {
              names: entryNames(yield* caller.readDirectory("/cache")),
              missingChild: (yield* Effect.flip(caller.stat("/cache/old"))).code,
              staleDirectory: (yield* Effect.flip(caller.stat(old))).code,
              newIdentity: (yield* caller.lookup("/cache")) !== old
            }
          }))

          assert.deepStrictEqual(observed, {
            names: [],
            missingChild: "NotFound",
            staleDirectory: "StaleReference",
            newIdentity: true
          })
        }))

      it.effect("should leave state and watch events unchanged when mutations are rejected", () =>
        Effect.gen(function*() {
          const observed = yield* compare(Effect.fnUntraced(function*(caller) {
            const before = yield* describeTree(caller)
            const root = yield* caller.stat("/")

            const codes = [
              (yield* Effect.flip(caller.rename("/missing", "/a/target"))).code,
              (yield* Effect.flip(caller.mkdir("/a/target"))).code,
              (yield* Effect.flip(
                caller.writeFile("/a/target", bytes("wrong"), { access: "write", create: "exclusive" })
              )).code
            ]

            assert.deepStrictEqual(yield* describeTree(caller), before)
            assert.deepStrictEqual(yield* caller.stat("/"), root)

            return codes
          }))

          assert.deepStrictEqual(observed.result, ["NotFound", "AlreadyExists", "AlreadyExists"])
          assert.deepStrictEqual(observed.events, ["Create /sentinel"])
        }))

      it.effect("should retain the allowed prefix and reject further growth when a write reaches the byte quota", () =>
        Effect.gen(function*() {
          const { result: observed } = yield* compare(
            Effect.fnUntraced(function*(caller) {
              const handle = yield* caller.open("/a/target", { access: "readWrite" })
              const written = yield* handle.pwrite(bytes("WXYZ"), 1n)
              const before = yield* caller.stat("/a/target")
              const rejected = yield* Effect.flip(handle.pwrite(bytes("!"), 3n))
              assert.deepStrictEqual(yield* caller.stat("/a/target"), before)

              return {
                written,
                code: rejected.code,
                content: text(yield* caller.readFile("/a/target")),
                peer: text(yield* caller.readFile("/peer"))
              }
            }),
            (usage) => ({ maxBytes: ByteSize.bytes(Number(usage.usedBytes) + 2) })
          )

          assert.deepStrictEqual(observed, { written: 2, code: "NoSpace", content: "aWX", peer: "aWX" })
        }))
    })
  })
})

describe("overlays", () => {
  const bytes = (value: string) => new TextEncoder().encode(value)

  const text = (value: Uint8Array) => new TextDecoder().decode(value)

  const pathText = (path: Vfs.BytePath) => Vfs.pathToBytes(path).pipe(Effect.map(text))

  const changePaths = (changes: ReadonlyArray<Vfs.OverlayChange>) =>
    Effect.forEach(changes, (change): Effect.Effect<string, Vfs.VfsError> => {
      if (Predicate.isTagged("Renamed")(change)) {
        return Effect.all({ from: pathText(change.from), to: pathText(change.to) }).pipe(
          Effect.map(({ from, to }) => `${change._tag}:${from}->${to}`)
        )
      }

      return pathText(change.path).pipe(Effect.map((path) => `${change._tag}:${path}`))
    })

  describe("overlay volumes", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect("should keep cross-parent symlink aliases isolated when one workspace renames and unlinks them", () =>
        Effect.gen(function*() {
          const source = yield* Vfs.fromFixture(hardLinkedSymlinks)
          const base = yield* source.snapshot
          const changed = yield* Vfs.makeOverlay(base)
          const sibling = yield* Vfs.makeOverlay(base)
          const caller = yield* changed.caller()
          yield* assertHardLinkedSymlinks(caller)
          const reference = yield* caller.lookup("/b/link")
          yield* caller.rename("/b/link", "/c/moved")
          yield* caller.unlink("/a/link")
          assert.strictEqual(yield* caller.lookup("/c/moved"), reference)
          assert.strictEqual(yield* caller.lookup("/c/link"), reference)
          assert.strictEqual((yield* caller.stat(reference)).nlink, 2)
          assert.strictEqual((yield* caller.stat(reference)).kind, "symlink")
          assert.deepStrictEqual(yield* caller.readLink(reference), bytes("target"))
          assert.deepStrictEqual(yield* caller.readFile("/c/moved"), bytes("c"))
          assert.strictEqual((yield* Effect.flip(caller.readFile("/a/link"))).code, "NotFound")
          yield* assertHardLinkedSymlinks(yield* sibling.caller())
          yield* assertHardLinkedSymlinks(yield* source.caller())
          yield* assertHardLinkedSymlinks(yield* (yield* Vfs.fromSnapshot(base)).caller())
          yield* caller.unlink("/c/moved")
          assert.deepStrictEqual(yield* caller.readLink(reference), bytes("target"))
          yield* caller.unlink("/c/link")
          assert.strictEqual((yield* Effect.flip(caller.stat(reference))).code, "StaleReference")
        }))

      it.effect(
        "should expose an isolated Volume when creating sibling overlays from one base",
        () =>
          Effect.gen(function*() {
            const source = yield* Vfs.fromFixture({
              entries: [
                { kind: "file", path: "/shared", bytes: bytes("base") },
                { kind: "hardLink", path: "/alias", target: "/shared" }
              ]
            })

            const base = yield* source.snapshot
            const first = yield* Vfs.makeOverlay(base)
            const second = yield* Vfs.makeOverlay(base)
            const ordinary: Vfs.Volume = first
            const a = yield* ordinary.caller()
            const b = yield* second.caller()

            const old = yield* a.open("/shared", { access: "readWrite" })
            yield* old.pwrite(bytes("X"), 1n)
            yield* a.chmod("/alias", 0o600)
            yield* a.rename("/shared", "/moved")

            assert.strictEqual(text(yield* a.readFile("/alias")), "bXse")
            assert.strictEqual(text((yield* old.pread(4, 0n)).bytes), "bXse")
            assert.strictEqual((yield* a.stat("/alias")).ino, (yield* a.stat("/moved")).ino)
            assert.strictEqual(text(yield* b.readFile("/shared")), "base")
            assert.strictEqual((yield* b.stat("/shared")).mode, 0o644)
            assert.strictEqual(text(yield* (yield* source.caller()).readFile("/shared")), "base")
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should enforce whole-volume quotas when content is promoted or partially written",
        () =>
          Effect.gen(function*() {
            const source = yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: bytes("abcd") }] })
            const base = yield* source.snapshot
            const tooSmall = yield* Effect.flip(Vfs.makeOverlay(base, { maxBytes: ByteSize.bytes(3) }))
            assert.instanceOf(tooSmall, Vfs.VfsError)
            assert.strictEqual(tooSmall.code, "LimitExceeded")

            const overlay = yield* Vfs.makeOverlay(base, { maxBytes: ByteSize.bytes(5) })
            const fs = yield* overlay.caller()
            const handle = yield* fs.open("/f", { access: "readWrite" })
            assert.strictEqual(yield* handle.pwrite(bytes("WXYZ"), 4n), 1)
            assert.strictEqual(text(yield* fs.readFile("/f")), "abcdW")
            assert.strictEqual(yield* handle.pwrite(bytes("Q"), 0n), 1)
            assert.strictEqual(text(yield* fs.readFile("/f")), "QbcdW")

            const before = yield* fs.stat("/f")
            const noSpace = yield* Effect.flip(fs.writeFile("/f", bytes("longer"), { access: "write", truncate: true }))
            assert.strictEqual(noSpace.code, "NoSpace")
            assert.deepStrictEqual(yield* fs.stat("/f"), before)
            assert.strictEqual(text(yield* fs.readFile("/f")), "QbcdW")
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should isolate the base and siblings when an overlay replaces whole-file content",
        () =>
          Effect.gen(function*() {
            const base = yield* (yield* Vfs.fromFixture({
              entries: [{ kind: "file", path: "/f", bytes: bytes("abcd") }]
            })).snapshot

            const cases: ReadonlyArray<
              readonly [string, (fs: Vfs.Caller) => Effect.Effect<void, Vfs.VfsError, Scope.Scope>]
            > = [
              ["handle write", (fs) =>
                Effect.gen(function*() {
                  const file = yield* fs.open("/f", { access: "write" })
                  yield* file.write(bytes("WXYZ"))
                })],
              ["append", (fs) =>
                Effect.gen(function*() {
                  const file = yield* fs.open("/f", { access: "write", append: true })
                  yield* file.write(bytes("!"))
                })],
              ["handle truncate", (fs) =>
                Effect.gen(function*() {
                  const file = yield* fs.open("/f", { access: "write" })
                  yield* file.truncate(2n)
                })],
              ["path truncate", (fs) => fs.truncate("/f", 2n)],
              ["writeFile", (fs) => fs.writeFile("/f", bytes("WXYZ"), { access: "write", truncate: true })],
              ["open truncate", (fs) => Effect.asVoid(fs.open("/f", { access: "write", truncate: true }))]
            ]

            for (const [label, mutate] of cases) {
              const changed = yield* Vfs.makeOverlay(base)
              const sibling = yield* Vfs.makeOverlay(base)
              yield* mutate(yield* changed.caller())
              assert.deepStrictEqual(yield* (yield* sibling.caller()).readFile("/f"), bytes("abcd"), label)
              assert.deepStrictEqual(
                yield* (yield* (yield* Vfs.fromSnapshot(base)).caller()).readFile("/f"),
                bytes("abcd"),
                label
              )
            }
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should charge unlinked content when a handle remains open", () =>
        Effect.gen(function*() {
          const base = yield* (yield* Vfs.fromFixture({
            entries: [{ kind: "file", path: "/held", bytes: bytes("abc") }]
          })).snapshot

          const overlay = yield* Vfs.makeOverlay(base, { maxBytes: ByteSize.bytes(3) })
          const fs = yield* overlay.caller()
          const scope = yield* Scope.make()
          const held = yield* fs.open("/held", { access: "read" }).pipe(Scope.provide(scope))
          yield* fs.unlink("/held")

          const blocked = yield* Effect.flip(
            fs.writeFile("/new", bytes("x"), { access: "write", create: "exclusive" })
          )

          assert.strictEqual(blocked.code, "NoSpace")
          assert.strictEqual(text((yield* held.pread(3, 0n)).bytes), "abc")
          yield* Scope.close(scope, Exit.void)
          yield* fs.writeFile("/new", bytes("x"), { access: "write", create: "exclusive" })
          assert.strictEqual(text(yield* fs.readFile("/new")), "x")
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should enforce permissions and reject foreign handles when overlays are separate",
        () =>
          Effect.gen(function*() {
            const base = yield* (yield* Vfs.fromFixture({
              entries: [{ kind: "file", path: "/private", bytes: bytes("secret"), metadata: { mode: 0o600, uid: 7 } }]
            })).snapshot

            const first = yield* Vfs.makeOverlay(base)
            const second = yield* Vfs.makeOverlay(base)
            const owner = yield* first.caller({ identity: { uid: 7, gid: 7, groups: [], privileged: false } })
            const stranger = yield* first.caller({ identity: { uid: 8, gid: 8, groups: [], privileged: false } })
            const foreign = yield* (yield* second.caller()).open("/private", { access: "read" })
            assert.strictEqual((yield* Effect.flip(stranger.readFile("/private"))).code, "AccessDenied")
            assert.strictEqual((yield* Effect.flip(owner.chmod(foreign, 0o644))).code, "ForeignHandle")
            assert.strictEqual(text(yield* owner.readFile("/private")), "secret")
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should preserve raw and .wh. names when they appear in overlay paths", () =>
        Effect.gen(function*() {
          const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))

          const base = yield* (yield* Vfs.fromFixture({
            entries: [
              { kind: "file", path: raw, bytes: bytes("raw") },
              { kind: "file", path: "/.wh.hidden", bytes: bytes("literal") }
            ]
          })).snapshot

          const overlay = yield* Vfs.makeOverlay(base)
          const fs = yield* overlay.caller()
          yield* fs.unlink(raw)
          yield* fs.writeFile("/.wh.hidden", bytes("changed"), { access: "write", truncate: true })
          const changes = yield* overlay.changes()
          const removed = changes.find(Predicate.isTagged("Removed"))
          assert.isDefined(removed)

          if (!Predicate.isTagged("Removed")(removed)) return yield* Effect.die("expected a removed change")
          assert.deepStrictEqual(yield* Vfs.pathToBytes(removed.path), new Uint8Array([47, 255]))
          assert.strictEqual(text(yield* fs.readFile("/.wh.hidden")), "changed")
          assert.deepStrictEqual(
            yield* changePaths(changes.filter((change) => !Predicate.isTagged("Removed")(change))),
            [
              "Updated:/.wh.hidden"
            ]
          )
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should keep a complete capture stable when an existing alias handle later overwrites equal-sized content",
        () =>
          Effect.gen(function*() {
            const base = yield* (yield* Vfs.fromFixture({
              entries: [
                { kind: "file", path: "/f", bytes: bytes("base") },
                { kind: "hardLink", path: "/alias", target: "/f" }
              ]
            })).snapshot

            const overlay = yield* Vfs.makeOverlay(base)
            const fs = yield* overlay.caller()
            const preexistingAlias = yield* fs.open("/alias", { access: "readWrite" })
            yield* fs.writeFile("/f", bytes("edit"), { access: "write", truncate: true })
            const captured = yield* overlay.capture()
            yield* preexistingAlias.pwrite(bytes("LATE"), 0n)

            const capturedFs = yield* (yield* Vfs.fromSnapshot(captured.snapshot)).caller()
            assert.strictEqual(text(yield* capturedFs.readFile("/f")), "edit")
            assert.strictEqual(text(yield* capturedFs.readFile("/alias")), "edit")
            assert.deepStrictEqual(yield* changePaths(captured.changes), ["Updated:/alias", "Updated:/f"])
            const restoredOverlay = yield* Vfs.makeOverlay(captured.snapshot)
            assert.deepStrictEqual(yield* restoredOverlay.changes(), [])
            assert.strictEqual(text(yield* (yield* restoredOverlay.caller()).readFile("/f")), "edit")
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should preserve workspace state when invalid summary options are rejected",
        () =>
          Effect.gen(function*() {
            const base =
              yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: bytes("base") }] }))
                .snapshot

            const overlay = yield* Vfs.makeOverlay(base)

            // SAFETY: These deliberately malformed objects exercise runtime option validation.
            const invalid = [
              // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime validation requires an invalid typed input.
              { includeTimestamps: "yes" } as unknown as Vfs.OverlayChangesOptions,
              // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime validation requires an invalid typed input.
              { unexpected: true } as unknown as Vfs.OverlayChangesOptions
            ]

            for (const options of invalid) {
              assert.instanceOf(yield* Effect.flip(overlay.changes(options)), Vfs.VfsError)
              assert.instanceOf(yield* Effect.flip(overlay.capture(options)), Vfs.VfsError)
            }

            assert.deepStrictEqual(yield* overlay.changes(), [])
            assert.strictEqual(text(yield* (yield* overlay.caller()).readFile("/f")), "base")
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should report rename and removal when the destination is occupied", () =>
        Effect.gen(function*() {
          const base = yield* (yield* Vfs.fromFixture({
            entries: [
              { kind: "file", path: "/from", bytes: bytes("moving") },
              { kind: "file", path: "/to", bytes: bytes("displaced") }
            ]
          })).snapshot

          const overlay = yield* Vfs.makeOverlay(base)
          yield* (yield* overlay.caller()).rename("/from", "/to")
          const changes = yield* overlay.changes()
          assert.deepStrictEqual(yield* changePaths(changes), [
            "Renamed:/from->/to",
            "Removed:/to"
          ])
          assert.isTrue(Predicate.isTagged("Renamed")(changes[0]))
          assert.isTrue(Predicate.isTagged("Removed")(changes[1]))

          if (Predicate.isTagged("Renamed")(changes[0]) && Predicate.isTagged("Removed")(changes[1])) {
            assert.deepStrictEqual([changes[0].kind, changes[0].differences, changes[1].kind], ["file", [], "file"])
          }
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should report both retained identities when overlay paths swap", () =>
        Effect.gen(function*() {
          const base = yield* (yield* Vfs.fromFixture({
            entries: [
              { kind: "file", path: "/a", bytes: bytes("one") },
              { kind: "file", path: "/b", bytes: bytes("two") }
            ]
          })).snapshot

          const overlay = yield* Vfs.makeOverlay(base)
          const fs = yield* overlay.caller()
          yield* fs.rename("/a", "/temporary")
          yield* fs.rename("/b", "/a")
          yield* fs.rename("/temporary", "/b")
          assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), [
            "Renamed:/a->/b",
            "Renamed:/b->/a"
          ])
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should avoid guessing renames when every hard-link alias moves", () =>
        Effect.gen(function*() {
          const base = yield* (yield* Vfs.fromFixture({
            entries: [
              { kind: "file", path: "/a", bytes: bytes("shared") },
              { kind: "hardLink", path: "/b", target: "/a" }
            ]
          })).snapshot

          const overlay = yield* Vfs.makeOverlay(base)
          const fs = yield* overlay.caller()
          yield* fs.rename("/a", "/c")
          yield* fs.rename("/b", "/d")
          assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), [
            "Removed:/a",
            "Removed:/b",
            "Added:/c",
            "Added:/d"
          ])
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should report replacement when a path receives a new equal-content identity",
        () =>
          Effect.gen(function*() {
            const base =
              yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/x", bytes: bytes("same") }] }))
                .snapshot

            const overlay = yield* Vfs.makeOverlay(base)
            const fs = yield* overlay.caller()
            yield* fs.unlink("/x")
            yield* fs.writeFile("/x", bytes("same"), { access: "write", create: "exclusive" })
            const changes = yield* overlay.changes()
            assert.deepStrictEqual(yield* changePaths(changes), ["Replaced:/x"])

            if (!Predicate.isTagged("Replaced")(changes[0])) return yield* Effect.die("expected replacement")
            assert.deepStrictEqual(
              [changes[0].beforeKind, changes[0].afterKind, changes[0].differences],
              ["file", "file", []]
            )
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should hide timestamp-only changes when timestamps are not requested", () =>
        Effect.gen(function*() {
          const base = yield* (yield* Vfs.fromFixture({
            entries: [{ kind: "file", path: "/f", bytes: bytes("value") }]
          })).snapshot

          const overlay = yield* Vfs.makeOverlay(base)
          const fs = yield* overlay.caller()
          yield* fs.utimes("/f", {
            access: { kind: "value", nanoseconds: 10n },
            modification: { kind: "value", nanoseconds: 20n }
          })
          assert.deepStrictEqual(yield* overlay.changes(), [])
          assert.deepStrictEqual(yield* changePaths(yield* overlay.changes({ includeTimestamps: true })), [
            "Updated:/f"
          ])
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should keep old resources bound to their workspace when a new overlay is created",
        () =>
          Effect.gen(function*() {
            const base =
              yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: bytes("base") }] }))
                .snapshot

            const old = yield* Vfs.makeOverlay(base)
            const oldCaller = yield* old.caller()
            const oldHandle = yield* oldCaller.open("/f", { access: "readWrite" })

            const oldWatch = yield* (yield* old.watch()).pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.forkChild({ startImmediately: true })
            )

            const fresh = yield* Vfs.makeOverlay(base)
            const freshCaller = yield* fresh.caller()
            yield* freshCaller.writeFile("/f", bytes("new"), { access: "write", truncate: true })
            yield* Effect.yieldNow
            assert.isUndefined(oldWatch.pollUnsafe())
            yield* oldHandle.pwrite(bytes("X"), 0n)
            assert.strictEqual(text((yield* oldHandle.pread(4, 0n)).bytes), "Xase")
            assert.strictEqual(text(yield* oldCaller.readFile("/f")), "Xase")
            assert.strictEqual(text(yield* freshCaller.readFile("/f")), "new")
            assert.strictEqual((yield* Fiber.join(oldWatch)).length, 1)
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should report an unambiguous alias rename when one hard-link name moves",
        () =>
          Effect.gen(function*() {
            const base = yield* (yield* Vfs.fromFixture({
              entries: [
                { kind: "file", path: "/a", bytes: bytes("shared") },
                { kind: "hardLink", path: "/b", target: "/a" }
              ]
            })).snapshot

            const overlay = yield* Vfs.makeOverlay(base)
            yield* (yield* overlay.caller()).rename("/b", "/c")
            assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), ["Renamed:/b->/c"])
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should avoid inferring a rename when equal content has a new identity",
        () =>
          Effect.gen(function*() {
            const base =
              yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("same") }] }))
                .snapshot

            const overlay = yield* Vfs.makeOverlay(base)
            const fs = yield* overlay.caller()
            yield* fs.unlink("/a")
            yield* fs.writeFile("/b", bytes("same"), { access: "write", create: "exclusive" })
            assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), ["Removed:/a", "Added:/b"])
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should report additions and removals when one hard-link alias changes",
        () =>
          Effect.gen(function*() {
            const single =
              yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("x") }] }))
                .snapshot

            const linked = yield* Vfs.makeOverlay(single)
            yield* (yield* linked.caller()).link("/a", "/b")
            assert.deepStrictEqual(yield* changePaths(yield* linked.changes()), ["Added:/b"])

            const aliased = yield* (yield* Vfs.fromFixture({
              entries: [
                { kind: "file", path: "/a", bytes: bytes("x") },
                { kind: "hardLink", path: "/b", target: "/a" }
              ]
            })).snapshot

            const unlinked = yield* Vfs.makeOverlay(aliased)
            yield* (yield* unlinked.caller()).unlink("/b")
            assert.deepStrictEqual(yield* changePaths(yield* unlinked.changes()), ["Removed:/b"])
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should omit a content edit when it is reverted before comparison", () =>
        Effect.gen(function*() {
          const base =
            yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("base") }] }))
              .snapshot

          const overlay = yield* Vfs.makeOverlay(base)
          const fs = yield* overlay.caller()
          yield* fs.writeFile("/a", bytes("edit"), { access: "write", truncate: true })
          yield* fs.writeFile("/a", bytes("base"), { access: "write", truncate: true })
          assert.deepStrictEqual(yield* overlay.changes(), [])
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should report an addition when a rename source gets a new occupant", () =>
        Effect.gen(function*() {
          const base =
            yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("moved") }] }))
              .snapshot

          const overlay = yield* Vfs.makeOverlay(base)
          const fs = yield* overlay.caller()
          yield* fs.rename("/a", "/b")
          yield* fs.writeFile("/a", bytes("new"), { access: "write", create: "exclusive" })
          assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), ["Added:/a", "Renamed:/a->/b"])
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should order reported differences when metadata and timestamps change",
        () =>
          Effect.gen(function*() {
            const base = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("v") }] }))
              .snapshot

            const overlay = yield* Vfs.makeOverlay(base)
            const fs = yield* overlay.caller()
            yield* fs.chmod("/a", 0o600)
            yield* fs.utimes("/a", {
              access: { kind: "value", nanoseconds: 10n },
              modification: { kind: "value", nanoseconds: 20n }
            })

            const plain = yield* overlay.changes()
            const timed = yield* overlay.changes({ includeTimestamps: true })
            const [first] = plain
            const [firstTimed] = timed
            assert.isDefined(first)
            assert.isDefined(firstTimed)

            if (!Predicate.isTagged("Updated")(first) || !Predicate.isTagged("Updated")(firstTimed)) {
              return yield* Effect.die("expected updated changes")
            }

            assert.deepStrictEqual(first.differences, ["mode"])
            // Explicit utimes values report atime and mtime; the chmod's ctime bump is not reported.
            assert.deepStrictEqual(firstTimed.differences, ["mode", "atimeNs", "mtimeNs"])
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should sort changed paths bytewise when names contain raw bytes", () =>
        Effect.gen(function*() {
          const base = yield* (yield* Vfs.fromFixture({ entries: [] })).snapshot
          const overlay = yield* Vfs.makeOverlay(base)
          const fs = yield* overlay.caller()

          for (const raw of [[47, 255], [47, 1, 1], [47, 1]]) {
            const path = yield* Vfs.pathFromBytes(new Uint8Array(raw))
            yield* fs.writeFile(path, bytes("x"), { access: "write", create: "exclusive" })
          }

          const changes = yield* overlay.changes()

          const paths = yield* Effect.forEach(changes, (change) =>
            Predicate.isTagged("Renamed")(change)
              ? Effect.die("expected path changes")
              : Effect.map(Vfs.pathToBytes(change.path), (value) => [...value]))

          assert.deepStrictEqual(paths, [[47, 1], [47, 1, 1], [47, 255]])
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should list a directory and its descendants separately when both are added",
        () =>
          Effect.gen(function*() {
            const base = yield* (yield* Vfs.fromFixture({ entries: [] })).snapshot
            const overlay = yield* Vfs.makeOverlay(base)
            const fs = yield* overlay.caller()
            yield* fs.mkdir("/dir")
            yield* fs.writeFile("/dir/file", bytes("x"), { access: "write", create: "exclusive" })
            assert.deepStrictEqual(yield* changePaths(yield* overlay.changes()), ["Added:/dir", "Added:/dir/file"])
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should return a frozen change collection when overlay changes are observed",
        () =>
          Effect.gen(function*() {
            const base = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("v") }] }))
              .snapshot

            const overlay = yield* Vfs.makeOverlay(base)
            const fs = yield* overlay.caller()
            yield* fs.chmod("/a", 0o600)
            yield* fs.mkdir("/dir")
            const changes = yield* overlay.changes()
            assert.strictEqual(changes.length, 2)
            assert.isTrue(Object.isFrozen(changes))
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should leave the base untouched when an overlay limit is invalid", () =>
        Effect.gen(function*() {
          const base = yield* (yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/a", bytes: bytes("v") }] }))
            .snapshot

          const before = yield* Vfs.encodeSnapshot(base)
          // @ts-expect-error exercises runtime rejection of a value outside the public ByteSize contract
          assert.instanceOf(yield* Effect.flip(Vfs.makeOverlay(base, { maxBytes: -1 })), Vfs.VfsError)
          assert.deepStrictEqual(yield* Vfs.encodeSnapshot(base), before)
        }))
    })
  })
})

describe("crypto dependencies", () => {
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
})

describe("execution modes", () => {
  const makeRuntime = (options?: Vfs.VolumeOptions) => Vfs.make(options).pipe(Effect.provide(NodeCrypto.layer))

  const run = Effect.runSync

  const text = new TextEncoder()

  const create = { access: "write", create: "exclusive" } as const

  const failure = <A>(effect: Effect.Effect<A, Vfs.VfsError>) => {
    const exit = Effect.runSyncExit(effect)
    assert.isTrue(Exit.isFailure(exit))

    if (Exit.isSuccess(exit)) return assert.fail("Expected failure")
    const error = Cause.squash(exit.cause)

    if (!Schema.is(Vfs.VfsError)(error)) return assert.fail(`Expected settled VfsError: ${String(error)}`)

    return error
  }

  const withNanos = (clock: Clock.Clock, nanos: () => bigint): Clock.Clock => ({
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
    currentTimeMillis: clock.currentTimeMillis,
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    sleep: (duration) => clock.sleep(duration)
  })

  const make = (options?: Vfs.VolumeOptions) =>
    Effect.runPromise(Vfs.make(options).pipe(Effect.provide(NodeCrypto.layer)))

  describe("volume execution", () => {
    it("shares a sync volume across forked and synchronously evaluated Effects", async () => {
      const volume = await make({ execution: "sync" })
      const caller = run(volume.caller())
      const deep = "/" + Array(160).fill("d").join("/")
      const mutation = Effect.runFork(caller.mkdir(deep, { recursive: true }))
      run(caller.mkdir("/sync"))
      await Effect.runPromise(Fiber.join(mutation))
      assert.strictEqual(run(caller.stat("/sync")).kind, "directory")
      const scope = Scope.makeUnsafe()
      const rooted = run(caller.withRoot(deep).pipe(Effect.provideService(Scope.Scope, scope)))
      run(rooted.writeFile("/data", text.encode("shared"), create))
      assert.deepStrictEqual(await Effect.runPromise(caller.readFile(deep + "/data")), text.encode("shared"))
      run(Scope.close(scope, Exit.void))
      assert.strictEqual(failure(rooted.stat("/")).code, "ClosedCaller")
    })

    for (const operation of ["handle", "realPath"] as const) {
      it(`should complete deep confined ${operation} traversal and scope cleanup synchronously`, async () => {
        const volume = await make({ execution: "sync" })
        const caller = run(volume.caller())
        const deep = "/" + Array(160).fill("d").join("/")
        run(caller.mkdir("/root" + deep, { recursive: true }))
        const scope = Scope.makeUnsafe()
        const rooted = run(caller.withRoot("/root").pipe(Effect.provideService(Scope.Scope, scope)))

        const ordinary = new Scheduler.MixedScheduler("sync")
        let scheduled = 0

        const scheduler: Scheduler.Scheduler = {
          executionMode: "sync",
          shouldYield: () => false,
          makeDispatcher: () => {
            const dispatcher = ordinary.makeDispatcher()

            return {
              scheduleTask: (task, priority) => {
                scheduled++
                dispatcher.scheduleTask(task, priority)
              },
              flush: () => dispatcher.flush()
            }
          }
        }

        const result = Effect.runSyncExit(
          Effect.gen(function*() {
            const handle = yield* rooted.openDirectory(deep)

            if (operation === "handle") assert.strictEqual((yield* handle.stat).kind, "directory")
            else assert.strictEqual(yield* BytePath.toString(yield* rooted.realPath(handle)), deep)

            return handle
          }).pipe(Effect.provideService(Scope.Scope, scope), Effect.provideService(Scheduler.Scheduler, scheduler))
        )

        run(Scope.close(scope, Exit.void))
        assert.isTrue(Exit.isSuccess(result))
        assert.strictEqual(scheduled, 0)

        if (Exit.isSuccess(result)) assert.strictEqual(failure(result.value.stat).code, "InvalidHandle")
        assert.strictEqual(failure(rooted.stat("/")).code, "ClosedCaller")
      })
    }

    for (const execution of ["cooperative", "sync"] as const) {
      it(`should preserve positional I/O, links, open-unlinked files and admission reuse in ${execution} mode`, async () => {
        const volume = run(makeRuntime({ execution, maxPendingOperations: 1 }))
        const caller = run(volume.caller())
        const scope = Scope.makeUnsafe()
        await Effect.runPromise(caller.writeFile("/file", text.encode("abcd"), create))

        const handle = run(
          caller.open("/file", { access: "readWrite" }).pipe(Effect.provideService(Scope.Scope, scope))
        )

        run(caller.link("/file", "/alias"))
        assert.deepStrictEqual(run(handle.read(1)), text.encode("a"))
        assert.deepStrictEqual(run(handle.pread(2, 1n)).bytes, text.encode("bc"))
        run(handle.pwrite(text.encode("X"), 2n))
        assert.strictEqual(run(handle.seek(0n, "current")), 1n)
        run(handle.write(text.encode("Y")))
        assert.deepStrictEqual(run(caller.readFile("/alias")), text.encode("aYXd"))
        run(caller.unlink("/file"))
        run(caller.unlink("/alias"))
        assert.strictEqual(run(volume.usage).usedBytes, 4n)
        run(handle.close)
        run(Scope.close(scope, Exit.void))
        assert.strictEqual(run(volume.usage).usedBytes, 0n)
        assert.strictEqual(failure(handle.stat).code, "InvalidHandle")
        run(caller.mkdir("/after-close"))
      })
    }

    it("should restore or overlay with an independent execution mode", async () => {
      const original = await make({ execution: "sync" })
      run((run(original.caller())).writeFile("/file", text.encode("before"), create))
      const snapshot = run(original.snapshot)

      const restored = await Effect.runPromise(
        Vfs.fromSnapshot(snapshot, { execution: "sync" }).pipe(Effect.provide(NodeCrypto.layer))
      )

      const overlay = await Effect.runPromise(
        Vfs.makeOverlay(snapshot, { execution: "sync" }).pipe(Effect.provide(NodeCrypto.layer))
      )

      run((run(overlay.caller())).writeFile("/file", text.encode("after"), { access: "write", truncate: true }))
      assert.deepStrictEqual(run((run(restored.caller())).readFile("/file")), text.encode("before"))
      assert.strictEqual((await Effect.runPromise(overlay.capture())).changes.length, 1)

      const fixture = await Effect.runPromise(
        Vfs.fromFixture({ entries: [] }, { execution: "sync" }).pipe(Effect.provide(NodeCrypto.layer))
      )

      run((run(fixture.caller())).mkdir("/fixture"))
    })

    it("should reject sync live stores before loading or committing an image", async () => {
      let touched = false

      const store = LiveVolume.LiveImageStore.of({
        loadOrCreate: () => {
          touched = true

          return Effect.succeed(new Uint8Array())
        },
        commit: () => {
          touched = true

          return Effect.succeed("committed")
        }
      })

      const result = await Effect.runPromise(Effect.result(
        LiveVolume.open({
          volume: { execution: "sync" },
          maxImageBytes: ByteSize.bytes(1024)
        }).pipe(
          Effect.provideService(LiveVolume.LiveImageStore, store),
          Effect.provide(NodeCrypto.layer),
          Effect.scoped
        )
      ))

      assert.isTrue(Result.isFailure(result))

      if (Result.isFailure(result)) assert.strictEqual(result.failure.field, "volume.execution")
      assert.isFalse(touched)
    })

    it("should reject reentrant operations before scope acquisition and never publish them later", async () => {
      let hook: (() => void) | undefined
      const clock = run(Clock.clockWith(Effect.succeed))

      const volume = run(
        makeRuntime({ execution: "sync" }).pipe(Effect.provideService(
          Clock.Clock,
          withNanos(clock, () => {
            hook?.()

            return clock.currentTimeNanosUnsafe()
          })
        ))
      )

      const caller = run(volume.caller())
      const scope = Scope.makeUnsafe()
      const directory = run(caller.openDirectory("/").pipe(Effect.provideService(Scope.Scope, scope)))
      hook = () => {
        const closeFailure = failure(directory.close)
        assert.strictEqual(closeFailure.code, "VolumeBusy")
        assert.strictEqual(closeFailure.operation, "close")
        assert.strictEqual(failure(caller.stat("/")).code, "VolumeBusy")
        assert.strictEqual(
          failure(caller.open("/nested", create).pipe(Effect.provideService(Scope.Scope, scope))).code,
          "VolumeBusy"
        )
        assert.strictEqual(
          failure(caller.openDirectory("/").pipe(Effect.provideService(Scope.Scope, scope))).code,
          "VolumeBusy"
        )
      }

      run(caller.mkdir("/outer"))
      hook = undefined
      assert.strictEqual(run(directory.stat).kind, "directory")
      run(directory.close)
      run(Scope.close(scope, Exit.void))
      await Effect.runPromise(Effect.sleep("1 millis"))
      assert.strictEqual(failure(caller.stat("/nested")).code, "NotFound")
    })

    for (const outcome of ["success", "failure", "defect"] as const) {
      it(`should reclaim reentrantly closed file and directory ownership before outer ${outcome} returns`, () => {
        let hook: (() => void) | undefined
        let invalidTime = false
        const clock = run(Clock.clockWith(Effect.succeed))

        const volume = run(
          makeRuntime({ execution: "sync" }).pipe(Effect.provideService(
            Clock.Clock,
            withNanos(clock, () => {
              hook?.()

              return invalidTime ? 10n ** 129n : clock.currentTimeNanosUnsafe()
            })
          ))
        )

        const caller = run(volume.caller())
        const scope = Scope.makeUnsafe(outcome === "success" ? "parallel" : "sequential")
        run(caller.writeFile("/held", text.encode("held"), create))

        const handle = run(
          caller.open("/held", { access: "readWrite" }).pipe(Effect.provideService(Scope.Scope, scope))
        )

        run(caller.mkdir("/directory"))
        const directory = run(caller.openDirectory("/directory").pipe(Effect.provideService(Scope.Scope, scope)))
        run(caller.unlink("/held"))
        run(caller.rmdir("/directory"))
        hook = () => {
          hook = undefined
          run(Scope.close(scope, Exit.void))

          if (outcome === "failure") invalidTime = true

          if (outcome === "defect") throw new Error("hook failed")
        }

        const outer = Effect.runSyncExit(caller.mkdir("/outer"))
        invalidTime = false
        assert.strictEqual(Exit.isSuccess(outer), outcome === "success")
        assert.strictEqual(run(volume.usage).usedBytes, 0n)
        assert.strictEqual(failure(handle.stat).code, "InvalidHandle")
        assert.strictEqual(failure(directory.stat).code, "InvalidHandle")
      })
    }

    it("should capture persistent state without holding ownership during subsequent Effects", async () => {
      const volume = run(makeRuntime({ execution: "sync" }))
      const caller = run(volume.caller())
      const captured = run(volume.snapshot)
      const pending = Effect.runFork(Effect.andThen(Effect.yieldNow, Effect.succeed(captured)))
      run(caller.mkdir("/later"))
      assert.strictEqual(await Effect.runPromise(Fiber.join(pending)), captured)
      const entries = await Effect.runPromise(Stream.runCollect(Vfs.snapshotEntries(captured, "/")))
      assert.deepStrictEqual(entries.map((entry) => entry.path), ["/"])
      assert.strictEqual(run(caller.stat("/later")).kind, "directory")
    })
    it("should not start an interrupted operation that has not entered the volume", async () => {
      const caller = run(run(makeRuntime({ execution: "sync" })).caller())
      const ready = Deferred.makeUnsafe<void>()
      const waiting = Effect.runFork(Effect.andThen(Deferred.await(ready), caller.mkdir("/cancelled")))
      await Effect.runPromise(Fiber.interrupt(waiting))
      run(Deferred.succeed(ready, undefined))
      assert.strictEqual(failure(caller.stat("/cancelled")).code, "NotFound")
    })

    it("should close a watch reentrantly and run consumer mutations after ownership is released", async () => {
      let hook: (() => void) | undefined
      const clock = run(Clock.clockWith(Effect.succeed))

      const volume = await Effect.runPromise(
        Vfs.make({ execution: "sync" }).pipe(
          Effect.provide(NodeCrypto.layer),
          Effect.provideService(
            Clock.Clock,
            withNanos(clock, () => {
              hook?.()

              return clock.currentTimeNanosUnsafe()
            })
          )
        )
      )

      const caller = run(volume.caller())
      const scope = Scope.makeUnsafe()
      const events = run(volume.watch().pipe(Effect.provideService(Scope.Scope, scope)))
      let delivered = 0

      const reader = Effect.runFork(Stream.runForEach(events, () =>
        Effect.sync(() => {
          delivered++
        })))

      hook = () => {
        hook = undefined
        run(Scope.close(scope, Exit.void))
      }

      run(caller.mkdir("/after-close"))
      const stopped = await Effect.runPromiseExit(Fiber.join(reader))
      assert.isTrue(Exit.isFailure(stopped))
      assert.strictEqual(delivered, 0)
      const otherScope = Scope.makeUnsafe()
      const other = run(volume.watch().pipe(Effect.provideService(Scope.Scope, otherScope)))
      const callback = Effect.runFork(Stream.runForEach(other.pipe(Stream.take(1)), () => caller.mkdir("/callback")))
      run(caller.mkdir("/published"))
      await Effect.runPromise(Fiber.join(callback))
      run(Scope.close(otherScope, Exit.void))
      assert.strictEqual(run(caller.stat("/callback")).kind, "directory")
    })
    it("should keep scheduler yield callbacks outside sync ownership", () => {
      const volume = run(makeRuntime({ execution: "sync" }))
      const caller = run(volume.caller())
      const ordinary = new Scheduler.MixedScheduler("sync")
      let consulted = 0

      const scheduler: Scheduler.Scheduler = {
        executionMode: "sync",
        makeDispatcher: () => ordinary.makeDispatcher(),
        shouldYield(fiber) {
          consulted++
          assert.strictEqual(run(caller.stat("/")).kind, "directory")

          return ordinary.shouldYield(fiber)
        }
      }

      run(caller.mkdir("/scheduled").pipe(Effect.provideService(Scheduler.Scheduler, scheduler)))
      assert.isTrue(consulted > 0)
    })

    it("should pair a captured sync overlay snapshot and summary while a competing write completes", async () => {
      const original = await make({ execution: "sync" })
      const caller = run(original.caller())
      run(caller.writeFile("/file", text.encode("before"), create))

      const overlay = await Effect.runPromise(
        Vfs.makeOverlay(run(original.snapshot), { execution: "sync" }).pipe(Effect.provide(NodeCrypto.layer))
      )

      const writer = run(overlay.caller())
      const pending = Effect.runFork(overlay.capture())
      run(writer.writeFile("/file", text.encode("after"), { access: "write", truncate: true }))
      const captured = await Effect.runPromise(Fiber.join(pending))
      assert.strictEqual(captured.changes.length, 0)

      const restored = await Effect.runPromise(
        Vfs.fromSnapshot(captured.snapshot, { execution: "sync" }).pipe(Effect.provide(NodeCrypto.layer))
      )

      assert.deepStrictEqual(run((run(restored.caller())).readFile("/file")), text.encode("before"))
      assert.strictEqual((await Effect.runPromise(overlay.capture())).changes.length, 1)
    })
    it("should reject a sync live registry before constructing a store layer", async () => {
      let constructed = false

      const result = await Effect.runPromise(Effect.result(
        LiveVolume.makeRegistry({
          volume: { volume: { execution: "sync" }, maxImageBytes: ByteSize.bytes(1024) },
          store: (_key: string) => {
            constructed = true

            return Layer.succeed(
              LiveVolume.LiveImageStore,
              LiveVolume.LiveImageStore.of({
                loadOrCreate: (initial) => Effect.succeed(initial),
                commit: () => Effect.succeed("committed")
              })
            )
          }
        }).pipe(Effect.provide(NodeCrypto.layer), Effect.scoped)
      ))

      assert.isTrue(Result.isFailure(result))

      if (Result.isFailure(result)) assert.strictEqual(result.failure.field, "volume.volume.execution")
      assert.isFalse(constructed)
    })
  })
})

describe("construction call styles", () => {
  const fixture: Vfs.Fixture = { entries: [{ kind: "file", path: "/file", bytes: Uint8Array.of(7) }] }

  const options: Vfs.VolumeOptions = { maxBytes: ByteSize.kibibytes(4) }

  describe("dual construction and snapshot deltas", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect("should restore fixture contents when constructors receive optional configuration in either call style", () =>
        Effect.gen(function*() {
          const snapshot = yield* (yield* Vfs.fromFixture(fixture)).snapshot

          const builds = [
            Vfs.fromFixture(fixture),
            Vfs.fromFixture(fixture, undefined),
            Vfs.fromFixture(fixture, options),
            Vfs.fromFixture()(fixture),
            Vfs.fromFixture(undefined)(fixture),
            Vfs.fromFixture(options)(fixture),
            Vfs.fromSnapshot(snapshot),
            Vfs.fromSnapshot(snapshot, undefined),
            Vfs.fromSnapshot(snapshot, options),
            Vfs.fromSnapshot()(snapshot),
            Vfs.fromSnapshot(undefined)(snapshot),
            Vfs.fromSnapshot(options)(snapshot),
            Vfs.makeOverlay(snapshot),
            Vfs.makeOverlay(snapshot, undefined),
            Vfs.makeOverlay(snapshot, options),
            Vfs.makeOverlay()(snapshot),
            Vfs.makeOverlay(undefined)(snapshot),
            Vfs.makeOverlay(options)(snapshot)
          ]

          for (const build of builds) {
            const caller = yield* (yield* build).caller()
            assert.deepStrictEqual(yield* caller.readFile("/file"), Uint8Array.of(7))
          }

          const tooSmall = { maxBytes: ByteSize.bytes(0) }
          assert.deepStrictEqual(
            yield* Effect.flip(Vfs.fromFixture(tooSmall)(fixture)),
            yield* Effect.flip(Vfs.fromFixture(fixture, tooSmall))
          )
          assert.deepStrictEqual(
            yield* Effect.flip(Vfs.fromSnapshot(tooSmall)(snapshot)),
            yield* Effect.flip(Vfs.fromSnapshot(snapshot, tooSmall))
          )
        }))

      it.effect("should provide fixture contents when volume layers receive configuration in either call style", () =>
        Effect.gen(function*() {
          const snapshot = yield* (yield* Vfs.fromFixture(fixture)).snapshot

          const layers = [
            [Vfs.Volume.layerFromFixture(fixture), undefined],
            [Vfs.Volume.layerFromFixture(fixture, undefined), undefined],
            [Vfs.Volume.layerFromFixture(fixture, options), options.maxBytes],
            [Vfs.Volume.layerFromFixture()(fixture), undefined],
            [Vfs.Volume.layerFromFixture(undefined)(fixture), undefined],
            [Vfs.Volume.layerFromFixture(options)(fixture), options.maxBytes],
            [Vfs.Volume.layerFromSnapshot(snapshot), undefined],
            [Vfs.Volume.layerFromSnapshot(snapshot, undefined), undefined],
            [Vfs.Volume.layerFromSnapshot(snapshot, options), options.maxBytes],
            [Vfs.Volume.layerFromSnapshot()(snapshot), undefined],
            [Vfs.Volume.layerFromSnapshot(undefined)(snapshot), undefined],
            [Vfs.Volume.layerFromSnapshot(options)(snapshot), options.maxBytes],
            [Vfs.Volume.layerOverlay(snapshot), undefined],
            [Vfs.Volume.layerOverlay(snapshot, undefined), undefined],
            [Vfs.Volume.layerOverlay(snapshot, options), options.maxBytes],
            [Vfs.Volume.layerOverlay()(snapshot), undefined],
            [Vfs.Volume.layerOverlay(undefined)(snapshot), undefined],
            [Vfs.Volume.layerOverlay(options)(snapshot), options.maxBytes]
          ] as const

          for (const [layer, maxBytes] of layers) {
            yield* Effect.gen(function*() {
              const volume = yield* Vfs.Volume
              const caller = yield* volume.caller()
              assert.deepStrictEqual(yield* caller.readFile("/file"), Uint8Array.of(7))

              if (maxBytes !== undefined) assert.deepStrictEqual(volume.limits.maxBytes, maxBytes)
            }).pipe(Effect.provide(layer))
          }
        }))

      it.effect("should reproduce the target snapshot when diff and apply use either call style", () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.fromFixture(fixture)
          const base = yield* volume.snapshot
          yield* (yield* volume.caller()).writeFile("/next", Uint8Array.of(8), { access: "write", create: "exclusive" })
          const target = yield* volume.snapshot
          const expected = yield* Vfs.encodeSnapshot(target)
          const limits = Vfs.SnapshotDeltaLimits.default

          const diffs = [
            Vfs.diffSnapshots(base, target),
            Vfs.diffSnapshots(base, target, undefined),
            Vfs.diffSnapshots(base, target, limits),
            Vfs.diffSnapshots(target)(base),
            Vfs.diffSnapshots(target, undefined)(base),
            Vfs.diffSnapshots(target, limits)(base)
          ]

          for (const diff of diffs) {
            const delta = yield* diff
            const applied = yield* pipe(base, Vfs.applySnapshotDelta(delta))
            assert.deepStrictEqual(yield* Vfs.encodeSnapshot(applied), expected)
          }

          const delta = yield* Vfs.diffSnapshots(base, target)

          const applies = [
            Vfs.applySnapshotDelta(base, delta),
            Vfs.applySnapshotDelta(base, delta, undefined),
            Vfs.applySnapshotDelta(base, delta, limits),
            Vfs.applySnapshotDelta(delta)(base),
            Vfs.applySnapshotDelta(delta, undefined)(base),
            Vfs.applySnapshotDelta(delta, limits)(base)
          ]

          for (const apply of applies) {
            assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* apply), expected)
          }

          const expectedChanges = yield* Vfs.inspectSnapshotDelta(base, delta, { includeTimestamps: true }, limits)
          assert.isTrue(expectedChanges.some(Predicate.isTagged("Added")))
          const inspect = Vfs.inspectSnapshotDelta(delta, { includeTimestamps: true }, limits)
          assert.deepStrictEqual(yield* inspect(base), expectedChanges)
          assert.deepStrictEqual(
            yield* Vfs.inspectSnapshotDelta(delta)(base),
            yield* Vfs.inspectSnapshotDelta(base, delta)
          )
          assert.deepStrictEqual(
            yield* Vfs.inspectSnapshotDelta(delta, undefined)(base),
            yield* Vfs.inspectSnapshotDelta(base, delta, undefined)
          )
          assert.deepStrictEqual(
            yield* Vfs.inspectSnapshotDelta(delta, undefined, undefined)(base),
            yield* Vfs.inspectSnapshotDelta(base, delta, undefined, undefined)
          )
          assert.deepStrictEqual(
            yield* Vfs.inspectSnapshotDelta(delta, undefined, limits)(base),
            yield* Vfs.inspectSnapshotDelta(base, delta, undefined, limits)
          )
          const mismatched = yield* Effect.flip(Vfs.applySnapshotDelta(delta)(target))
          assert.deepStrictEqual(mismatched, yield* Effect.flip(Vfs.applySnapshotDelta(target, delta)))
        }))

      it.effect("should merge changes onto the same base when merge options are omitted or supplied in either call style", () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.fromFixture(fixture)
          const base = yield* volume.snapshot
          yield* (yield* volume.caller()).writeFile("/next", Uint8Array.of(8), { access: "write", create: "exclusive" })
          const target = yield* volume.snapshot
          const ours = yield* Vfs.diffSnapshots(base, target)
          const theirs = yield* Vfs.diffSnapshots(base, base)
          const options = { limits: Vfs.SnapshotDeltaLimits.default }

          const merges = [
            Vfs.mergeSnapshotDeltas(base, ours, theirs),
            Vfs.mergeSnapshotDeltas(base, ours, theirs, undefined),
            Vfs.mergeSnapshotDeltas(base, ours, theirs, options),
            Vfs.mergeSnapshotDeltas(ours, theirs)(base),
            Vfs.mergeSnapshotDeltas(ours, theirs, undefined)(base),
            Vfs.mergeSnapshotDeltas(ours, theirs, options)(base)
          ]

          const expected = yield* Vfs.encodeSnapshot(target)

          for (const merge of merges) {
            const result = yield* merge
            assert.deepStrictEqual(result.conflicts, [])
            assert.deepStrictEqual(
              yield* Vfs.encodeSnapshot(yield* Vfs.applySnapshotDelta(base, result.delta)),
              expected
            )
          }
        }))
    })

    it("should preserve addressing and durability comparisons when helpers are partially applied", () => {
      const name = Uint8Array.of(255)
      assert.deepStrictEqual(Target.Entry(name)("/work"), Target.Entry("/work", name))
      assert.deepStrictEqual(Vfs.Entry("file")("/work"), Target.Entry("/work", "file"))
      assert.strictEqual(Vfs.isVolumeDurabilityAtLeast, Volume.isVolumeDurabilityAtLeast)
      const meetsRequirement = Volume.isVolumeDurabilityAtLeast("survives-process-crash")
      assert.isTrue(meetsRequirement("survives-operating-system-crash"))
      assert.isFalse(meetsRequirement("memory-only"))
      assert.strictEqual(
        meetsRequirement("survives-process-crash"),
        Volume.isVolumeDurabilityAtLeast("survives-process-crash", "survives-process-crash")
      )
    })
  })
})
