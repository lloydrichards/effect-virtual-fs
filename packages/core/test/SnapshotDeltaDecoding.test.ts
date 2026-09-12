import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as ByteSize from "effect/ByteSize"
import { VirtualFileSystem as Vfs } from "../src/index.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface StoredRecord {
  readonly kind: string
  readonly paths: ReadonlyArray<string>
  payload?: { _tag: string; bytes?: string; path?: string }
}

interface StoredDocument {
  readonly base: { readonly digest: string }
  readonly version: number
  readonly records: ReadonlyArray<StoredRecord>
  readonly changes: ReadonlyArray<Record<string, unknown>>
}

const snapshots = Effect.gen(function*() {
  const volume = yield* Vfs.make()
  const caller = yield* volume.caller()
  const base = yield* volume.snapshot
  yield* caller.writeFile("/f", new Uint8Array([1, 2, 3]), { access: "write", create: "ifMissing" })
  const target = yield* volume.snapshot
  return { base, target }
})

const encodedDelta = Effect.gen(function*() {
  const pair = yield* snapshots
  const delta = yield* Vfs.diffSnapshots(pair.base, pair.target)
  const encoded = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)
  return { ...pair, encoded }
})

const document = (input: Uint8Array): StoredDocument => JSON.parse(decoder.decode(input)) as StoredDocument
const encodeDocument = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value))
const customLimits = (overrides: Partial<Vfs.SnapshotDeltaLimits>): Vfs.SnapshotDeltaLimits => ({
  ...Vfs.SnapshotDeltaLimits.default,
  ...overrides
})
const reject = (input: Uint8Array, limits = Vfs.SnapshotDeltaLimits.default) =>
  Effect.flip(Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes(limits))(input))

describe("snapshot delta Schema codec", () => {
  it.effect("round trips through the public Schema and owns decoded input and encoded output", () =>
    Effect.gen(function*() {
      const { base, encoded } = yield* encodedDelta
      const input = new Uint8Array(encoded)
      const delta = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(input)
      input.fill(0)

      const first = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)
      const expected = new Uint8Array(first)
      first.fill(0)
      const second = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)

      assert.deepStrictEqual(second, expected)
      const restored = yield* Vfs.applySnapshotDelta(base, delta)
      const caller = yield* (yield* Vfs.fromSnapshot(restored)).caller()
      assert.deepStrictEqual(yield* caller.readFile("/f"), new Uint8Array([1, 2, 3]))
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("rejects malformed UTF-8, JSON, unknown fields, and unsupported versions", () =>
    Effect.gen(function*() {
      const { encoded } = yield* encodedDelta
      const source = document(encoded)
      const cases = [
        new Uint8Array([0xc3, 0x28]),
        encoder.encode("{"),
        encodeDocument({ ...source, unexpected: true }),
        encodeDocument({ ...source, base: { ...source.base, unexpected: true } }),
        encodeDocument({ ...source, version: 2 })
      ]
      for (const input of cases) assert.isDefined(yield* reject(input))
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("rejects noncanonical base64, invalid digests, paths, and payloads", () =>
    Effect.gen(function*() {
      const { encoded } = yield* encodedDelta
      const source = document(encoded)
      const cases = [
        { ...source, base: { ...source.base, digest: "A" } },
        { ...source, base: { ...source.base, digest: `${source.base.digest.slice(0, -2)}h==` } },
        { ...source, records: [{ ...source.records[0], paths: ["Lg=="] }, ...source.records.slice(1)] },
        { ...source, records: [source.records[0], { ...source.records[1], paths: ["Zg=="] }] },
        { ...source, records: [source.records[0], { ...source.records[1], payload: { _tag: "Inline", bytes: "AQI" } }] }
      ]
      for (const value of cases) assert.isDefined(yield* reject(encodeDocument(value)))
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("rejects unordered, duplicate, and semantically inconsistent summaries", () =>
    Effect.gen(function*() {
      const { base, encoded } = yield* encodedDelta
      const source = document(encoded)
      const added = source.changes[0]
      assert.isDefined(yield* reject(encodeDocument({ ...source, changes: [added, added] })))
      assert.isDefined(
        yield* reject(encodeDocument({
          ...source,
          changes: [
            { _tag: "Added", path: "L3o=", kind: "file" },
            { _tag: "Added", path: "L2E=", kind: "file" }
          ]
        }))
      )

      const inconsistent = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(
        encodeDocument({ ...source, changes: [] })
      )
      const inspectionError = yield* Effect.flip(Vfs.inspectSnapshotDelta(base, inconsistent))
      assert.instanceOf(inspectionError, Vfs.ImageError)
      assert.strictEqual(inspectionError.code, "InvalidStructure")
      assert.strictEqual(inspectionError.field, "changes")
      const error = yield* Effect.flip(Vfs.applySnapshotDelta(base, inconsistent))
      assert.instanceOf(error, Vfs.ImageError)
      assert.strictEqual(error.code, "InvalidStructure")
      assert.strictEqual(error.field, "changes")
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("accepts a semantically identical summary with reordered object keys", () =>
    Effect.gen(function*() {
      const { base, encoded } = yield* encodedDelta
      const source = document(encoded)
      const change = source.changes[0]!
      const reordered = Object.fromEntries(Object.entries(change).reverse())
      const delta = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(
        encodeDocument({ ...source, changes: [reordered] })
      )

      yield* Vfs.applySnapshotDelta(base, delta)
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("accepts exact codec boundaries and rejects the next smaller budget", () =>
    Effect.gen(function*() {
      const { encoded } = yield* encodedDelta
      const source = document(encoded)
      const decodedBytes = 32 + 1 + 2 + 3 + 2
      const boundaries: ReadonlyArray<readonly [Vfs.SnapshotDeltaLimits, Vfs.SnapshotDeltaLimits]> = [
        [
          customLimits({ maxEncodedBytes: ByteSize.bytes(encoded.length) }),
          customLimits({ maxEncodedBytes: ByteSize.bytes(encoded.length - 1) })
        ],
        [
          customLimits({ maxDeltaRecords: source.records.length + source.changes.length }),
          customLimits({ maxDeltaRecords: source.records.length + source.changes.length - 1 })
        ],
        [
          customLimits({ maxDecodedDeltaBytes: ByteSize.bytes(decodedBytes) }),
          customLimits({ maxDecodedDeltaBytes: ByteSize.bytes(decodedBytes - 1) })
        ],
        [customLimits({ maxEntries: 1 }), customLimits({ maxEntries: 0 })],
        [
          customLimits({ maxOutputRecords: source.records.length }),
          customLimits({ maxOutputRecords: source.records.length - 1 })
        ],
        [customLimits({ maxOutputBytes: ByteSize.bytes(3) }), customLimits({ maxOutputBytes: ByteSize.bytes(2) })]
      ]

      for (const [accepted, rejected] of boundaries) {
        assert.isDefined(
          yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes(accepted))(encoded)
        )
        assert.isDefined(yield* reject(encoded, rejected))
      }
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("preserves byte limits above Number.MAX_SAFE_INTEGER without narrowing", () =>
    Effect.gen(function*() {
      const { base, target } = yield* snapshots
      const exactLimit = ByteSize.bytes(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
      const limits = customLimits({
        maxEncodedBytes: exactLimit,
        maxIdentityBytes: exactLimit,
        maxDecodedDeltaBytes: exactLimit,
        maxOutputBytes: exactLimit
      })
      const delta = yield* Vfs.diffSnapshots(base, target, limits)
      const codec = Vfs.SnapshotDeltaFromBytes(limits)
      const encoded = yield* Schema.encodeEffect(codec)(delta)
      const decoded = yield* Schema.decodeEffect(codec)(encoded)
      const restored = yield* Vfs.applySnapshotDelta(base, decoded, limits)
      const caller = yield* (yield* Vfs.fromSnapshot(restored)).caller()
      assert.deepStrictEqual(yield* caller.readFile("/f"), new Uint8Array([1, 2, 3]))
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("enforces inherited-record limits and rejects an unresolved base reference on apply", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "ifMissing" })
      const base = yield* volume.snapshot
      const delta = yield* Vfs.diffSnapshots(base, base)
      const encoded = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)

      assert.isDefined(
        yield* Schema.decodeEffect(
          Vfs.SnapshotDeltaFromBytes(customLimits({ maxInheritedRecords: 1 }))
        )(encoded)
      )
      assert.isDefined(yield* reject(encoded, customLimits({ maxInheritedRecords: 0 })))

      for (
        const [limits, field] of [
          [customLimits({ maxInheritedRecords: 0 }), "inheritedRecords"],
          [customLimits({ maxDeltaRecords: 0 }), "deltaRecords"],
          [customLimits({ maxIdentityBytes: ByteSize.zero }), "identityBytes"]
        ] as const
      ) {
        const error = yield* Effect.flip(Vfs.applySnapshotDelta(base, delta, limits))
        assert.instanceOf(error, Vfs.ImageError)
        assert.strictEqual(error.code, "LimitExceeded")
        assert.strictEqual(error.field, field)
      }

      const fresh = yield* encodedDelta
      const source = document(fresh.encoded)
      const file = source.records.find((record) => record.kind === "file")
      assert.isDefined(file)
      assert.isDefined(file.payload)
      const ownPath = file.paths[0]
      assert.isDefined(ownPath)
      file.payload = { _tag: "Base", path: ownPath }
      const hostile = yield* Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(encodeDocument(source))
      const error = yield* Effect.flip(Vfs.applySnapshotDelta(fresh.base, hostile))
      assert.instanceOf(error, Vfs.ImageError)
      assert.strictEqual(error.code, "InvalidStructure")
      assert.strictEqual(error.field, "baseReference")
    }).pipe(Effect.provide(BunCrypto.layer)))

  it.effect("rejects an inherited payload redirected to another base path", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.fromFixture({
        entries: [
          { kind: "file", path: "/a", bytes: new Uint8Array([1]) },
          { kind: "file", path: "/b", bytes: new Uint8Array([2]) }
        ]
      })
      const base = yield* volume.snapshot
      const delta = yield* Vfs.diffSnapshots(base, base)
      const encoded = yield* Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)
      const source = document(encoded)
      const a = source.records.find((record) => record.paths.includes("L2E="))
      assert.isDefined(a)
      assert.isDefined(a.payload)
      a.payload.path = "L2I="

      const error = yield* reject(encodeDocument(source))
      assert.instanceOf(error, Schema.SchemaError)
    }).pipe(Effect.provide(BunCrypto.layer)))
})
