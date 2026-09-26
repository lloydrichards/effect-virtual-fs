import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Fiber, Predicate, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { BytePathId } from "../src/BytePath.js"
import { Testing, VirtualFileSystem as Vfs } from "../src/index.js"

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

const MutableLink = Schema.Struct({
  parent: Schema.mutableKey(Schema.Finite),
  name: Schema.mutableKey(Schema.String)
})

const SnapshotJson = Schema.fromJsonString(Schema.Struct({
  format: Schema.String,
  version: Schema.mutableKey(Schema.Finite),
  nodes: Schema.mutable(Schema.Tuple([
    Schema.TaggedStruct("directory", {
      ino: Schema.mutableKey(Schema.Finite),
      parent: Schema.mutableKey(Schema.Finite),
      name: Schema.mutableKey(Schema.String),
      metadata: Schema.mutableKey(MutableMetadata)
    }),
    Schema.TaggedStruct("file", {
      ino: Schema.mutableKey(Schema.Finite),
      links: Schema.mutableKey(Schema.mutable(Schema.Array(MutableLink))),
      content: Schema.mutableKey(Schema.Struct({
        _tag: Schema.mutableKey(Schema.String),
        bytes: Schema.mutableKey(Schema.optionalKey(Schema.String)),
        hash: Schema.mutableKey(Schema.optionalKey(Schema.String)),
        size: Schema.mutableKey(Schema.optionalKey(Schema.Finite))
      })),
      metadata: Schema.mutableKey(MutableMetadata)
    })
  ])),
  extra: Schema.mutableKey(Schema.optionalKey(Schema.Boolean))
}))

import { entryNames, text } from "./support/text.js"

describe("fixtures and snapshots", () => {
  it("rejects objects that forge the public BytePath symbol", () => {
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
            document.nodes[1].content.bytes,
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
        assert.strictEqual(text(yield* fs.readLink("/dangling")), "absent")
      })
  )

  it.effect("lists a fixture's entries in the byte order of their names whatever order declares them", () =>
    Effect.gen(function*() {
      const entries: Array<Vfs.Fixture["entries"][number]> = [
        { kind: "file", path: "/b", bytes: new Uint8Array() },
        { kind: "directory", path: "/c" },
        { kind: "symlink", path: "/a", target: "b" },
        { kind: "hardLink", path: "/B", target: "/b" }
      ]

      for (const declared of [entries, [...entries].reverse()]) {
        const fs = yield* (yield* Vfs.fromFixture({ entries: declared })).caller()
        assert.deepStrictEqual(entryNames(yield* fs.readDirectory("/")), ["B", "a", "b", "c"])
      }
    }))

  it.effect(
    "isolates capture, encoded bytes and independent restores from subsequent overwrites",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const fs = yield* Vfs.Caller
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
        assert.instanceOf(byteLimit, Vfs.VfsError)
        assert.strictEqual(byteLimit.code, "LimitExceeded")
        const entryLimit = yield* Effect.flip(Vfs.fromSnapshot(snapshot, { maxEntries: 0 }))
        assert.instanceOf(entryLimit, Vfs.VfsError)
        assert.strictEqual(entryLimit.code, "LimitExceeded")
      }).pipe(
        Effect.provide(
          Testing.layer({ fixture: { entries: [{ kind: "file", path: "/f", bytes: new Uint8Array([1, 2]) }] } })
        )
      )
  )

  it.effect(
    "preserves byte names and symlink aliases but excludes unlinked-open contents",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const fs = yield* Vfs.Caller
        const path = yield* Vfs.pathFromBytes(new Uint8Array([47, 255]))
        yield* fs.symlink("", path)
        yield* fs.link(path, "/alias")
        const f = yield* fs.open("/removed", { access: "write", create: "exclusive" })
        yield* f.write(new Uint8Array([1, 2, 3]))
        yield* fs.unlink("/removed")
        const restored = yield* (yield* Vfs.fromSnapshot(yield* volume.snapshot, { maxBytes: ByteSize.zero })).caller()
        assert.strictEqual(
          (yield* restored.stat(Vfs.Target.Path({ path: path, followFinalSymlink: false }))).ino,
          (yield* restored.stat(Vfs.Target.Path({ path: "/alias", followFinalSymlink: false }))).ino
        )
        assert.strictEqual((yield* Effect.flip(restored.stat("/removed"))).code, "NotFound")
        assert.strictEqual(text(yield* restored.readLink(path)), "")
      }).pipe(Effect.provide(Testing.layer()))
  )

  it.effect("rejects malformed graphs, unknown fields and noncanonical encodings", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({ entries: [{ kind: "file", path: "/f", bytes: new Uint8Array([102]) }] })

      const original = yield* Schema.decodeEffect(SnapshotJson)(
        new TextDecoder().decode(yield* Vfs.encodeSnapshot(yield* volume.snapshot))
      )

      assert.deepStrictEqual(original.nodes.map((node) => node._tag), ["directory", "file"])
      assert.isFalse(original.nodes.some((node) => Object.hasOwn(node, "kind")))

      for (
        const mutate of [
          (image: typeof original) => {
            image.nodes[0].metadata.extra = 1
          },
          (image: typeof original) => {
            image.nodes[0].metadata.uid = -1
          },
          (image: typeof original) => {
            image.nodes[1].ino = 0
          },
          (image: typeof original) => {
            image.nodes[1].ino = Number.MAX_SAFE_INTEGER
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
          image.nodes[1].content.bytes = "Zh=="
        }
      ]

      for (const mutate of mutations) {
        const image = structuredClone(original)
        mutate(image)
        yield* Effect.flip(Vfs.decodeSnapshot(encode(image), limits))
      }

      // A broken graph rule names the node that broke it.
      const graphMutations: Array<readonly [(image: typeof original) => void, string]> = [
        [(image) => {
          image.nodes[1].ino = image.nodes[0].ino
        }, "nodes.1.ino"],
        [(image) => {
          image.nodes[0].parent = 2
        }, "nodes.0"],
        [(image) => {
          image.nodes[0].name = "Zg=="
        }, "nodes.0"],
        [(image) => {
          image.nodes[1].links[0]!.parent = 9
        }, "nodes.1.links.0.parent"],
        [(image) => {
          image.nodes[1].links[0]!.parent = image.nodes[1].ino
        }, "nodes.1.links.0.parent"],
        [(image) => {
          image.nodes[1].links.push({ ...image.nodes[1].links[0]! })
        }, "nodes.1.links.1.name"],
        [(image) => {
          image.nodes[1].links[0]!.name = "Lg=="
        }, "nodes.1.links.0.name"],
        [(image) => {
          image.nodes[1].links[0]!.name = ""
        }, "nodes.1.links.0.name"],
        [(image) => {
          image.nodes[1].links = []
        }, "nodes.1.links"],
        [(image) => {
          image.nodes.reverse()
        }, "nodes.0"]
      ]

      for (const [mutate, field] of graphMutations) {
        const image = structuredClone(original)
        mutate(image)
        const error = yield* Effect.flip(Vfs.decodeSnapshot(encode(image), limits))
        assert.deepStrictEqual([error.code, error.field], ["InvalidStructure", field])
      }

      // A content reference is reserved: it decodes as a shape, and restoring refuses it by name.
      const reference = structuredClone(original)
      reference.nodes[1].content = { _tag: "Ref", hash: "00", size: 1 }
      const refused = yield* Effect.flip(Vfs.decodeSnapshot(encode(reference), limits))
      assert.deepStrictEqual([refused.code, refused.field], ["UnsupportedVersion", "nodes.1.content"])

      const alternateTimestamp = structuredClone(original)
      alternateTimestamp.nodes[1].metadata.mtimeNs = "01"

      const normalized = yield* Vfs.decodeSnapshot(encode(alternateTimestamp), limits)

      const normalizedImage = yield* Schema.decodeEffect(SnapshotJson)(
        new TextDecoder().decode(yield* Vfs.encodeSnapshot(normalized))
      )

      assert.strictEqual(normalizedImage.nodes[1].metadata.mtimeNs, "1")

      const longestAcceptedTimestamp = structuredClone(original)
      longestAcceptedTimestamp.nodes[1].metadata.mtimeNs = "0".repeat(128)
      yield* Vfs.decodeSnapshot(encode(longestAcceptedTimestamp), limits)

      for (const timestamp of ["0".repeat(129), "9".repeat(129)]) {
        const oversizedTimestamp = structuredClone(original)
        oversizedTimestamp.nodes[1].metadata.mtimeNs = timestamp
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
      const volume = yield* Vfs.Volume
      const encoded = yield* Vfs.encodeSnapshot(yield* volume.snapshot)
      const exactLimit = ByteSize.bytes(BigInt(Number.MAX_SAFE_INTEGER) + 1n)

      const decoded = yield* Vfs.decodeSnapshot(encoded, {
        ...limits,
        maxEncodedBytes: exactLimit,
        maxDecodedBytes: exactLimit
      })

      const restored = yield* Vfs.fromSnapshot(decoded)
      assert.deepStrictEqual(entryNames(yield* (yield* restored.caller()).readDirectory("/")), [])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect(
    "captures a complete serial namespace when rename races and enforces decoded budgets",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const fs = yield* Vfs.Caller

        const [snapshot] = yield* Effect.all([volume.snapshot, fs.rename("/before", "/after")], {
          concurrency: "unbounded"
        })

        const restored = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()
        const names = entryNames(yield* restored.readDirectory("/"))
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
      }).pipe(
        Effect.provide(
          Testing.layer({ fixture: { entries: [{ kind: "file", path: "/before", bytes: new Uint8Array([1, 2, 3]) }] } })
        )
      )
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

        assert.instanceOf(limit, Vfs.VfsError)
        assert.strictEqual(limit.code, "LimitExceeded")
      })
  )

  // Real scheduling: the assertions compare wall-clock durations, so virtual time would not measure
  // anything. Interruption is signalled by another fiber rather than a timer, because timer latency
  // on a loaded CI runner can exceed the walk itself. The 10,000-file setup can exceed Vitest's
  // five-second default when the workspace suites run in parallel.
  it.effect(
    "captures without walking the volume and stops an interrupted encode mid-walk",
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
        const snapshot = yield* volume.snapshot
        const started = performance.now()

        yield* Vfs.encodeSnapshot(snapshot)
        const full = performance.now() - started

        // A capture shares the volume's immutable value, so it costs nothing like the walk an encode makes.
        const captureStarted = performance.now()

        yield* volume.snapshot
        assert.isBelow(performance.now() - captureStarted, full / 4)

        // The encode walk yields periodically, so interrupting it returns at the next yield instead of
        // waiting for the whole tree.
        const fiber = yield* Effect.forkChild(Vfs.encodeSnapshot(snapshot))

        yield* Effect.yieldNow
        const interruptStarted = performance.now()

        yield* Fiber.interrupt(fiber)
        assert.isBelow(performance.now() - interruptStarted, full / 4)

        yield* caller.writeFile("/after", bytes, { access: "write", create: "ifMissing" })
        const restored = yield* (yield* Vfs.fromSnapshot(yield* volume.snapshot)).caller()

        assert.strictEqual(
          (yield* restored.stat(Vfs.Target.Path({ path: "/after", followFinalSymlink: false }))).kind,
          "file"
        )
        assert.strictEqual(
          (yield* restored.stat(Vfs.Target.Path({ path: "/d99/f99", followFinalSymlink: false }))).kind,
          "file"
        )
      })),
    20_000
  )
})
