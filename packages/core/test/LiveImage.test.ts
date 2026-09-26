import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import * as LiveImage from "../src/internal/liveImage.js"
import { openImageVolume, prepareEmptyLiveImage } from "../src/internal/virtualFileSystem.js"

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
  // Reopening reclaims unlinked files a handle held, so only an image without any re-encodes unchanged.
  it.effect("re-encodes a decoded image without held unlinked files to the same bytes", () =>
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
        yield* LiveImage.encode(restored.value, restored.identity, session.volume.limits),
        image
      )
      yield* session.shutdown
    })))

  it.effect("rejects oversized and malformed input before exposing an image", () =>
    Effect.gen(function*() {
      const image = yield* prepareEmptyLiveImage()
      assert.strictEqual(
        (yield* Effect.flip(LiveImage.decode(image, ByteSize.bytes(image.length - 1)))).code,
        "LimitExceeded"
      )
      assert.deepStrictEqual(
        yield* failure(new TextEncoder().encode("{\"format\":\"effect-vfs-live\",\"version\":2}\n")),
        ["InvalidStructure", "liveImage"]
      )
      assert.deepStrictEqual(yield* failure(new Uint8Array([0xff])), ["InvalidEncoding", "liveImage"])
    }))

  it.effect("rejects an inode allocator past the largest safe integer", () =>
    Effect.gen(function*() {
      const image = yield* prepareEmptyLiveImage()
      const atLimit = edited(image, "\"nextInode\":2,", `"nextInode":${Number.MAX_SAFE_INTEGER},`)
      const pastLimit = edited(image, "\"nextInode\":2,", `"nextInode":${Number.MAX_SAFE_INTEGER + 1},`)

      assert.strictEqual((yield* LiveImage.decode(atLimit, BOUND)).value.nextInode, Number.MAX_SAFE_INTEGER)
      assert.deepStrictEqual(yield* failure(pastLimit), ["InvalidStructure", "liveImage"])
    }))

  it.effect("rejects runtime state the nodes contradict, naming where", () =>
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
    }))

  it.effect("keeps a file no name reaches for reopening to reclaim, but refuses such a symbolic link", () =>
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
    })))

  it.effect("rejects a stored path longer than the volume's path limit", () =>
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
