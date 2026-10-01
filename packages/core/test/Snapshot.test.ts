import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Fiber, Layer, Option, Predicate, Schema, Stream } from "effect"
import * as Base64 from "effect/encoding/Base64"
import * as Hex from "effect/encoding/Hex"
import * as TestClock from "effect/testing/TestClock"
import { BytePath, LiveVolume, Testing, VirtualFileSystem as Vfs } from "../src/index.js"
import * as LiveImage from "../src/internal/liveImage.js"
import { ENCODED_CHUNK_BYTES } from "../src/internal/tree.js"
import { documentText, readLines, toLines, toLines as encode } from "./support/lines.js"
import { entryNames, text } from "./support/text.js"

const limits = {
  maxEncodedBytes: ByteSize.megabytes(1),
  maxRecords: 100,
  maxEntries: 100,
  maxDecodedBytes: ByteSize.kilobytes(100)
}

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

describe("snapshots", () => {
  it.layer(BunCrypto.layer)((it) => {
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
            const document = yield* Schema.decodeEffect(SnapshotJson)(documentText(encoded))
            assert.strictEqual(
              document.nodes[1].content.bytes,
              "AP9/".repeat(8_192) + suffix
            )
            const restored = yield* Vfs.fromSnapshot(yield* Vfs.decodeSnapshot(encoded, limits))
            assert.deepStrictEqual(yield* (yield* restored.caller()).readFile("/f"), input)
          }

          const input = new Uint8Array([0, 255, 127, 42])

          const encoded = yield* Vfs.encodeSnapshot(
            yield* (yield* Vfs.fromFixture({
              entries: [{ kind: "file", path: "/f", bytes: input }]
            })).snapshot
          )

          const document = yield* Schema.decodeEffect(SnapshotJson)(documentText(encoded))
          assert.strictEqual(document.nodes[1].content.bytes, "AP9/Kg==")

          const restored = yield* Vfs.fromSnapshot(yield* Vfs.decodeSnapshot(encoded, limits))
          assert.deepStrictEqual(yield* (yield* restored.caller()).readFile("/f"), input)
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should restore a large canonical payload when it fits the supplied budgets",
      () =>
        Effect.gen(function*() {
          const metadata = { uid: 0, gid: 0, mode: 0o644, atimeNs: "0", mtimeNs: "0", ctimeNs: "0", birthtimeNs: "0" }

          const encoded = encode({
            format: "effect-vfs",
            version: 1,
            nodes: [
              { _tag: "directory", ino: 1, parent: 1, name: "", metadata },
              {
                _tag: "file",
                ino: 2,
                links: [{ parent: 1, name: "Zg==" }],
                content: { _tag: "Inline", bytes: "AAAA".repeat(4_000_000) },
                metadata
              }
            ]
          })

          const snapshot = yield* Vfs.decodeSnapshot(encoded, {
            maxEncodedBytes: ByteSize.megabytes(17),
            maxRecords: 2,
            maxEntries: 1,
            maxDecodedBytes: ByteSize.bytes(12_000_001)
          })

          const caller = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()

          assert.strictEqual((yield* caller.stat("/f")).size, 12_000_000n)
          const file = yield* caller.open("/f", { access: "read" })
          assert.deepStrictEqual((yield* file.pread(1, 11_999_999n)).bytes, new Uint8Array([0]))
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should isolate capture, encoded bytes and independent restores from subsequent overwrites when source files change after capture",
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
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should preserve byte names and aliases but exclude unlinked content when capturing a snapshot",
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

          const restored = yield* (yield* Vfs.fromSnapshot(yield* volume.snapshot, { maxBytes: ByteSize.zero }))
            .caller()

          assert.strictEqual(
            (yield* restored.stat(Vfs.Target.Path({ path: path, followFinalSymlink: false }))).ino,
            (yield* restored.stat(Vfs.Target.Path({ path: "/alias", followFinalSymlink: false }))).ino
          )
          assert.strictEqual((yield* Effect.flip(restored.stat("/removed"))).code, "NotFound")
          assert.strictEqual(text(yield* restored.readLink(path)), "")
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should reject malformed graphs and noncanonical encodings when stored nodes or payloads are invalid",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.fromFixture({
            entries: [{ kind: "file", path: "/f", bytes: new Uint8Array([102]) }]
          })

          const original = yield* Schema.decodeEffect(SnapshotJson)(
            documentText(yield* Vfs.encodeSnapshot(yield* volume.snapshot))
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

          for (
            const data of [
              "A",
              "AAAAA",
              "AA=A",
              "=AAA",
              "AA==AAAA",
              "AAAAZh==",
              "AAAAZm9=",
              "AAAAAA==\n",
              "AAAA AA==",
              "AAAAAA-_"
            ]
          ) {
            const image = structuredClone(original)
            image.nodes[1].content.bytes = data
            assert.strictEqual(
              (yield* Effect.flip(Vfs.decodeSnapshot(encode(image), limits))).code,
              "InvalidEncoding",
              data
            )
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
            documentText(yield* Vfs.encodeSnapshot(normalized))
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
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should keep byte limits exact above the safe-integer range when a byte limit exceeds Number.MAX_SAFE_INTEGER",
      () =>
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
        }).pipe(Effect.provide(Testing.layer()))
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should capture a complete namespace and enforce budgets when rename races decoding",
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
            Testing.layer({
              fixture: { entries: [{ kind: "file", path: "/before", bytes: new Uint8Array([1, 2, 3]) }] }
            })
          )
        )
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should reject fixture collisions, missing parents, hard-link cycles and destination limits when fixture topology or limits are invalid",
      () =>
        Effect.gen(function*() {
          const invalid: Array<Vfs.Fixture> = [
            { entries: [{ kind: "directory", path: "/a/b" }] },
            { entries: [{ kind: "directory", path: "/a" }, { kind: "directory", path: "/a" }] },
            {
              entries: [{ kind: "hardLink", path: "/a", target: "/b" }, { kind: "hardLink", path: "/b", target: "/a" }]
            },
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
  })

  // Real scheduling: the assertions compare wall-clock durations, so virtual time would not measure
  // anything. Interruption is signalled by another fiber rather than a timer, because timer latency
  // on a loaded CI runner can exceed the walk itself. The 10,000-file setup can exceed Vitest's
  // five-second default when the workspace suites run in parallel.
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should capture when capture races a rename or encoding is interrupted",
      () =>
        TestClock.withLive(Effect.gen(function*() {
          const bytes = new Uint8Array(64)
          const entries: Array<Vfs.Fixture["entries"][number]> = []

          for (let directory = 0; directory < 100; directory++) {
            entries.push({ kind: "directory", path: `/d${directory}` })

            for (let file = 0; file < 100; file++) {
              entries.push({ kind: "file", path: `/d${directory}/f${file}`, bytes })
            }
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
})

describe("snapshot capture", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should capture fresh isolated state when a snapshot effect runs again",
      () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.Volume
          const caller = yield* Vfs.Caller
          const capture = volume.snapshot
          const before = yield* capture
          yield* caller.mkdir("/later")
          const after = yield* capture
          const original = yield* (yield* Vfs.fromSnapshot(before)).caller()
          const updated = yield* (yield* Vfs.fromSnapshot(after)).caller()
          assert.deepStrictEqual(entryNames(yield* original.readDirectory("/")), [])
          assert.deepStrictEqual(entryNames(yield* updated.readDirectory("/")), ["later"])
        }).pipe(Effect.provide(Testing.layer()))
    )
  })
})

const encoder = new TextEncoder()

const entriesOf = (snapshot: Vfs.Snapshot, root: Vfs.PathInput) =>
  Stream.runCollect(Vfs.snapshotEntries(snapshot, root))

// What an entry says, with paths and targets as text or as their bytes in hex.
const described = Effect.fnUntraced(function*(entries: ReadonlyArray<Vfs.Fixture["entries"][number]>) {
  const show = (path: Vfs.PathInput) =>
    Predicate.isString(path)
      ? Effect.succeed(path)
      : Effect.map(BytePath.toBytes(path), (bytes) => `0x${[...bytes].map((byte) => byte.toString(16)).join("")}`)

  const rows: Array<string> = []

  for (const entry of entries) {
    const target = entry.kind === "hardLink" || entry.kind === "symlink" ? ` -> ${yield* show(entry.target)}` : ""
    rows.push(`${entry.kind} ${yield* show(entry.path)}${target}`)
  }

  return rows
})

const tree = Effect.gen(function*() {
  const raw = yield* Vfs.pathFromBytes(new Uint8Array([...encoder.encode("/src/raw-"), 0xff]))

  const volume = yield* Vfs.fromFixture({
    entries: [
      { kind: "directory", path: "/src" },
      { kind: "directory", path: "/src/b" },
      { kind: "file", path: "/src/b/data", bytes: new Uint8Array([1, 2]), metadata: { mode: 0o600, mtimeNs: 5n } },
      { kind: "file", path: "/src/a", bytes: new Uint8Array([3]) },
      { kind: "hardLink", path: "/src/z", target: "/src/a" },
      { kind: "symlink", path: "/src/up", target: "b/data" },
      { kind: "file", path: raw, bytes: new Uint8Array() },
      { kind: "symlink", path: "/via", target: "src/b" },
      { kind: "symlink", path: "/loop", target: "loop/x" },
      { kind: "symlink", path: "/long", target: "/src/b/./././././././././data" }
    ]
  })

  return yield* volume.snapshot
})

describe("snapshot entries", () => {
  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should stream the tree under a root in sorted pre-order, rooted at the root when a root is selected",
      () =>
        Effect.gen(function*() {
          const entries = yield* entriesOf(yield* tree, "/src")

          assert.deepStrictEqual(yield* described(entries), [
            "directory /",
            "file /a",
            "directory /b",
            "file /b/data",
            "file 0x2f7261772dff",
            "symlink /up -> b/data",
            "hardLink /z -> /a"
          ])

          const data = entries[3]!
          assert.deepStrictEqual(data.kind === "file" && [data.bytes, data.metadata?.mode, data.metadata?.mtimeNs], [
            new Uint8Array([1, 2]),
            0o600,
            5n
          ])
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should hand out copied bytes and rebuild the tree when a fixture consumes streamed entries",
      () =>
        Effect.gen(function*() {
          const snapshot = yield* tree
          const entries = yield* entriesOf(snapshot, "/src")
          const [, first] = entries

          if (first?.kind === "file") first.bytes.fill(9)
          const again = yield* entriesOf(snapshot, "/src")
          assert.deepStrictEqual(again[1]?.kind === "file" && again[1].bytes, new Uint8Array([3]))

          // Every entry but the root's, which a fixture states through its root metadata.
          const [root, ...rest] = again
          const rootMetadata = root?.kind === "directory" ? root.metadata : undefined

          const rebuilt = yield* Vfs.fromFixture(
            rootMetadata === undefined ? { entries: rest } : { rootMetadata, entries: rest }
          )

          assert.deepStrictEqual(
            yield* described(yield* entriesOf(yield* rebuilt.snapshot, "/")),
            yield* described(again)
          )
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should resolve the root through intermediate links but not a final one when the root path contains intermediate or final links",
      () =>
        Effect.gen(function*() {
          const snapshot = yield* tree

          assert.deepStrictEqual(yield* described(yield* entriesOf(snapshot, "/via")), ["symlink / -> src/b"])
          assert.deepStrictEqual(yield* described(yield* entriesOf(snapshot, "/via/")), ["directory /", "file /data"])
          assert.deepStrictEqual(yield* described(yield* entriesOf(snapshot, "via/./data")), ["file /"])
          assert.deepStrictEqual(yield* described(yield* entriesOf(snapshot, "/src/b/../a")), ["file /"])
        })
    )
  })

  it.layer(BunCrypto.layer)((it) => {
    it.effect(
      "should apply caller permissions to root resolution when streaming a restored volume",
      () =>
        Effect.gen(function*() {
          const snapshot = yield* tree
          const caller = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()

          // What each side makes of a root: the kind it reaches, or the code it fails with.
          const outcome = <A>(effect: Effect.Effect<A, Vfs.VfsError>, kind: (value: A) => string) =>
            Effect.match(effect, { onFailure: (error) => error.code, onSuccess: kind })

          for (
            const root of [
              "/",
              "/src",
              "/via",
              "/via/",
              "via/./data",
              "/src/b/../a",
              "/via/../src",
              "/src/up",
              "/src/up/",
              "/long",
              "/long/",
              "/missing",
              "/src/a/",
              "/src/a/b",
              "/loop/",
              ""
            ]
          ) {
            const entries = yield* outcome(
              Stream.runHead(Vfs.snapshotEntries(snapshot, root)),
              Option.match({ onNone: () => "empty", onSome: (entry) => entry.kind })
            )

            const stated = yield* outcome(
              caller.stat(Vfs.Target.Path({ path: root, followFinalSymlink: false })),
              (metadata) => metadata.kind
            )

            assert.strictEqual(entries, stated, root)
          }

          const failed = yield* Effect.flip(Stream.runHead(Vfs.snapshotEntries(snapshot, "/missing")))
          assert.strictEqual(failed.operation, "snapshotEntries")
        })
    )
  })
})

{
  const LIMITS: Vfs.DecodeLimits = {
    maxEncodedBytes: ByteSize.megabytes(1),
    maxRecords: 100,
    maxEntries: 100,
    maxDecodedBytes: ByteSize.kilobytes(100)
  }

  const encoder = new TextEncoder()

  const METADATA = { uid: 0, gid: 0, mode: 0o755, atimeNs: "0", mtimeNs: "0", ctimeNs: "0", birthtimeNs: "0" }

  const HEADER = "{\"format\":\"effect-vfs\",\"version\":1}"

  const ROOT_NODE = { _tag: "directory", ino: 1, parent: 1, name: "", metadata: METADATA }

  const FILE_NODE = {
    _tag: "file",
    ino: 2,
    links: [{ parent: 1, name: "Zg==" }],
    content: { _tag: "Inline", bytes: "AQID" },
    metadata: METADATA
  }

  const ROOT = JSON.stringify(ROOT_NODE)

  const FILE = JSON.stringify(FILE_NODE)

  // The whole tree as one document, the layout before lines.
  const DOCUMENT = JSON.stringify({ format: "effect-vfs", version: 1, nodes: [ROOT_NODE] })

  // An empty volume's snapshot as the release before lines wrote it.
  const PREVIOUS_RELEASE =
    "{\"format\":\"effect-vfs\",\"version\":1,\"root\":\"0\",\"records\":[{\"_tag\":\"directory\",\"id\":\"0\","
    + "\"metadata\":{\"uid\":0,\"gid\":0,\"mode\":493,\"atimeNs\":\"0\",\"mtimeNs\":\"0\",\"ctimeNs\":\"0\",\"birthtimeNs\":\"0\"},"
    + "\"entries\":[]}]}"

  // A root holding the file `/f` with the bytes 1, 2, 3, as the lines given.
  const text = (...lines: ReadonlyArray<string>) => encoder.encode(lines.join(""))

  const VALID = text(`${HEADER}\n`, `${ROOT}\n`, `${FILE}\n`)

  // Chunks that end the stream with a defect, so a sink that reads past them dies instead of failing.
  const thenDie = (...chunks: ReadonlyArray<Uint8Array>) =>
    Stream.concat(Stream.fromIterable(chunks), Stream.die("the sink read past the line that broke a limit"))

  const sinkFailure = (input: Stream.Stream<Uint8Array>, limits: Vfs.DecodeLimits = LIMITS) =>
    Effect.map(Effect.flip(Stream.run(input, Vfs.decodeSnapshotSink(limits))), (error) => [error.code, error.field])

  const failure = (input: Uint8Array, limits: Vfs.DecodeLimits = LIMITS) =>
    Effect.map(Effect.flip(Vfs.decodeSnapshot(input, limits)), (error) => [error.code, error.field])

  // A chunk type the reader accepts whose slice shares its bytes, as Node's Buffer does.
  class SlicesAsViews extends Uint8Array {
    override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
      return this.subarray(start, end)
    }
  }

  // This memory-bound test uses the same Bun runtime as the rest of the test suite.
  const BUN_JSC: string = "bun:jsc"
  const NODE_PROCESS: string = "node:process"

  interface Usage {
    readonly memoryUsage: () => { readonly heapUsed: number; readonly external: number }
  }

  // A forced collection, and the bytes the heap and its array buffers hold.
  const bunHeap = Effect.gen(function*() {
    const jsc: { readonly fullGC: () => void } = yield* Effect.promise(() => import(BUN_JSC))
    const process: Usage = yield* Effect.promise(() => import(NODE_PROCESS))

    return {
      gc: jsc.fullGC,
      memory: () => {
        const usage = process.memoryUsage()

        return usage.heapUsed + usage.external
      }
    }
  })

  const readFile = Effect.fnUntraced(function*(snapshot: Vfs.Snapshot, path: string) {
    return yield* (yield* (yield* Vfs.fromSnapshot(snapshot)).caller()).readFile(path)
  })

  const sample = Effect.gen(function*() {
    const volume = yield* Vfs.fromFixture({
      entries: [
        { kind: "directory", path: "/d" },
        { kind: "file", path: "/d/f", bytes: new Uint8Array([1, 2, 3]) },
        { kind: "hardLink", path: "/alias", target: "/d/f" },
        { kind: "symlink", path: "/s", target: "d/f" }
      ]
    })

    return yield* volume.snapshot
  })

  describe("snapshot lines", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should encode a header line and then one line per node, every line ending in a newline when a tree is encoded",
        () =>
          Effect.gen(function*() {
            const encoded = yield* Vfs.encodeSnapshot(yield* sample)
            const lines = readLines(encoded)

            assert.strictEqual(encoded.at(-1), 10)
            assert.deepStrictEqual(lines[0], { format: "effect-vfs", version: 1 })

            const nodes = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ ino: Schema.Finite })))(
              lines.slice(1)
            )

            assert.deepStrictEqual(nodes.map((node) => node.ino), [1, 2, 3, 4])

            const decoded = yield* Vfs.decodeSnapshot(VALID, LIMITS)
            assert.deepStrictEqual(yield* Vfs.encodeSnapshot(decoded), VALID)
            assert.deepStrictEqual(yield* readFile(decoded, "/f"), new Uint8Array([1, 2, 3]))
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should stream and decode the same bytes when input arrives in arbitrary chunks",
        () =>
          Effect.gen(function*() {
            const snapshot = yield* sample
            const encoded = yield* Vfs.encodeSnapshot(snapshot)
            const chunks = yield* Stream.runCollect(Vfs.encodeSnapshotStream(snapshot))

            assert.deepStrictEqual(new Uint8Array(chunks.flatMap((chunk) => [...chunk])), encoded)

            for (const size of [1, 2, 7, encoded.length]) {
              const pieces = Array.from(
                { length: Math.ceil(encoded.length / size) },
                (_, index) => encoded.subarray(index * size, (index + 1) * size)
              )

              const decoded = yield* Stream.run(Stream.fromIterable(pieces), Vfs.decodeSnapshotSink(LIMITS))
              assert.deepStrictEqual(yield* Vfs.encodeSnapshot(decoded), encoded, String(size))
            }
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should stream chunks of at most 128 lines and the chunk byte cap, a line past the cap in a chunk of its own when a chunk reaches line or byte caps",
        () =>
          Effect.gen(function*() {
            const KIB = 1024

            const file = (index: number, bytes: number) => ({
              kind: "file" as const,
              path: `/f${String(index).padStart(3, "0")}`,
              bytes: new Uint8Array(bytes).fill(index)
            })

            // Small files that fill a chunk by count, files a few of which fill it by bytes, and files past the cap.
            const volume = yield* Vfs.fromFixture({
              entries: Array.from(
                { length: 340 },
                (_, index) => file(index, index < 300 ? 16 : index < 336 ? 30 * KIB : 200 * KIB)
              )
            })

            const snapshot = yield* volume.snapshot
            const chunks = yield* Stream.runCollect(Vfs.encodeSnapshotStream(snapshot))
            const newlines = (chunk: Uint8Array) => chunk.reduce((count, byte) => byte === 10 ? count + 1 : count, 0)

            assert.deepStrictEqual(
              new Uint8Array(chunks.flatMap((chunk) => [...chunk])),
              yield* Vfs.encodeSnapshot(snapshot)
            )

            for (const chunk of chunks) {
              assert.isAtMost(newlines(chunk), 128)
              assert.isTrue(chunk.length <= ENCODED_CHUNK_BYTES || newlines(chunk) === 1, String(chunk.length))
            }
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should keep the start of an unfinished line when the producer reuses its read buffer",
        () =>
          Effect.gen(function*() {
            const encoded = yield* Vfs.encodeSnapshot(yield* sample)

            // A plain Uint8Array, and one whose slice is a view rather than a copy, as Node's Buffer's is.
            for (const shared of [new Uint8Array(16), new SlicesAsViews(16)]) {
              const pieces = function*() {
                for (let offset = 0; offset < encoded.length; offset += shared.length) {
                  const piece = encoded.subarray(offset, offset + shared.length)
                  shared.set(piece)
                  yield shared.subarray(0, piece.length)
                }
              }

              const decoded = yield* Stream.run(
                Stream.fromIterable({ [Symbol.iterator]: pieces }, { chunkSize: 1 }),
                Vfs.decodeSnapshotSink(LIMITS)
              )

              assert.deepStrictEqual(yield* Vfs.encodeSnapshot(decoded), encoded, shared.constructor.name)
            }
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should hold an unfinished line in memory proportional to its bytes however finely it is chunked when a long line is split into small chunks",
        () =>
          Effect.gen(function*() {
            const { gc, memory } = yield* bunHeap
            const length = 1_000_000
            const limits = { ...LIMITS, maxEncodedBytes: ByteSize.megabytes(4), maxLineBytes: ByteSize.bytes(length) }
            let held = 0

            gc()
            const before = memory()

            const bytes = function*() {
              yield encoder.encode(`${HEADER}\n`)

              for (let index = 0; index < length; index++) yield new Uint8Array([0x41])
              // The reader now holds the whole unfinished line.
              gc()
              held = memory() - before
            }

            const refused = yield* sinkFailure(Stream.fromIterable({ [Symbol.iterator]: bytes }), limits)

            assert.deepStrictEqual(refused, ["InvalidEncoding", "text"])
            assert.isBelow(held, 8 * length)
          }),
        { timeout: 60_000 }
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should refuse a line past maxLineBytes before reading the rest of the input when a line exceeds maxLineBytes",
        () =>
          Effect.gen(function*() {
            const bounded = { ...LIMITS, maxLineBytes: ByteSize.bytes(FILE.length) }

            yield* Stream.run(Stream.succeed(VALID), Vfs.decodeSnapshotSink(bounded))
            const tighter = { ...LIMITS, maxLineBytes: ByteSize.bytes(FILE.length - 1) }
            assert.deepStrictEqual(yield* failure(VALID, tighter), ["LimitExceeded", "lineBytes"])

            // A line that never ends is refused once it outgrows the bound, one byte at a time.
            const endless = encoder.encode(`${HEADER}\n${ROOT}\n${FILE}`)
            const bytes = [...endless].map((byte) => new Uint8Array([byte]))
            assert.deepStrictEqual(yield* sinkFailure(thenDie(...bytes), tighter), ["LimitExceeded", "lineBytes"])
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should refuse a line that breaks a budget or a rule before reading the next line, in its chunk or the next when a line breaks a rule or budget",
        () =>
          Effect.gen(function*() {
            // Each case ends its chunk with a line that is not JSON, so a reader that parsed a chunk's lines before
            // checking them would name that line instead.
            assert.deepStrictEqual(
              yield* sinkFailure(thenDie(text(`${HEADER}\n`, `${ROOT}\n`, `${FILE}\n`, "not json\n")), {
                ...LIMITS,
                maxRecords: 1
              }),
              ["LimitExceeded", "records"]
            )

            assert.deepStrictEqual(
              yield* sinkFailure(thenDie(text(`${HEADER}\n`, `${ROOT}\n`, `${FILE}\n`, "not json\n")), {
                ...LIMITS,
                maxDecodedBytes: ByteSize.bytes(3)
              }),
              ["LimitExceeded", "bytes"]
            )

            assert.deepStrictEqual(
              yield* sinkFailure(thenDie(text(`${HEADER}\n`, `${FILE}\n`, "not json\n"))),
              ["InvalidStructure", "nodes.0"]
            )

            assert.deepStrictEqual(
              yield* sinkFailure(thenDie(VALID), { ...LIMITS, maxEncodedBytes: ByteSize.bytes(VALID.length - 1) }),
              ["LimitExceeded", "encodedBytes"]
            )
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should reject missing newlines carriage returns and empty lines when decoding line input",
        () =>
          Effect.gen(function*() {
            for (
              const input of [
                text(`${HEADER}\n`, `${ROOT}\n`, FILE),
                text(`${HEADER}\r\n`, `${ROOT}\n`, `${FILE}\n`),
                text(`${HEADER}\n`, `${ROOT}\r\n`, `${FILE}\r\n`),
                text(`${HEADER}\n`, "\n", `${ROOT}\n`, `${FILE}\n`),
                text(`${HEADER}\n`, `${ROOT}\n`, `${FILE}\n`, "\n"),
                text("\n")
              ]
            ) assert.deepStrictEqual(yield* failure(input), ["InvalidEncoding", "text"])
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should decode split UTF-8 and reject malformed bytes when chunks cross code points",
        () =>
          Effect.gen(function*() {
            // "é" is two bytes. Split between them, the line still decodes, and the header is refused only for the
            // field it adds.
            const accented = encoder.encode(`{"format":"effect-vfs","version":1,"é":1}\n${ROOT}\n`)
            const split = accented.indexOf(0xc3) + 1

            assert.deepStrictEqual(
              yield* sinkFailure(Stream.make(accented.subarray(0, split), accented.subarray(split))),
              ["InvalidStructure", "document"]
            )

            // The first byte of a two-byte sequence, followed by a quote, is not UTF-8 however it is chunked.
            const malformed = new Uint8Array([...encoder.encode(`{"format":"effect-vfs","version":1,"`), 0xc3, 0x22])

            for (const at of [malformed.length - 1, malformed.length - 2]) {
              assert.deepStrictEqual(
                yield* sinkFailure(
                  Stream.make(malformed.subarray(0, at), malformed.subarray(at), encoder.encode(":1}\n"))
                ),
                ["InvalidEncoding", "text"]
              )
            }

            // A sequence the input cuts short is refused rather than dropped.
            assert.deepStrictEqual(yield* failure(new Uint8Array([...VALID, 0xe2, 0x82])), ["InvalidEncoding", "text"])
            assert.deepStrictEqual(yield* failure(new Uint8Array([0xef, 0xbb, 0xbf, ...VALID])), [
              "InvalidEncoding",
              "text"
            ])
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should require the header first and exactly once when the header is missing or repeated",
        () =>
          Effect.gen(function*() {
            assert.deepStrictEqual(yield* failure(text(`${ROOT}\n`, `${FILE}\n`)), ["InvalidStructure", "document"])
            assert.deepStrictEqual(yield* failure(new Uint8Array()), ["InvalidStructure", "document"])
            assert.deepStrictEqual(yield* failure(text(`${HEADER}\n`)), ["InvalidStructure", "nodes.0"])

            assert.deepStrictEqual(
              yield* failure(text(`${HEADER}\n`, `${HEADER}\n`, `${ROOT}\n`, `${FILE}\n`)),
              ["InvalidStructure", "document"]
            )

            assert.deepStrictEqual(
              yield* failure(text(`${HEADER}\n`, `${ROOT}\n`, `${FILE}\n`, `${HEADER}\n`)),
              ["InvalidStructure", "document"]
            )

            // The whole tree as one document, the layout before lines, is a header with a field it does not have.
            assert.deepStrictEqual(yield* failure(text(`${DOCUMENT}\n`)), ["InvalidStructure", "document"])

            // An empty volume as the previous release encoded it: one document and no final newline, so it is cut short.
            assert.deepStrictEqual(yield* failure(text(PREVIOUS_RELEASE)), ["InvalidEncoding", "text"])
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should check the rules that span nodes once the last line is read when cross-node rules require the final line",
        () =>
          Effect.gen(function*() {
            // The file names a directory that a later line would have to hold; none does.
            const orphan = toLines({
              format: "effect-vfs",
              version: 1,
              nodes: [ROOT_NODE, { ...FILE_NODE, links: [{ parent: 3, name: "Zg==" }] }]
            })

            assert.deepStrictEqual(yield* failure(orphan), ["InvalidStructure", "nodes.1.links.0.parent"])

            // A later directory can hold an earlier file.
            const later = toLines({
              format: "effect-vfs",
              version: 1,
              nodes: [
                ROOT_NODE,
                { ...FILE_NODE, links: [{ parent: 3, name: "Zg==" }] },
                { _tag: "directory", ino: 3, parent: 1, name: "ZA==", metadata: METADATA }
              ]
            })

            assert.deepStrictEqual(
              yield* readFile(yield* Vfs.decodeSnapshot(later, LIMITS), "/d/f"),
              new Uint8Array([1, 2, 3])
            )
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should encode under limits exactly what decoding under the same limits accepts when matching limits are used for both directions",
        () =>
          Effect.gen(function*() {
            const snapshot = yield* sample
            const encoded = yield* Vfs.encodeSnapshot(snapshot)
            const lines = new TextDecoder().decode(encoded).split("\n").slice(0, -1)
            const longest = Math.max(...lines.map((line) => line.length))

            // Four objects and four names; the names and payloads decode to d, f, alias, s, three bytes and d/f.
            const exact: Vfs.DecodeLimits = {
              maxEncodedBytes: ByteSize.bytes(encoded.length),
              maxRecords: 4,
              maxEntries: 4,
              maxDecodedBytes: ByteSize.bytes(14),
              maxLineBytes: ByteSize.bytes(longest)
            }

            assert.deepStrictEqual(yield* Vfs.encodeSnapshot(snapshot, exact), encoded)
            yield* Vfs.decodeSnapshot(encoded, exact)

            for (
              const [limits, field] of [
                [{ ...exact, maxEncodedBytes: ByteSize.bytes(encoded.length - 1) }, "encodedBytes"],
                [{ ...exact, maxRecords: 3 }, "records"],
                [{ ...exact, maxEntries: 3 }, "entries"],
                [{ ...exact, maxDecodedBytes: ByteSize.bytes(13) }, "bytes"],
                [{ ...exact, maxLineBytes: ByteSize.bytes(longest - 1) }, "lineBytes"]
              ] as const
            ) {
              const refused = yield* Effect.flip(Vfs.encodeSnapshot(snapshot, limits))
              assert.deepStrictEqual([refused.code, refused.operation, refused.field], [
                "LimitExceeded",
                "encodeSnapshot",
                field
              ])
              assert.deepStrictEqual(yield* failure(encoded, limits), ["LimitExceeded", field])
            }

            // With two limits broken, encoding names the one decoding meets first, whether the bytes arrive at once or a
            // byte at a time: the longest line outgrows the input's budget at its third byte, before its own bound.
            const bytewise = [...encoded].map((byte) => new Uint8Array([byte]))
            const before = lines.slice(0, lines.findIndex((line) => line.length === longest)).join("\n").length + 1

            for (
              const [limits, field] of [
                [{ ...exact, maxRecords: 2, maxEncodedBytes: ByteSize.bytes(encoded.length - 1) }, "records"],
                [
                  {
                    ...exact,
                    maxLineBytes: ByteSize.bytes(longest - 1),
                    maxEncodedBytes: ByteSize.bytes(encoded.length - 1)
                  },
                  "lineBytes"
                ],
                [
                  { ...exact, maxLineBytes: ByteSize.bytes(longest - 1), maxEncodedBytes: ByteSize.bytes(before + 2) },
                  "encodedBytes"
                ],
                // A line bound left to default to the input's crosses it at the same byte, and the input's is named.
                [{ ...LIMITS, maxEncodedBytes: ByteSize.bytes(1) }, "encodedBytes"]
              ] as const
            ) {
              const refused = yield* Effect.flip(Vfs.encodeSnapshot(snapshot, limits))
              assert.deepStrictEqual(refused.field, field)
              assert.deepStrictEqual(yield* failure(encoded, limits), ["LimitExceeded", field])
              assert.deepStrictEqual(yield* sinkFailure(Stream.fromIterable(bytewise), limits), [
                "LimitExceeded",
                field
              ])
            }

            const invalid = yield* Effect.flip(Vfs.encodeSnapshot(snapshot, { ...exact, maxRecords: -1 }))
            assert.deepStrictEqual([invalid.code, invalid.field], ["InvalidArgument", "maxRecords"])
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should read a live image's runtime block from its first line when a live image header is decoded",
        () =>
          Effect.gen(function*() {
            const image = yield* LiveVolume.prepareEmptyImage()
            const [header, ...nodes] = readLines(image)

            assert.deepStrictEqual(Object.keys(Object(header)), ["format", "version", "runtime"])
            assert.strictEqual(nodes.length, 1)
            assert.strictEqual(image.at(-1), 10)

            const failed = yield* Effect.flip(
              LiveImage.decode(image.subarray(0, image.length - 1), ByteSize.kilobytes(64))
            )

            assert.deepStrictEqual([failed.code, failed.field], ["InvalidEncoding", "liveImage"])
          })
      )
    })
  })
}

{
  const LIMITS: Vfs.DecodeLimits = {
    maxEncodedBytes: ByteSize.megabytes(1),
    maxRecords: 1_000,
    maxEntries: 1_000,
    maxDecodedBytes: ByteSize.megabytes(1)
  }

  const encoder = new TextEncoder()

  const bytes = (value: string) => encoder.encode(value)

  // A name that is not UTF-8, so no string path can reach it.
  const RAW_NAME = new Uint8Array([0xff, 0x41])

  // Longer than one base64 encoding chunk, with a length that needs padding.
  const LARGE: Uint8Array<ArrayBuffer> = Uint8Array.from({ length: 24_577 }, (_, index) => index % 251)

  const EXTREME_NS = 10n ** 127n

  const METADATA = { uid: 0, gid: 0, mode: 0o755, atimeNs: "0", mtimeNs: "0", ctimeNs: "0", birthtimeNs: "0" }

  const ROOT_NODE = { _tag: "directory", ino: 1, parent: 1, name: "", metadata: METADATA }

  const base64 = (value: string) => Base64.encode(bytes(value))

  // A snapshot's nodes as JSON values, each keeping every field it was written with.
  const SampleTree = Schema.fromJsonString(Schema.Struct({
    format: Schema.String,
    version: Schema.Finite,
    nodes: Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
  }))

  const snapshotOf = (nodes: ReadonlyArray<object>) => toLines({ format: "effect-vfs", version: 1, nodes })

  // POSIX NAME_MAX, the longest name a directory holds.
  const NAME_MAX = 255

  const rootNames = (caller: Vfs.Caller) => Effect.map(caller.readDirectory("/"), entryNames)

  // Every node kind, an empty and a multi-chunk file, byte names and targets, a hard link across directories, the
  // setuid, setgid and sticky bits, and timestamps at both ends of the range.
  const fixture = (raw: BytePath.BytePath, rawTarget: BytePath.BytePath): Vfs.Fixture => ({
    rootMetadata: { mode: 0o1777, uid: 3, gid: 4 },
    entries: [
      { kind: "directory", path: "/a", metadata: { mode: 0o2750, atimeNs: -EXTREME_NS, birthtimeNs: 5n } },
      { kind: "directory", path: "/a/b" },
      { kind: "file", path: "/a/b/large", bytes: LARGE, metadata: { mode: 0o4755, mtimeNs: EXTREME_NS } },
      { kind: "file", path: "/empty", bytes: new Uint8Array() },
      { kind: "hardLink", path: "/linked", target: "/a/b/large" },
      { kind: "file", path: raw, bytes: RAW_NAME, metadata: { uid: 70_000, gid: 80_000 } },
      { kind: "symlink", path: "/a/raw-target", target: rawTarget },
      { kind: "symlink", path: "/a/empty-target", target: "" }
    ]
  })

  const describeTree = Effect.fnUntraced(function*(caller: Vfs.Caller) {
    const walked = yield* Stream.runCollect(caller.walk("/"))

    const objects: Array<{ path: Uint8Array; reference: Vfs.ObjectReference }> = [
      { path: bytes("/"), reference: yield* caller.root }
    ]

    for (const entry of walked) objects.push({ path: yield* BytePath.toBytes(entry.path), reference: entry.reference })
    const paths = new Map<bigint, Array<string>>()
    const rows: Array<{ key: string; ino: bigint; metadata: object; payload: string | undefined }> = []

    for (const { path, reference } of objects) {
      const { ino, revision: _revision, ...metadata } = yield* caller.stat(reference)
      const key = Hex.encode(path)
      paths.set(ino, [...(paths.get(ino) ?? []), key])

      const payload = metadata.kind === "file"
        ? yield* caller.readFile(reference)
        : metadata.kind === "symlink"
        ? yield* caller.readLink(reference)
        : undefined

      rows.push({ key, ino, metadata, payload: payload === undefined ? undefined : Hex.encode(payload) })
    }

    // Inode numbers are not portable, so each row names the paths that share its object instead.
    return rows
      .map(({ ino, ...row }) => ({ ...row, links: [...(paths.get(ino) ?? [])].sort() }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  })

  const inodes = Effect.fnUntraced(function*(caller: Vfs.Caller) {
    const walked = yield* Stream.runCollect(caller.walk("/"))
    const found = [(yield* caller.stat("/")).ino]

    for (const entry of walked) found.push((yield* caller.stat(entry.reference)).ino)

    return found
  })

  // A live image store that keeps the last committed image in memory.
  const memoryImageStore = () => {
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

  const richVolume = Effect.gen(function*() {
    const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, ...RAW_NAME]))
    const rawTarget = yield* Vfs.pathFromBytes(new Uint8Array([0xfe, 47, 0x80]))
    const volume = yield* Vfs.fromFixture(fixture(raw, rawTarget))
    const caller = yield* volume.caller()

    // Changes made after construction: a rename, a second hard link, and an open file that no name reaches, which a
    // snapshot must leave out.
    yield* caller.rename("/empty", "/a/moved")
    yield* caller.link("/a/b/large", "/a/second")
    const open = yield* caller.open("/gone", { access: "write", create: "exclusive" })
    yield* open.write(new Uint8Array([1, 2, 3]))
    yield* caller.unlink("/gone")

    return { volume, caller }
  })

  describe("snapshot round trips", () => {
    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should re-encode decoded bytes identically and restore the captured tree when loading a snapshot",
        () =>
          Effect.gen(function*() {
            const { volume, caller } = yield* richVolume
            const expected = yield* describeTree(caller)
            const snapshot = yield* volume.snapshot
            const encoded = yield* Vfs.encodeSnapshot(snapshot)
            const decoded = yield* Vfs.decodeSnapshot(encoded, LIMITS)

            assert.deepStrictEqual(yield* Vfs.encodeSnapshot(decoded), encoded)
            assert.deepStrictEqual(yield* describeTree(yield* (yield* Vfs.fromSnapshot(snapshot)).caller()), expected)
            assert.deepStrictEqual(yield* describeTree(yield* (yield* Vfs.fromSnapshot(decoded)).caller()), expected)
            assert.deepStrictEqual(yield* describeTree(yield* (yield* Vfs.makeOverlay(decoded)).caller()), expected)
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should encode a fixture's volume the same however often it is built when a fixture is rebuilt repeatedly",
        () =>
          Effect.gen(function*() {
            const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, ...RAW_NAME]))
            const rawTarget = yield* Vfs.pathFromBytes(new Uint8Array([0xfe, 47, 0x80]))
            const first = yield* Vfs.encodeSnapshot(yield* (yield* Vfs.fromFixture(fixture(raw, rawTarget))).snapshot)
            const second = yield* Vfs.encodeSnapshot(yield* (yield* Vfs.fromFixture(fixture(raw, rawTarget))).snapshot)

            assert.deepStrictEqual(second, first)
            assert.deepStrictEqual(yield* Vfs.encodeSnapshot(yield* Vfs.decodeSnapshot(first, LIMITS)), first)
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect("should allocate fresh inodes when a decoded tree has inode gaps", () =>
        Effect.gen(function*() {
          const volume = yield* Vfs.make()
          const caller = yield* volume.caller()

          for (let index = 0; index < 80; index++) {
            yield* caller.writeFile(`/f${index}`, new Uint8Array([index]), { access: "write", create: "exclusive" })
          }

          for (let index = 0; index < 80; index += 3) yield* caller.unlink(`/f${index}`)
          const snapshot = yield* Vfs.decodeSnapshot(yield* Vfs.encodeSnapshot(yield* volume.snapshot), LIMITS)

          for (const restored of [yield* Vfs.fromSnapshot(snapshot), yield* Vfs.makeOverlay(snapshot)]) {
            const fs = yield* restored.caller()

            for (let index = 0; index < 80; index++) {
              yield* fs.writeFile(`/g${index}`, new Uint8Array([index]), { access: "write", create: "exclusive" })
            }

            const found = yield* inodes(fs)
            assert.strictEqual(new Set(found).size, found.length)
            assert.strictEqual(found.length, 1 + 80 - 27 + 80)
            assert.deepStrictEqual(yield* fs.readFile("/f79"), new Uint8Array([79]))
          }
        }))
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should reopen a live image with the tree and allocator it committed when a live volume reopens",
        () => {
          const store = memoryImageStore()

          const options = {
            maxImageBytes: ByteSize.megabytes(1),
            volume: {
              maxEntries: 100,
              maxBytes: ByteSize.kilobytes(256),
              maxFileBytes: ByteSize.kilobytes(64),
              maxPathBytes: ByteSize.bytes(1024)
            }
          }

          return Effect.gen(function*() {
            const expected = yield* Effect.scoped(Effect.gen(function*() {
              const caller = yield* (yield* LiveVolume.open(options)).caller()
              const raw = yield* Vfs.pathFromBytes(new Uint8Array([47, ...RAW_NAME]))
              yield* caller.mkdir("/a", { mode: 0o2750 })
              yield* caller.writeFile("/a/large", LARGE, { access: "write", create: "exclusive" })
              yield* caller.link("/a/large", "/linked")
              yield* caller.symlink(yield* Vfs.pathFromBytes(new Uint8Array([0xfe, 47, 0x80])), raw)
              yield* caller.writeFile("/doomed", new Uint8Array([1]), { access: "write", create: "exclusive" })
              yield* caller.unlink("/doomed")
              yield* caller.chmod("/a/large", 0o4755)

              return { tree: yield* describeTree(caller), inodes: yield* inodes(caller) }
            }))

            yield* Effect.scoped(Effect.gen(function*() {
              const caller = yield* (yield* LiveVolume.open(options)).caller()
              assert.deepStrictEqual(yield* describeTree(caller), expected.tree)
              assert.deepStrictEqual(yield* inodes(caller), expected.inodes)

              const created = yield* caller.mkdir("/new")
              const ino = (yield* caller.stat(created.reference)).ino
              assert.isFalse(expected.inodes.includes(ino))
              assert.isTrue(ino > expected.inodes.reduce((max, next) => (next > max ? next : max)))
            }))
          }).pipe(Effect.provide(store))
        }
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should list directories in byte order when snapshots are restored or live images reopen",
        () =>
          Effect.gen(function*() {
            const volume = yield* Vfs.make()
            const caller = yield* volume.caller()
            yield* caller.writeFile("/zeta", new Uint8Array([1]), { access: "write", create: "exclusive" })
            yield* caller.writeFile("/alpha", new Uint8Array([2]), { access: "write", create: "exclusive" })
            assert.deepStrictEqual(yield* rootNames(caller), ["zeta", "alpha"])

            const snapshot = yield* volume.snapshot
            const decoded = yield* Vfs.decodeSnapshot(yield* Vfs.encodeSnapshot(snapshot), LIMITS)

            for (
              const restored of [
                yield* Vfs.fromSnapshot(snapshot),
                yield* Vfs.fromSnapshot(decoded),
                yield* Vfs.makeOverlay(snapshot),
                yield* Vfs.makeOverlay(decoded)
              ]
            ) assert.deepStrictEqual(yield* rootNames(yield* restored.caller()), ["alpha", "zeta"])

            const options = {
              maxImageBytes: ByteSize.megabytes(1),
              volume: {
                maxEntries: 100,
                maxBytes: ByteSize.kilobytes(256),
                maxFileBytes: ByteSize.kilobytes(64),
                maxPathBytes: ByteSize.bytes(1024)
              }
            }

            yield* Effect.gen(function*() {
              yield* Effect.scoped(Effect.gen(function*() {
                const liveCaller = yield* (yield* LiveVolume.open(options)).caller()
                yield* liveCaller.writeFile("/zeta", new Uint8Array([1]), { access: "write", create: "exclusive" })
                yield* liveCaller.writeFile("/alpha", new Uint8Array([2]), { access: "write", create: "exclusive" })
                assert.deepStrictEqual(yield* rootNames(liveCaller), ["zeta", "alpha"])
              }))

              yield* Effect.scoped(Effect.gen(function*() {
                const liveCaller = yield* (yield* LiveVolume.open(options)).caller()
                assert.deepStrictEqual(yield* rootNames(liveCaller), ["alpha", "zeta"])
              }))
            }).pipe(Effect.provide(memoryImageStore()))
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should start a restored volume's revisions afresh, however it was restored when a snapshot starts a new volume",
        () =>
          Effect.gen(function*() {
            const volume = yield* Vfs.make()
            const caller = yield* volume.caller()
            yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
            yield* caller.writeFile("/f", new Uint8Array([2]), { access: "write", truncate: true })
            yield* caller.writeFile("/f", new Uint8Array([3]), { access: "write", truncate: true })
            const sourceRevision = (yield* caller.stat("/f")).revision

            const snapshot = yield* volume.snapshot
            const decoded = yield* Vfs.decodeSnapshot(yield* Vfs.encodeSnapshot(snapshot), LIMITS)

            // The revisions of "/" and "/f" on restore, then after the same two mutations.
            const progress = Effect.fnUntraced(function*(restored: Vfs.Volume) {
              const fs = yield* restored.caller()

              const revisions = () =>
                Effect.all([fs.stat("/"), fs.stat("/f")]).pipe(
                  Effect.map((stats) => stats.map((stat) => stat.revision))
                )

              const restoredRevisions = yield* revisions()

              yield* fs.writeFile("/f", new Uint8Array([4]), { access: "write", truncate: true })
              yield* fs.writeFile("/g", new Uint8Array([5]), { access: "write", create: "exclusive" })

              return [restoredRevisions, yield* revisions(), (yield* fs.stat("/g")).revision]
            })

            const fromDecoded = yield* progress(yield* Vfs.fromSnapshot(decoded))
            assert.deepStrictEqual(fromDecoded[0], [1n, 1n])

            for (
              const restored of [
                yield* Vfs.fromSnapshot(snapshot),
                yield* Vfs.makeOverlay(snapshot),
                yield* Vfs.makeOverlay(decoded)
              ]
            ) assert.deepStrictEqual(yield* progress(restored), fromDecoded)

            assert.strictEqual((yield* caller.stat("/f")).revision, sourceRevision)
          })
      )
    })
  })

  describe("snapshot decoding rejects hostile input", () => {
    const sample = Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({
        entries: [
          { kind: "directory", path: "/d" },
          { kind: "file", path: "/d/f", bytes: new Uint8Array([1, 2, 3]) },
          { kind: "hardLink", path: "/alias", target: "/d/f" },
          { kind: "symlink", path: "/s", target: "d/f" }
        ]
      })

      return yield* Vfs.encodeSnapshot(yield* volume.snapshot)
    })

    // Four objects and four names; the names and payloads decode to d, f, alias, s, three bytes and d/f.
    const EXACT = {
      ...LIMITS,
      maxRecords: 4,
      maxEntries: 4,
      maxDecodedBytes: ByteSize.bytes(1 + 1 + 5 + 1 + 3 + 3)
    }

    const failure = (input: Uint8Array, limits: Vfs.DecodeLimits = LIMITS) =>
      Effect.map(Effect.flip(Vfs.decodeSnapshot(input, limits)), (error) => [error.code, error.field] as const)

    // The header line holds the format and the version and nothing else.
    const PREFIX = "{\"format\":\"effect-vfs\",\"version\":1"

    const withPrefix = (input: Uint8Array, prefix: string) => {
      const text = new TextDecoder().decode(input)
      assert.isTrue(text.startsWith(PREFIX))

      return encoder.encode(prefix + text.slice(PREFIX.length))
    }

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should accept exact budgets and reject smaller ones when restoring a snapshot",
        () =>
          Effect.gen(function*() {
            const encoded = yield* sample

            yield* Vfs.decodeSnapshot(encoded, { ...EXACT, maxEncodedBytes: ByteSize.bytes(encoded.length) })

            for (
              const limits of [
                { ...EXACT, maxEncodedBytes: ByteSize.bytes(encoded.length - 1) },
                { ...EXACT, maxRecords: 3 },
                { ...EXACT, maxEntries: 3 },
                { ...EXACT, maxDecodedBytes: ByteSize.bytes(13) }
              ]
            ) assert.strictEqual((yield* failure(encoded, limits))[0], "LimitExceeded")

            assert.deepStrictEqual(
              yield* failure(encoded, { ...EXACT, maxEncodedBytes: ByteSize.bytes(encoded.length - 1) }),
              ["LimitExceeded", "encodedBytes"]
            )
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should refuse input that is not a detached UTF-8 JSON document when input is not detached UTF-8 JSON",
        () =>
          Effect.gen(function*() {
            const encoded = yield* sample
            const shared = new Uint8Array(new SharedArrayBuffer(encoded.length))
            shared.set(encoded)

            assert.strictEqual(
              // @ts-expect-error exercises the runtime guard against a value outside the public Uint8Array contract
              (yield* Effect.flip(Vfs.decodeSnapshot(Array.from(encoded), LIMITS))).code,
              "InvalidEncoding"
            )

            for (
              const input of [
                shared,
                new Uint8Array([255]),
                encoded.subarray(0, encoded.length - 1),
                bytes("{"),
                new Uint8Array([...bytes("{\"format\":\"effect-vfs\",\"version\":1,\"x\":\""), 0xe2, 0x82])
              ]
            ) assert.strictEqual((yield* failure(input))[0], "InvalidEncoding")
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should refuse other formats and versions before reading the document when format or version differs",
        () =>
          Effect.gen(function*() {
            const encoded = yield* sample

            for (const version of ["0", "2", "\"1\"", "null"]) {
              assert.deepStrictEqual(
                yield* failure(withPrefix(encoded, `{"format":"effect-vfs","version":${version}`)),
                ["UnsupportedVersion", "version"]
              )
            }

            for (const value of ["[]", "null", "\"effect-vfs\"", "{\"format\":\"effect-vfs-live\",\"version\":1}"]) {
              assert.strictEqual((yield* failure(bytes(`${value}\n`)))[0], "InvalidStructure")
            }
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should refuse unknown fields on the document when a document has unknown fields",
        () =>
          Effect.gen(function*() {
            const encoded = yield* sample

            assert.deepStrictEqual(
              yield* failure(withPrefix(encoded, `${PREFIX},"extra":true`)),
              ["InvalidStructure", "document"]
            )
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should count every budget before it checks the graph or decodes a name or target when budgets are exceeded before graph decoding",
        () =>
          Effect.gen(function*() {
            // Each tree breaks a budget and a graph rule; the budget is what refuses it.
            const brokenLink = snapshotOf([
              ROOT_NODE,
              { _tag: "directory", ino: 2, parent: 1, name: base64("d"), metadata: METADATA },
              {
                _tag: "file",
                ino: 3,
                links: [{ parent: 9, name: base64("f") }],
                content: { _tag: "Inline", bytes: "AQ==" },
                metadata: METADATA
              }
            ])

            const repeatedName = snapshotOf([
              ROOT_NODE,
              { _tag: "directory", ino: 2, parent: 1, name: base64("a"), metadata: METADATA },
              { _tag: "directory", ino: 3, parent: 1, name: base64("a"), metadata: METADATA }
            ])

            // 300 kB of NUL bytes as a symbolic link's target.
            const nulTarget = snapshotOf([
              ROOT_NODE,
              {
                _tag: "symlink",
                ino: 2,
                links: [{ parent: 1, name: base64("s") }],
                target: "A".repeat(400_000),
                metadata: METADATA
              }
            ])

            assert.deepStrictEqual(yield* failure(brokenLink, { ...LIMITS, maxRecords: 2 }), [
              "LimitExceeded",
              "records"
            ])
            assert.deepStrictEqual(yield* failure(repeatedName, { ...LIMITS, maxEntries: 1 }), [
              "LimitExceeded",
              "entries"
            ])

            assert.deepStrictEqual(
              yield* failure(nulTarget, { ...LIMITS, maxDecodedBytes: ByteSize.bytes(10) }),
              ["LimitExceeded", "bytes"]
            )

            // Within the budgets, the same trees fail the graph rule they break.
            assert.deepStrictEqual(yield* failure(brokenLink), ["InvalidStructure", "nodes.2.links.0.parent"])
            assert.deepStrictEqual(yield* failure(repeatedName), ["InvalidStructure", "nodes.2.name"])
            assert.deepStrictEqual(yield* failure(nulTarget), ["InvalidStructure", "nodes.1.target"])
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should name the directory or symbolic link below the root that breaks a graph rule when a graph rule fails below the root",
        () =>
          Effect.gen(function*() {
            const original = yield* Schema.decodeEffect(SampleTree)(documentText(yield* sample))

            const directory = original.nodes.findIndex((node, index) =>
              index > 0 && Predicate.isTagged(node, "directory")
            )

            const symlink = original.nodes.findIndex(Predicate.isTagged("symlink"))

            const mutations: Array<
              readonly [number, { readonly name?: string; readonly parent?: number; readonly target?: string }, string]
            > = [
              [symlink, { target: base64("a\0b") }, `nodes.${symlink}.target`],
              [directory, { name: base64(".") }, `nodes.${directory}.name`],
              [directory, { name: base64("d/e") }, `nodes.${directory}.name`],
              [directory, { parent: 99 }, `nodes.${directory}.parent`]
            ]

            for (const [index, edit, field] of mutations) {
              const nodes = original.nodes.map((node, at) => (at === index ? { ...node, ...edit } : node))
              assert.deepStrictEqual(yield* failure(toLines({ ...original, nodes })), ["InvalidStructure", field])
            }
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should hold snapshots and fixtures to one name rule, admitting NAME_MAX bytes and no more when a name reaches NAME_MAX",
        () =>
          Effect.gen(function*() {
            const file = (name: string) =>
              snapshotOf([
                ROOT_NODE,
                {
                  _tag: "file",
                  ino: 2,
                  links: [{ parent: 1, name: base64(name) }],
                  content: { _tag: "Inline", bytes: "AQ==" },
                  metadata: METADATA
                }
              ])

            const longest = "a".repeat(NAME_MAX)
            const restored = yield* Vfs.fromSnapshot(yield* Vfs.decodeSnapshot(file(longest), LIMITS))
            assert.deepStrictEqual(yield* rootNames(yield* restored.caller()), [longest])
            assert.deepStrictEqual(yield* failure(file(`${longest}a`)), ["InvalidStructure", "nodes.1.links.0.name"])

            const fixture = (name: string) =>
              Vfs.fromFixture({ entries: [{ kind: "file", path: `/${name}`, bytes: new Uint8Array([1]) }] })

            assert.deepStrictEqual(yield* rootNames(yield* (yield* fixture(longest)).caller()), [longest])

            const refused = yield* Effect.flip(fixture(`${longest}a`))
            assert.deepStrictEqual([refused.code, refused.field], ["InvalidStructure", "path"])
          })
      )
    })
  })

  describe("restored inode numbers", () => {
    // A root holding a directory `d` and a file `d/f`, at the inode numbers given.
    const tree = (directory: number, file: number) =>
      toLines({
        format: "effect-vfs",
        version: 1,
        nodes: [
          { _tag: "directory", ino: 1, parent: 1, name: "", metadata: METADATA },
          { _tag: "directory", ino: directory, parent: 1, name: "ZA==", metadata: METADATA },
          {
            _tag: "file",
            ino: file,
            links: [{ parent: directory, name: "Zg==" }],
            content: { _tag: "Inline", bytes: "AQ==" },
            metadata: METADATA
          }
        ].sort((a, b) => a.ino - b.ino)
      })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should restore high inode numbers and allocate above them when a tree exceeds initial table levels",
        () =>
          Effect.gen(function*() {
            // 2^35 and beyond need a table deep enough that its indexing can no longer use 32-bit shifts.
            for (
              const [directory, file] of [[2 ** 35, 2 ** 35 + 33], [2 ** 40 + 7, 3], [2 ** 52, 2 ** 52 + 1]] as const
            ) {
              const encoded = tree(directory, file)
              const snapshot = yield* Vfs.decodeSnapshot(encoded, LIMITS)
              assert.deepStrictEqual(yield* Vfs.encodeSnapshot(snapshot), encoded)

              for (const restored of [yield* Vfs.fromSnapshot(snapshot), yield* Vfs.makeOverlay(snapshot)]) {
                const fs = yield* restored.caller()
                assert.deepStrictEqual(yield* fs.readFile("/d/f"), new Uint8Array([1]))
                assert.strictEqual((yield* fs.stat("/d")).ino, BigInt(directory))
                assert.strictEqual((yield* fs.stat("/d/f")).ino, BigInt(file))

                const created = yield* fs.mkdir("/d/new")
                assert.strictEqual((yield* fs.stat(created.reference)).ino, BigInt(Math.max(directory, file) + 1))
                yield* fs.rename("/d/f", "/d/new/f")
                assert.deepStrictEqual(yield* fs.readFile("/d/new/f"), new Uint8Array([1]))
              }
            }
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should restore the largest inode a tree holds and then reports that none is left when the largest supported inode is restored",
        () =>
          Effect.gen(function*() {
            const snapshot = yield* Vfs.decodeSnapshot(tree(2, Number.MAX_SAFE_INTEGER - 1), LIMITS)
            const fs = yield* (yield* Vfs.fromSnapshot(snapshot)).caller()

            assert.strictEqual((yield* fs.stat("/d/f")).ino, BigInt(Number.MAX_SAFE_INTEGER - 1))
            assert.strictEqual((yield* Effect.flip(fs.mkdir("/d/new"))).code, "NoSpace")
            yield* fs.unlink("/d/f")
            assert.strictEqual((yield* Effect.flip(fs.stat("/d/f"))).code, "NotFound")

            assert.deepStrictEqual(
              yield* Effect.map(
                Effect.flip(Vfs.decodeSnapshot(tree(2, Number.MAX_SAFE_INTEGER), LIMITS)),
                (error) => [error.code, error.field]
              ),
              ["InvalidStructure", "document"]
            )
          })
      )
    })

    it.layer(BunCrypto.layer)((it) => {
      it.effect(
        "should refuse directories whose parents form a cycle nothing reaches when parent links form an unreachable cycle",
        () =>
          Effect.gen(function*() {
            const cycle = toLines({
              format: "effect-vfs",
              version: 1,
              nodes: [
                { _tag: "directory", ino: 1, parent: 1, name: "", metadata: METADATA },
                { _tag: "directory", ino: 2, parent: 3, name: "YQ==", metadata: METADATA },
                { _tag: "directory", ino: 3, parent: 2, name: "Yg==", metadata: METADATA }
              ]
            })

            const error = yield* Effect.flip(Vfs.decodeSnapshot(cycle, LIMITS))
            assert.deepStrictEqual([error.code, error.field], ["InvalidStructure", "nodes.1.parent"])
          })
      )
    })
  })
}
