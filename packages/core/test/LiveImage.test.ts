import { assert, describe } from "@effect/vitest"
import { ByteSize, Effect } from "effect"
import { CanonicalBase64 } from "../src/internal/canonicalBase64.js"
import * as LiveImage from "../src/internal/liveImage.js"
import { it } from "./TestEffect.js"

const empty = (): LiveImage.Document => ({
  format: "effect-vfs-live",
  version: 1,
  identity: "0123456789abcdef0123456789abcdef",
  root: 1n,
  nextInode: 2n,
  revisionCounter: 1n,
  entries: 0,
  usedBytes: 0n,
  limits: {},
  retainedFiles: [],
  records: [{
    _tag: "directory",
    ino: 1n,
    revision: 1n,
    metadata: {
      nlink: 2,
      size: 0n,
      uid: 0,
      gid: 0,
      mode: 0o755,
      atimeNs: 0n,
      mtimeNs: 0n,
      ctimeNs: 0n,
      birthtimeNs: 0n
    },
    entries: []
  }]
})

describe("private live image", () => {
  it.effect("round trips the versioned image and bigint fields", () =>
    Effect.gen(function*() {
      const image = empty()
      const bytes = yield* LiveImage.encode(image)
      const restored = yield* LiveImage.decode(bytes, ByteSize.bytes(bytes.length))

      assert.deepEqual(restored, image)
    }))

  it.effect("rejects oversized and malformed input before exposing an image", () =>
    Effect.gen(function*() {
      const bytes = yield* LiveImage.encode(empty())
      assert.strictEqual(
        (yield* Effect.flip(LiveImage.decode(bytes, ByteSize.bytes(bytes.length - 1)))).code,
        "LimitExceeded"
      )
      const malformed = new TextEncoder().encode("{\"format\":\"effect-vfs-live\",\"version\":2}")
      assert.strictEqual(
        (yield* Effect.flip(LiveImage.decode(malformed, ByteSize.bytes(1024)))).code,
        "InvalidStructure"
      )
    }))

  it.effect("preserves opaque byte names in directory entries", () =>
    Effect.gen(function*() {
      const image = empty()
      const root = image.records[0]

      if (root?._tag !== "directory") return yield* Effect.die("missing root")

      const document: LiveImage.Document = {
        ...image,
        nextInode: 3n,
        entries: 1,
        usedBytes: 1n,
        records: [
          { ...root, entries: [{ name: CanonicalBase64.encode(new Uint8Array([0xff])), target: 2n }] },
          {
            _tag: "file",
            ino: 2n,
            revision: 1n,
            metadata: { ...root.metadata, nlink: 1, size: 1n },
            data: CanonicalBase64.encode(new Uint8Array([7]))
          }
        ]
      }

      const bytes = yield* LiveImage.encode(document)
      const restored = yield* LiveImage.decode(bytes, ByteSize.bytes(bytes.length))
      assert.deepEqual(restored.records, document.records)
    }))

  it.effect("rejects inconsistent stored counters and references", () =>
    Effect.gen(function*() {
      const valid = yield* LiveImage.encode(empty())
      const text = new TextDecoder().decode(valid)
      const brokenCount = text.replace("\"entries\":0", "\"entries\":1")
      const brokenRoot = text.replace("\"root\":\"1\"", "\"root\":\"2\"")

      assert.strictEqual(
        (yield* Effect.flip(LiveImage.decode(new TextEncoder().encode(brokenCount), ByteSize.bytes(4096)))).code,
        "InvalidStructure"
      )
      assert.strictEqual(
        (yield* Effect.flip(LiveImage.decode(new TextEncoder().encode(brokenRoot), ByteSize.bytes(4096)))).code,
        "InvalidStructure"
      )
    }))

  it.effect("keeps a zero-link file only when the image marks it retained", () =>
    Effect.gen(function*() {
      const image = empty()
      const root = image.records[0]

      if (root?._tag !== "directory") return yield* Effect.die("missing root")

      const document: LiveImage.Document = {
        ...image,
        nextInode: 3n,
        usedBytes: 1n,
        retainedFiles: [2n],
        records: [root, {
          _tag: "file",
          ino: 2n,
          revision: 1n,
          metadata: { ...root.metadata, nlink: 0, size: 1n },
          data: CanonicalBase64.encode(new Uint8Array([7]))
        }]
      }

      const encoded = yield* LiveImage.encode(document)
      assert.deepEqual((yield* LiveImage.decode(encoded, ByteSize.bytes(encoded.length))).retainedFiles, [2n])
      assert.strictEqual(
        (yield* Effect.flip(LiveImage.encode({ ...document, retainedFiles: [] }))).code,
        "InvalidStructure"
      )
    }))
})
