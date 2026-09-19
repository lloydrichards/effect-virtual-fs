import { assert, describe, it as syncIt } from "@effect/vitest"
import { ByteSize, Effect, Fiber, Predicate, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { BytePathId } from "../src/BytePath.js"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const limits = {
  maxEncodedBytes: ByteSize.megabytes(1),
  maxRecords: 100,
  maxEntries: 100,
  maxDecodedBytes: ByteSize.kilobytes(100)
}

const encode = (value: typeof Schema.Unknown.Type) => new TextEncoder().encode(JSON.stringify(value))

const MutableMetadata = Schema.Struct({
  uid: Schema.mutableKey(Schema.Finite),
  gid: Schema.Finite,
  mode: Schema.Finite,
  atimeNs: Schema.String,
  mtimeNs: Schema.mutableKey(Schema.String),
  ctimeNs: Schema.String,
  birthtimeNs: Schema.String,
  extra: Schema.mutableKey(Schema.optionalKey(Schema.Finite))
})

const SnapshotJson = Schema.fromJsonString(Schema.Struct({
  format: Schema.String,
  version: Schema.mutableKey(Schema.Finite),
  root: Schema.String,
  records: Schema.mutable(Schema.Tuple([
    Schema.TaggedStruct("directory", {
      id: Schema.String,
      metadata: Schema.mutableKey(MutableMetadata),
      entries: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.Struct({
        name: Schema.String,
        target: Schema.mutableKey(Schema.String)
      }))))
    }),
    Schema.TaggedStruct("file", {
      id: Schema.mutableKey(Schema.String),
      metadata: Schema.mutableKey(MutableMetadata),
      data: Schema.mutableKey(Schema.String)
    })
  ])),
  extra: Schema.mutableKey(Schema.optionalKey(Schema.Boolean))
}))

import { it } from "./TestEffect.js"

describe("fixtures and snapshots", () => {
  syncIt("rejects objects that forge the public BytePath symbol", () => {
    const forged = Object.freeze({ [BytePathId]: BytePathId })

    const decoded = Schema.decodeUnknownResult(Vfs.Fixture)({
      entries: [{ kind: "directory", path: forged }]
    })

    assert.isTrue(Predicate.isTagged("Failure")(decoded))
  })

  it.effect(
    "should preserve canonical payloads and bytes when files span encoding chunks",
    () =>
      Effect.gen(function*() {
        for (const [tail, suffix] of ["", "AA==", "AP8="].entries()) {
          const input = Uint8Array.from(
            { length: 24_576 + tail },
            (_, index) => index % 3 === 0 ? 0 : index % 3 === 1 ? 255 : 127
          )

          const volume = yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: input }] })
          const encoded = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
          const document = yield* Schema.decodeEffect(SnapshotJson)(new TextDecoder().decode(encoded))
          assert.strictEqual(
            document.records[1].data,
            "AP9/".repeat(8_192) + suffix
          )
          const restored = yield* Vfs.fromSnapshot(yield* Vfs.decodeSnapshot(encoded, limits))
          assert.deepStrictEqual(yield* (yield* restored.caller()).readFile("/f"), input)
        }
      })
  )

  it.effect(
    "loads order-independent fixtures with forward hard links and fixed metadata",
    () =>
      Effect.gen(function*() {
        const input = new Uint8Array([1, 2])

        const volume = yield* Vfs.fromFixture({
          entries: [
            { kind: "hardLink", path: "/alias", target: "/dir/file" },
            { kind: "file", path: "/dir/file", bytes: input, metadata: { mode: 0o640, uid: 7 } },
            { kind: "directory", path: "/dir" },
            { kind: "symlink", path: "/dangling", target: "absent" }
          ]
        })

        input[0] = 9
        const fs = yield* volume.caller()
        const f = yield* fs.open("/alias", { access: "read" })
        assert.deepStrictEqual(yield* f.read(2), new Uint8Array([1, 2]))
        const stat = yield* fs.stat("/dir/file")
        assert.strictEqual(stat.ino, (yield* f.stat).ino)
        assert.deepStrictEqual([stat.nlink, stat.uid, stat.mode, stat.mtimeNs], [2, 7, 0o640, 0n])
        assert.strictEqual(yield* fs.readLink("/dangling"), "absent")
      })
  )

  it.effect(
    "isolates capture, encoded bytes and independent restores from subsequent overwrites",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({
          entries: [{ kind: "file", path: "/f", bytes: new Uint8Array([1, 2]) }]
        })

        const fs = yield* volume.caller()
        const snapshot = yield* volume.snapshot
        const f = yield* fs.open("/f", { access: "write" })
        yield* f.pwrite(new Uint8Array([9]), 0n)
        const bytes = yield* Vfs.encodeSnapshot(snapshot)
        const decoded = yield* Vfs.decodeSnapshot(bytes, limits)
        bytes.fill(0)
        const a = yield* (yield* Vfs.fromSnapshot(decoded)).caller()
        const b = yield* (yield* Vfs.fromSnapshot(decoded)).caller()
        const af = yield* a.open("/f", { access: "readWrite" })
        const bf = yield* b.open("/f", { access: "read" })
        yield* af.write(new Uint8Array([8]))
        assert.deepStrictEqual(yield* bf.read(2), new Uint8Array([1, 2]))
        const byteLimit = yield* Effect.flip(Vfs.fromSnapshot(snapshot, { maxBytes: ByteSize.bytes(1) }))
        assert.instanceOf(byteLimit, Vfs.ImageError)
        assert.strictEqual(byteLimit.code, "LimitExceeded")
        const entryLimit = yield* Effect.flip(Vfs.fromSnapshot(snapshot, { maxEntries: 0 }))
        assert.instanceOf(entryLimit, Vfs.ImageError)
        assert.strictEqual(entryLimit.code, "LimitExceeded")
      })
  )

  it.effect(
    "preserves byte names and symlink aliases but excludes unlinked-open contents",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const fs = yield* volume.caller()
        const path = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))
        yield* fs.symlink("", path)
        yield* fs.link(path, "/alias")
        const f = yield* fs.open("/removed", { access: "write", create: "exclusive" })
        yield* f.write(new Uint8Array([1, 2, 3]))
        yield* fs.unlink("/removed")
        const restored = yield* (yield* Vfs.fromSnapshot(yield* volume.snapshot, { maxBytes: ByteSize.zero })).caller()
        assert.strictEqual((yield* restored.lstat(path)).ino, (yield* restored.lstat("/alias")).ino)
        assert.strictEqual((yield* Effect.flip(restored.stat("/removed"))).code, "NotFound")
        assert.strictEqual(yield* restored.readLink(path), "")
      })
  )

  it.effect("rejects malformed graphs, unknown fields and noncanonical encodings", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: new Uint8Array([102]) }] })

      const original = yield* Schema.decodeEffect(SnapshotJson)(
        new TextDecoder().decode(yield* Vfs.encodeSnapshot(yield* volume.snapshot))
      )

      assert.deepStrictEqual(original.records.map((record) => record._tag), ["directory", "file"])
      assert.isFalse(original.records.some((record) => Object.hasOwn(record, "kind")))

      for (
        const mutate of [
          (image: typeof original) => {
            image.records[0].metadata.extra = 1
          },
          (image: typeof original) => {
            image.records[0].metadata.uid = -1
          }
        ]
      ) {
        const image = structuredClone(original)
        mutate(image)
        const error = yield* Effect.flip(Vfs.decodeSnapshot(encode(image), limits))
        assert.strictEqual(error.code, "InvalidStructure")
        assert.strictEqual(error.field, "document")
      }

      const mutations: Array<(image: typeof original) => void> = [
        (image) => {
          image.extra = true
        },
        (image) => {
          image.records[1].data = "Zh=="
        },
        (image) => {
          image.records[1].id = image.records[0].id
        },
        (image) => {
          image.records[0].entries[0]!.target = "missing"
        },
        (image) => {
          image.records[0].entries.push(image.records[0].entries[0]!)
        },
        (image) => {
          image.records[0].entries[0]!.target = image.root
        },
        (image) => {
          image.records[0].entries = []
        }
      ]

      for (const mutate of mutations) {
        const image = structuredClone(original)
        mutate(image)
        yield* Effect.flip(Vfs.decodeSnapshot(encode(image), limits))
      }

      const alternateTimestamp = structuredClone(original)
      alternateTimestamp.records[1].metadata.mtimeNs = "01"

      const normalized = yield* Vfs.decodeSnapshot(encode(alternateTimestamp), limits)

      const normalizedImage = yield* Schema.decodeEffect(SnapshotJson)(
        new TextDecoder().decode(yield* Vfs.encodeSnapshot(normalized))
      )

      assert.strictEqual(normalizedImage.records[1].metadata.mtimeNs, "1")

      const longestAcceptedTimestamp = structuredClone(original)
      longestAcceptedTimestamp.records[1].metadata.mtimeNs = "0".repeat(128)
      yield* Vfs.decodeSnapshot(encode(longestAcceptedTimestamp), limits)

      for (const timestamp of ["0".repeat(129), "9".repeat(129)]) {
        const oversizedTimestamp = structuredClone(original)
        oversizedTimestamp.records[1].metadata.mtimeNs = timestamp
        const error = yield* Effect.flip(Vfs.decodeSnapshot(encode(oversizedTimestamp), limits))
        assert.strictEqual(error.code, "InvalidEncoding")
        assert.strictEqual(error.field, "document")
      }

      original.version = 2
      assert.strictEqual((yield* Effect.flip(Vfs.decodeSnapshot(encode(original), limits))).code, "UnsupportedVersion")
      assert.strictEqual(
        (yield* Effect.flip(Vfs.decodeSnapshot(new Uint8Array([255]), limits))).code,
        "InvalidEncoding"
      )
      assert.strictEqual(
        (yield* Effect.flip(Vfs.decodeSnapshot(new Uint8Array(10), {
          ...limits,
          maxEncodedBytes: ByteSize.bytes(9)
        }))).code,
        "LimitExceeded"
      )
    }))

  it.effect("keeps byte limits exact above the safe-integer range", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const encoded = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
      const exactLimit = ByteSize.bytes(BigInt(Number.MAX_SAFE_INTEGER) + 1n)

      const decoded = yield* Vfs.decodeSnapshot(encoded, {
        ...limits,
        maxEncodedBytes: exactLimit,
        maxDecodedBytes: exactLimit
      })

      const restored = yield* Vfs.fromSnapshot(decoded)
      assert.deepStrictEqual(yield* (yield* restored.caller()).readDirectory("/"), [])
    }))

  it.effect(
    "captures a complete serial namespace when rename races and enforces decoded budgets",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.fromFixture({
          entries: [{ kind: "file", path: "/before", bytes: new Uint8Array([1, 2, 3]) }]
        })

        const fs = yield* volume.caller()

        const [snapshot] = yield* Effect.all([volume.snapshot, fs.rename("/before", "/after")], {
          concurrency: "unbounded"
        })

        const restored = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()
        const names = yield* restored.readDirectory("/")
        assert.isTrue(names.join() === "before" || names.join() === "after")
        const encoded = yield* Vfs.encodeSnapshot(snapshot)

        for (
          const bound of [
            { ...limits, maxRecords: 1 },
            { ...limits, maxEntries: 0 },
            { ...limits, maxDecodedBytes: ByteSize.bytes(2) }
          ]
        ) {
          assert.strictEqual((yield* Effect.flip(Vfs.decodeSnapshot(encoded, bound))).code, "LimitExceeded")
        }
      })
  )

  it.effect(
    "rejects fixture collisions, missing parents, hard-link cycles and destination limits",
    () =>
      Effect.gen(function*() {
        const invalid: Array<Vfs.Fixture> = [
          { entries: [{ kind: "directory", path: "/a/b" }] },
          { entries: [{ kind: "directory", path: "/a" }, { kind: "directory", path: "/a" }] },
          { entries: [{ kind: "hardLink", path: "/a", target: "/b" }, { kind: "hardLink", path: "/b", target: "/a" }] },
          { entries: [{ kind: "directory", path: "/a" }, { kind: "hardLink", path: "/b", target: "/a" }] }
        ]

        for (const fixture of invalid) yield* Effect.flip(Vfs.fromFixture(fixture))

        const limit = yield* Effect.flip(
          Vfs.fromFixture(
            { entries: [{ kind: "file", path: "/f", bytes: new Uint8Array(2) }] },
            { maxBytes: ByteSize.bytes(1) }
          )
        )

        assert.instanceOf(limit, Vfs.ImageError)
        assert.strictEqual(limit.code, "LimitExceeded")
      })
  )

  // Real scheduling: the assertion compares wall-clock durations, so virtual time would not measure
  // anything. Interruption is signalled by another fiber rather than a timer, because timer latency
  // on a loaded CI runner can exceed the walk itself. The 10,000-file setup can exceed Vitest's
  // five-second default when the workspace suites run in parallel.
  it.effect(
    "releases the volume after a snapshot is interrupted mid-walk",
    () =>
      TestClock.withLive(Effect.gen(function*() {
        const bytes = new Uint8Array(64)
        const entries: Array<Vfs.Fixture["entries"][number]> = []

        for (let directory = 0; directory < 100; directory++) {
          entries.push({ kind: "directory", path: `/d${directory}` })

          for (let file = 0; file < 100; file++) entries.push({ kind: "file", path: `/d${directory}/f${file}`, bytes })
        }

        const volume = yield* Vfs.fromFixture({ entries })
        const caller = yield* volume.caller()
        const started = performance.now()

        yield* volume.snapshot
        const full = performance.now() - started

        // The walk yields periodically and the read is interruptible, so interrupting it returns at the
        // next yield instead of waiting for the whole tree. An uninterruptible read measures near `full`.
        const fiber = yield* Effect.forkChild(volume.snapshot)

        yield* Effect.yieldNow
        const interruptStarted = performance.now()

        yield* Fiber.interrupt(fiber)
        assert.isBelow(performance.now() - interruptStarted, full / 4)

        yield* caller.writeFile("/after", bytes, { access: "write", create: "ifMissing" })
        const restored = yield* (yield* Vfs.fromSnapshot(yield* volume.snapshot)).caller()

        assert.strictEqual((yield* restored.lstat("/after")).kind, "file")
        assert.strictEqual((yield* restored.lstat("/d99/f99")).kind, "file")
      })),
    20_000
  )
})
