import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Clock, Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LiveVolume, VirtualFileSystem as Vfs } from "../../src/index.js"
import * as LiveImage from "../../src/internal/liveImage.js"
import { openImageVolume, prepareEmptyLiveImage } from "../../src/internal/virtualFileSystem.js"

const BOUND = ByteSize.kilobytes(64)

const LIMITS = { maxEntries: 50, maxBytes: ByteSize.kilobytes(8), maxPathBytes: ByteSize.bytes(64) }

// Every image a volume opened from `initial` commits, newest last.
const committing = Effect.fnUntraced(function*(initial: Uint8Array) {
  const images = [initial]

  const session = yield* openImageVolume(initial, BOUND, (bytes) =>
    Effect.sync(() => {
      images.push(new Uint8Array(bytes))

      return "committed" as const
    }))

  return { session, images }
})

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

const edited = (image: Uint8Array, from: string, to: string) => {
  const source = text(image)
  assert.include(source, from)

  return new TextEncoder().encode(source.replace(from, to))
}

const failure = (image: Uint8Array) =>
  Effect.map(Effect.flip(LiveImage.decode(image, BOUND)), (error) => [error.code, error.field] as const)

describe("private live image", () => {
  // Captured from the version 1 encoder before the direct empty-state refactor.
  const legacy = new TextEncoder().encode(
    "{\"format\":\"effect-vfs-live\",\"version\":1,\"runtime\":{\"identity\":\"0123456789abcdef0123456789abcdef\",\"epoch\":\"de369d4cca173d6066a0185f7e1284fe\",\"keySecret\":\"f8b0cbdf68fb9c18a79531b05811090b\",\"nextInode\":2,\"revision\":\"1\",\"limits\":{\"maxFileBytes\":\"4294967295\"},\"usage\":{\"entries\":0,\"usedBytes\":\"0\"}}}\n" +
      "{\"_tag\":\"directory\",\"ino\":1,\"parent\":1,\"name\":\"\",\"metadata\":{\"uid\":0,\"gid\":0,\"mode\":493,\"atimeNs\":\"1790851950589000000\",\"mtimeNs\":\"1790851950589000000\",\"ctimeNs\":\"1790851950589000000\",\"birthtimeNs\":\"1790851950589000000\"},\"rev\":\"1\"}\n"
  )

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should reopen an existing version 1 document with its naming and root metadata intact", () =>
      Effect.gen(function*() {
        const restored = yield* LiveImage.decode(legacy, BOUND)
        const session = yield* LiveVolume.openImage(legacy, BOUND, () => Effect.succeed("committed"))
        assert.strictEqual(session.volume.identity, "0123456789abcdef0123456789abcdef")
        const root = yield* (yield* session.volume.caller()).stat("/")
        assert.deepEqual([root.uid, root.gid, root.mode, root.birthtimeNs], [0, 0, 0o755, 1790851950589000000n])
        assert.deepEqual(yield* LiveImage.encode(restored.value, restored, session.volume.limits), legacy)
        yield* session.shutdown
      }))

    it.effect("should reject version 1 capacity values that exceed the supported file size", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(LiveVolume.openImage(
          edited(legacy, "\"maxFileBytes\":\"4294967295\"", "\"maxFileBytes\":\"4294967296\""),
          BOUND,
          () => Effect.succeed("committed")
        ))

        assert.deepEqual([error.code, error.field], ["InvalidArgument", "maxFileBytes"])
      }))

    it.effect("should attribute an unsupported clock sample to empty-image preparation", () =>
      Effect.gen(function*() {
        const original = yield* Clock.clockWith(Effect.succeed)
        const now = () => 10n ** 128n

        const clock: Clock.Clock = {
          currentTimeMillisUnsafe: () => original.currentTimeMillisUnsafe(),
          currentTimeMillis: original.currentTimeMillis,
          currentTimeNanosUnsafe: now,
          currentTimeNanos: Effect.sync(now),
          monotonicTimeNanosUnsafe: () => original.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: original.monotonicTimeNanos,
          sleep: (duration) => original.sleep(duration)
        }

        const error = yield* Effect.flip(
          LiveVolume.prepareEmptyImage().pipe(Effect.provideService(Clock.Clock, clock))
        )

        assert.deepEqual([error.code, error.operation, error.field], [
          "InvalidArgument",
          "LiveVolume.prepareEmptyImage",
          "clock.currentTimeNanos"
        ])
      }))

    it.effect("should prepare an empty root at the current time and attribute invalid options to preparation", () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(1234)

        const image = yield* LiveVolume.prepareEmptyImage({
          identity: Vfs.VolumeIdentity.make("0123456789abcdef0123456789abcdef"),
          ...LIMITS
        })

        const restored = yield* LiveImage.decode(image, BOUND)
        const session = yield* LiveVolume.openImage(image, BOUND, () => Effect.succeed("committed"))
        const root = yield* (yield* session.volume.caller()).stat("/")
        assert.strictEqual(session.volume.identity, "0123456789abcdef0123456789abcdef")
        assert.deepEqual([root.uid, root.gid, root.mode, root.atimeNs, root.mtimeNs, root.ctimeNs, root.birthtimeNs], [
          0,
          0,
          0o755,
          1_234_000_000n,
          1_234_000_000n,
          1_234_000_000n,
          1_234_000_000n
        ])
        assert.deepEqual(yield* session.volume.usage, { entries: 0, usedBytes: 0n })
        assert.match(restored.epoch, /^[0-9a-f]{32}$/)
        assert.match(restored.keySecret, /^[0-9a-f]{32}$/)
        assert.notStrictEqual<string>(restored.epoch, restored.keySecret)
        const error = yield* Effect.flip(LiveVolume.prepareEmptyImage({ maxPendingOperations: 0 }))
        assert.deepEqual([error.code, error.operation, error.field], [
          "InvalidArgument",
          "LiveVolume.prepareEmptyImage",
          "maxPendingOperations"
        ])
        yield* session.shutdown
      }))
  })

  // Reopening reclaims unlinked files a handle held, so only an image without any re-encodes unchanged.
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should re-encode identical bytes when a decoded image has no held unlinked files",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const { session, images } = yield* committing(yield* prepareEmptyLiveImage(LIMITS))
          const caller = yield* session.volume.caller()
          const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, 0xff]))
          yield* caller.mkdir("/d")
          yield* caller.writeFile("/d/f", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
          yield* caller.link("/d/f", raw)
          yield* caller.symlink("d/f", "/s")
          yield* caller.rename("/d/f", "/d/g")
          yield* caller.chmod("/d", 0o700)

          const image = images.at(-1)!
          const restored = yield* LiveImage.decode(image, BOUND)

          assert.deepStrictEqual(
            yield* LiveImage.encode(restored.value, restored, session.volume.limits),
            image
          )
          yield* session.shutdown
        }))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should reject an image when its encoded bytes exceed the bound", () =>
      Effect.gen(function*() {
        const image = yield* prepareEmptyLiveImage()
        assert.strictEqual(
          (yield* Effect.flip(LiveImage.decode(image, ByteSize.bytes(image.length - 1)))).code,
          "LimitExceeded"
        )
      }))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should report InvalidStructure when a live image document is incomplete",
      () =>
        Effect.gen(function*() {
          assert.deepStrictEqual(
            yield* failure(new TextEncoder().encode("{\"format\":\"effect-vfs-live\",\"version\":2}\n")),
            ["InvalidStructure", "liveImage"]
          )
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should report InvalidEncoding when live image bytes are not UTF-8", () =>
      Effect.gen(function*() {
        assert.deepStrictEqual(yield* failure(new Uint8Array([0xff])), ["InvalidEncoding", "liveImage"])
      }))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should reject an image when its inode allocator exceeds the largest safe integer",
      () =>
        Effect.gen(function*() {
          const image = yield* prepareEmptyLiveImage()
          const atLimit = edited(image, "\"nextInode\":2,", `"nextInode":${Number.MAX_SAFE_INTEGER},`)
          const pastLimit = edited(image, "\"nextInode\":2,", `"nextInode":${Number.MAX_SAFE_INTEGER + 1},`)

          assert.strictEqual((yield* LiveImage.decode(atLimit, BOUND)).value.nextInode, Number.MAX_SAFE_INTEGER)
          assert.deepStrictEqual(yield* failure(pastLimit), ["InvalidStructure", "liveImage"])
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should name the invalid field when runtime state contradicts image nodes",
      () =>
        Effect.gen(function*() {
          const image = yield* prepareEmptyLiveImage(LIMITS)

          for (
            const [from, to, field] of [
              ["\"entries\":0", "\"entries\":1", "runtime.usage.entries"],
              ["\"usedBytes\":\"0\"", "\"usedBytes\":\"1\"", "runtime.usage.usedBytes"],
              ["\"revision\":\"1\"", "\"revision\":\"0\"", "runtime.revision"],
              ["\"rev\":\"1\"", "\"rev\":\"2\"", "nodes.0.rev"],
              ["\"nextInode\":2,", "\"nextInode\":1,", "liveImage"],
              ["\"parent\":1,", "\"parent\":2,", "nodes.0"]
            ] as const
          ) assert.deepStrictEqual(yield* failure(edited(image, from, to)), ["InvalidStructure", field], field)
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should preserve runtime secrets when an image commits", () =>
      Effect.gen(function*() {
        const { session, images } = yield* committing(yield* prepareEmptyLiveImage(LIMITS))
        yield* (yield* session.volume.caller()).mkdir("/d")
        const [initial, committed] = [images[0]!, images.at(-1)!]
        const { epoch, keySecret } = yield* LiveImage.decode(initial, BOUND)
        const resumed = yield* LiveImage.decode(committed, BOUND)

        assert.match(epoch, /^[0-9a-f]{32}$/)
        assert.match(keySecret, /^[0-9a-f]{32}$/)
        assert.notStrictEqual<string>(keySecret, epoch)
        assert.deepStrictEqual([resumed.epoch, resumed.keySecret], [epoch, keySecret])

        yield* session.shutdown
      }))
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should reject malformed runtime secrets when decoding a committed image",
      () =>
        Effect.gen(function*() {
          const { session, images } = yield* committing(yield* prepareEmptyLiveImage(LIMITS))
          yield* (yield* session.volume.caller()).mkdir("/d")
          const committed = images.at(-1)!
          const { epoch, keySecret } = yield* LiveImage.decode(images[0]!, BOUND)

          for (const [field, value] of [["epoch", epoch], ["keySecret", keySecret]] as const) {
            assert.deepStrictEqual(
              yield* failure(edited(committed, `"${field}":"${value}"`, `"${field}":"${value.toUpperCase()}"`)),
              ["InvalidStructure", "liveImage"],
              field
            )
          }

          yield* session.shutdown
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should reclaim unlinked files but reject unlinked symlinks when reopening an image",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const { session, images } = yield* committing(yield* prepareEmptyLiveImage(LIMITS))
          const caller = yield* session.volume.caller()
          yield* caller.symlink("target", "/s")
          const held = yield* caller.open("/f", { access: "write", create: "exclusive" })
          yield* held.write(new Uint8Array([7]))
          yield* caller.unlink("/f")
          const image = images.at(-1)!

          const reopened = yield* LiveImage.decode(image, BOUND)
          assert.strictEqual(reopened.value.usedBytes, 6n)
          assert.include(text(image), "\"usedBytes\":\"7\"")

          const [code, field] = yield* failure(
            edited(image, "\"links\":[{\"parent\":1,\"name\":\"cw==\"}]", "\"links\":[]")
          )

          assert.strictEqual(code, "InvalidStructure")
          assert.match(field ?? "", /^nodes\.\d+\.links$/)
          yield* held.close
          yield* session.shutdown
        }))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect("should reject a stored path when it exceeds the volume path limit", () =>
      Effect.gen(function*() {
        const { session, images } = yield* committing(yield* prepareEmptyLiveImage(LIMITS))
        const caller = yield* session.volume.caller()
        yield* caller.mkdir("/abc")
        yield* caller.writeFile("/abc/de", new Uint8Array(), { access: "write", create: "exclusive" })
        const image = images.at(-1)!

        // "/abc/de" is seven bytes; the tightest limit that holds it is seven.
        yield* LiveImage.decode(edited(image, "\"maxPathBytes\":\"64\"", "\"maxPathBytes\":\"7\""), BOUND)
        const [code, field] = yield* failure(edited(image, "\"maxPathBytes\":\"64\"", "\"maxPathBytes\":\"6\""))
        assert.strictEqual(code, "InvalidStructure")
        assert.match(field ?? "", /^nodes\.\d+\.links\.0\.name$/)
        yield* session.shutdown
      }))
  })
})
