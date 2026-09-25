// Snapshot validation and serialization used by VirtualFileSystem.
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { DecodeLimits, type Snapshot, SnapshotTypeId } from "../Snapshot.js"
import type { ImageFailure } from "../VfsError.js"
import { decodeUtf8 } from "./bytes.js"
import { CanonicalBase64 } from "./canonicalBase64.js"
import { decodeConfiguration, imageFailure } from "./errors.js"
import { StoredMetadata, WireStoredMetadata } from "./metadata.js"

class SnapshotImpl implements Snapshot {
  readonly [SnapshotTypeId]: SnapshotTypeId = SnapshotTypeId
}

/** @internal */
export { StoredMetadata }

const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

/** @internal */
export const Record = Schema.TaggedUnion({
  directory: {
    id,
    metadata: StoredMetadata,
    entries: Schema.Array(Schema.Struct({ name: CanonicalBase64.Encoded, target: id }))
  },
  file: { id, metadata: StoredMetadata, data: CanonicalBase64.Encoded },
  symlink: { id, metadata: StoredMetadata, target: CanonicalBase64.Encoded }
})

/** @internal */
export type Record = typeof Record.Type

/** @internal */
export const Document = Schema.Struct({
  format: Schema.Literal("effect-vfs"),
  version: Schema.Literal(1),
  root: id,
  records: Schema.Array(Record)
})

const WireRecord = Schema.TaggedUnion({
  directory: {
    id,
    metadata: WireStoredMetadata,
    entries: Schema.Array(Schema.Struct({ name: Schema.String, target: id }))
  },
  file: { id, metadata: WireStoredMetadata, data: Schema.String },
  symlink: { id, metadata: WireStoredMetadata, target: Schema.String }
})

const WireDocument = Schema.Struct({
  format: Schema.Literal("effect-vfs"),
  version: Schema.Literal(1),
  root: id,
  records: Schema.Array(WireRecord)
})

const VersionProbe = Schema.Struct({
  format: Schema.Literal("effect-vfs"),
  version: Schema.Unknown
})

/** @internal */
export type Document = typeof Document.Type

const snapshots = new WeakMap<Snapshot, Document>()

/** @internal */
export const inspect = (snapshot: Snapshot): Effect.Effect<Document, ImageFailure> =>
  Effect.suspend(() => {
    const document = snapshots.get(snapshot)

    return document === undefined
      ? imageFailure("decodeSnapshot", "InvalidStructure", { field: "snapshot" })
      : Effect.succeed(document)
  })

/** @internal */
export const capture = Effect.fnUntraced(function*(
  input: typeof Schema.Unknown.Type,
  limits?: DecodeLimits,
  trusted = false
) {
  if (!trusted) {
    yield* Schema.decodeUnknownEffect(WireDocument, { onExcessProperty: "error" })(input).pipe(
      Effect.mapError((cause) => imageFailure("decodeSnapshot", "InvalidStructure", { field: "document", cause }))
    )
  }

  // SAFETY: a trusted caller passes a Document it built; an untrusted one is decoded here.
  const document = trusted ? input as Document : yield* Schema.decodeUnknownEffect(
    Document,
    { onExcessProperty: "error" }
  )(input).pipe(
    Effect.mapError((cause) => imageFailure("decodeSnapshot", "InvalidEncoding", { field: "document", cause }))
  )

  const records = new Map<string, Record>()
  let entries = 0
  let payload = ByteSize.zero

  if (limits !== undefined && document.records.length > limits.maxRecords) {
    return yield* imageFailure("decodeSnapshot", "LimitExceeded", { field: "records" })
  }

  for (const record of document.records) {
    if (records.has(record.id)) return yield* imageFailure("decodeSnapshot", "InvalidStructure", { field: "id" })
    records.set(record.id, record)

    Match.value(record).pipe(
      Match.tag("directory", (record) => {
        entries += record.entries.length
      }),
      Match.undefined
    )
  }

  if (limits !== undefined && entries > limits.maxEntries) {
    return yield* imageFailure("decodeSnapshot", "LimitExceeded", { field: "entries" })
  }

  // Count every payload before allocating any decoded payload buffer. Trusted records carry
  // base64 this module produced, so the scan only runs when a limit depends on the tally.
  if (!trusted || limits !== undefined) {
    for (const record of document.records) {
      const values = Match.value(record).pipe(
        Match.tag("directory", (record) => record.entries.map((entry) => entry.name)),
        Match.tag("file", (record) => [record.data]),
        Match.tag("symlink", (record) => [record.target]),
        Match.exhaustive
      )

      for (const value of values) {
        if (!CanonicalBase64.is(value)) {
          return yield* imageFailure("decodeSnapshot", "InvalidEncoding", { field: record.id })
        }

        payload = ByteSize.sum(payload, ByteSize.bytes(CanonicalBase64.decodedLength(value)))

        if (limits !== undefined && ByteSize.isGreaterThan(payload, limits.maxDecodedBytes)) {
          return yield* imageFailure("decodeSnapshot", "LimitExceeded", { field: "bytes" })
        }
      }
    }
  }

  const root = records.get(document.root)

  if (root === undefined || !Record.guards.directory(root)) {
    return yield* imageFailure("decodeSnapshot", "InvalidStructure", { field: "root" })
  }

  const parents = new Map<string, number>()

  for (const record of document.records) {
    if (Record.guards.directory(record)) {
      const names = new Set<string>()

      for (const entry of record.entries) {
        if (
          names.has(entry.name) || CanonicalBase64.decodedLength(entry.name) < 1 ||
          CanonicalBase64.decodedLength(entry.name) > 255
        ) return yield* imageFailure("decodeSnapshot", "InvalidStructure", { field: "name" })

        names.add(entry.name)
        const name = yield* CanonicalBase64.decode(entry.name)

        if (
          name.includes(0) || name.includes(47) || (name.length === 1 && name[0] === 46) ||
          (name.length === 2 && name[0] === 46 && name[1] === 46)
        ) return yield* imageFailure("decodeSnapshot", "InvalidStructure", { field: "name" })
        const target = records.get(entry.target)

        if (target === undefined) return yield* imageFailure("decodeSnapshot", "InvalidStructure", { field: "target" })
        parents.set(target.id, (parents.get(target.id) ?? 0) + 1)
      }
    } else if (Record.guards.symlink(record) && (yield* CanonicalBase64.decode(record.target)).includes(0)) {
      return yield* imageFailure("decodeSnapshot", "InvalidStructure", { field: "symlink" })
    }
  }

  if (parents.has(root.id)) return yield* imageFailure("decodeSnapshot", "InvalidStructure", { field: "root" })

  for (const record of document.records) {
    const invalidParent = Match.value(record).pipe(
      Match.tag("directory", (record) => parents.get(record.id) !== 1),
      Match.tag("file", (record) => !parents.has(record.id)),
      Match.tag("symlink", (record) => !parents.has(record.id)),
      Match.exhaustive
    )

    if (record !== root && invalidParent) {
      return yield* imageFailure("decodeSnapshot", "InvalidStructure", { field: "parent" })
    }
  }

  const visited = new Set<string>()
  const pending = [root.id]

  while (pending.length > 0) {
    const next = pending.pop()

    if (next === undefined || visited.has(next)) continue
    visited.add(next)
    const record = records.get(next)

    if (record !== undefined) {
      Match.value(record).pipe(
        Match.tag("directory", (record) => {
          for (const entry of record.entries) pending.push(entry.target)
        }),
        Match.tag("file", () => undefined),
        Match.tag("symlink", () => undefined),
        Match.exhaustive
      )
    }
  }

  if (visited.size !== records.size) {
    return yield* imageFailure("decodeSnapshot", "InvalidStructure", { field: "reachability" })
  }

  const snapshot: Snapshot = Object.freeze(new SnapshotImpl())
  snapshots.set(snapshot, document)

  return snapshot
})

/** @internal */
export const encodeSnapshot = Effect.fn("VirtualFileSystem.encodeSnapshot")(function*(snapshot: Snapshot) {
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(Document))(yield* inspect(snapshot)).pipe(
    Effect.mapError((cause) => imageFailure("decodeSnapshot", "InvalidStructure", { field: "text", cause }))
  )

  return new TextEncoder().encode(text)
})

/** @internal */
export const decodeSnapshot = Effect.fn("VirtualFileSystem.decodeSnapshot")(
  function*(input: Uint8Array, limits: DecodeLimits) {
    const checked = yield* Effect.fromResult(decodeConfiguration(DecodeLimits, limits, "decodeSnapshot"))

    if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) {
      return yield* imageFailure("decodeSnapshot", "InvalidEncoding", { field: "input" })
    }

    if (ByteSize.isGreaterThan(ByteSize.bytes(input.byteLength), checked.maxEncodedBytes)) {
      return yield* imageFailure("decodeSnapshot", "LimitExceeded", { field: "encodedBytes" })
    }

    const text = yield* decodeUtf8(
      input,
      (cause) => imageFailure("decodeSnapshot", "InvalidEncoding", { field: "text", cause })
    )

    const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
      Effect.mapError((cause) => imageFailure("decodeSnapshot", "InvalidEncoding", { field: "text", cause }))
    )

    const version = Schema.decodeUnknownResult(VersionProbe)(value)

    if (Result.isSuccess(version) && version.success.version !== 1) {
      return yield* imageFailure("decodeSnapshot", "UnsupportedVersion", { field: "version" })
    }

    return yield* capture(value, checked)
  }
)
