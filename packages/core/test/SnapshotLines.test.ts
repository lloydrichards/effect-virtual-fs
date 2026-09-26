import { assert, describe, it } from "@effect/vitest"
import { ByteSize, Effect, Schema, Stream } from "effect"
import { VirtualFileSystem as Vfs } from "../src/index.js"
import * as LiveImage from "../src/internal/liveImage.js"
import { ENCODED_CHUNK_BYTES } from "../src/internal/tree.js"
import { prepareEmptyLiveImage } from "../src/internal/virtualFileSystem.js"
import { readLines, toLines } from "./support/lines.js"

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

// Vitest runs on Node, whose modules core's platform-free types do not describe, so they are loaded by a name typed as
// a plain string and given the few members used here.
const NODE_V8: string = "node:v8"
const NODE_VM: string = "node:vm"
const NODE_PROCESS: string = "node:process"

interface Usage {
  readonly memoryUsage: () => { readonly heapUsed: number; readonly external: number }
}

// A forced collection, and the bytes the heap and its array buffers hold.
const nodeHeap = Effect.gen(function*() {
  const v8: { readonly setFlagsFromString: (flags: string) => void } = yield* Effect.promise(() => import(NODE_V8))

  const vm: { readonly runInNewContext: (code: string) => () => void } = yield* Effect.promise(() => import(NODE_VM))

  const process: Usage = yield* Effect.promise(() => import(NODE_PROCESS))

  v8.setFlagsFromString("--expose-gc")
  const gc = vm.runInNewContext("gc")

  return {
    gc,
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
  it.effect("encodes a header line and then one line per node, every line ending in a newline", () =>
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
    }))

  it.effect("streams the same bytes it collects, and decodes them from chunks of any size", () =>
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
    }))

  it.effect("streams chunks of at most 128 lines and the chunk byte cap, a line past the cap in a chunk of its own", () =>
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
    }))

  it.effect("keeps the start of an unfinished line when the producer reuses its read buffer", () =>
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
    }))

  it.effect(
    "holds an unfinished line in memory proportional to its bytes however finely it is chunked",
    () =>
      Effect.gen(function*() {
        const { gc, memory } = yield* nodeHeap
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

  it.effect("refuses a line past maxLineBytes before reading the rest of the input", () =>
    Effect.gen(function*() {
      const bounded = { ...LIMITS, maxLineBytes: ByteSize.bytes(FILE.length) }

      yield* Stream.run(Stream.succeed(VALID), Vfs.decodeSnapshotSink(bounded))
      const tighter = { ...LIMITS, maxLineBytes: ByteSize.bytes(FILE.length - 1) }
      assert.deepStrictEqual(yield* failure(VALID, tighter), ["LimitExceeded", "lineBytes"])

      // A line that never ends is refused once it outgrows the bound, one byte at a time.
      const endless = encoder.encode(`${HEADER}\n${ROOT}\n${FILE}`)
      const bytes = [...endless].map((byte) => new Uint8Array([byte]))
      assert.deepStrictEqual(yield* sinkFailure(thenDie(...bytes), tighter), ["LimitExceeded", "lineBytes"])
    }))

  it.effect("refuses a line that breaks a budget or a rule before reading the next line, in its chunk or the next", () =>
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
    }))

  it.effect("requires every line to end in a newline and refuses carriage returns and empty lines", () =>
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
    }))

  it.effect("decodes UTF-8 split across chunks whole and refuses malformed UTF-8 and a byte-order mark", () =>
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
          yield* sinkFailure(Stream.make(malformed.subarray(0, at), malformed.subarray(at), encoder.encode(":1}\n"))),
          ["InvalidEncoding", "text"]
        )
      }

      // A sequence the input cuts short is refused rather than dropped.
      assert.deepStrictEqual(yield* failure(new Uint8Array([...VALID, 0xe2, 0x82])), ["InvalidEncoding", "text"])
      assert.deepStrictEqual(yield* failure(new Uint8Array([0xef, 0xbb, 0xbf, ...VALID])), ["InvalidEncoding", "text"])
    }))

  it.effect("requires the header first and exactly once", () =>
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
    }))

  it.effect("checks the rules that span nodes once the last line is read", () =>
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
    }))

  it.effect("encodes under limits exactly what decoding under the same limits accepts", () =>
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
        assert.deepStrictEqual(yield* sinkFailure(Stream.fromIterable(bytewise), limits), ["LimitExceeded", field])
      }

      const invalid = yield* Effect.flip(Vfs.encodeSnapshot(snapshot, { ...exact, maxRecords: -1 }))
      assert.deepStrictEqual([invalid.code, invalid.field], ["InvalidArgument", "maxRecords"])
    }))

  it.effect("reads a live image's runtime block from its first line", () =>
    Effect.gen(function*() {
      const image = yield* prepareEmptyLiveImage()
      const [header, ...nodes] = readLines(image)

      assert.deepStrictEqual(Object.keys(Object(header)), ["format", "version", "runtime"])
      assert.strictEqual(nodes.length, 1)
      assert.strictEqual(image.at(-1), 10)

      const failed = yield* Effect.flip(LiveImage.decode(image.subarray(0, image.length - 1), ByteSize.kilobytes(64)))
      assert.deepStrictEqual([failed.code, failed.field], ["InvalidEncoding", "liveImage"])
    }))
})
