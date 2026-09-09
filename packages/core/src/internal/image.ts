import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

const SnapshotId = Symbol("@effect-vfs/core/Snapshot")
export interface Snapshot {
  readonly [SnapshotId]: true
}
export class ImageError extends Data.TaggedError("ImageError")<{
  readonly code: "InvalidEncoding" | "UnsupportedVersion" | "InvalidStructure" | "LimitExceeded"
  readonly field?: string
}> {}
const natural = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)
export const DecodeLimits = Schema.Struct({
  maxEncodedBytes: natural,
  maxRecords: natural,
  maxEntries: natural,
  maxDecodedBytes: natural
})
export type DecodeLimits = typeof DecodeLimits.Type
const integer = Schema.String.check(Schema.isPattern(/^(?:0|-?[1-9][0-9]{0,127})(?![\s\S])/))
export const StoredMetadata = Schema.Struct({
  uid: natural,
  gid: natural,
  mode: natural.check(Schema.isLessThanOrEqualTo(0o7777)),
  atimeNs: integer,
  mtimeNs: integer,
  ctimeNs: integer,
  birthtimeNs: integer
})
export type StoredMetadata = typeof StoredMetadata.Type
const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
export const Record = Schema.Union([
  Schema.Struct({
    id,
    kind: Schema.Literal("directory"),
    metadata: StoredMetadata,
    entries: Schema.Array(Schema.Struct({ name: Schema.String, target: id }))
  }),
  Schema.Struct({ id, kind: Schema.Literal("file"), metadata: StoredMetadata, data: Schema.String }),
  Schema.Struct({ id, kind: Schema.Literal("symlink"), metadata: StoredMetadata, target: Schema.String })
])
export type Record = typeof Record.Type
export const Document = Schema.Struct({
  format: Schema.Literal("effect-vfs"),
  version: Schema.Literal(1),
  root: id,
  records: Schema.Array(Record)
})
export type Document = typeof Document.Type
const snapshots = new WeakMap<Snapshot, Document>()
const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?(?![\s\S])/
export const decodedLength = (value: string): number =>
  value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)
export const base64 = (input: Uint8Array): string => {
  // Effect's encoder concatenates individual characters. Join bounded chunks so snapshots
  // retain flat strings instead of those intermediate string chains. A multiple of three
  // keeps padding in the final chunk only, preserving canonical base64.
  const chunkBytes = 12_288
  const chunks: Array<string> = []
  for (let offset = 0; offset < input.length; offset += chunkBytes) {
    chunks.push(Encoding.encodeBase64(input.subarray(offset, offset + chunkBytes)))
  }
  return chunks.join("")
}
const error = (code: ImageError["code"], field?: string) =>
  new ImageError({ code, ...(field === undefined ? {} : { field }) })
export const bytes = (value: string): Uint8Array => {
  const result = Encoding.decodeBase64(value)
  if (Result.isFailure(result)) throw new Error("Invalid trusted snapshot base64")
  return result.success
}
export const inspect = (snapshot: Snapshot): Effect.Effect<Document, ImageError> =>
  Effect.suspend(() => {
    const document = snapshots.get(snapshot)
    return document === undefined ? Effect.fail(error("InvalidStructure", "snapshot")) : Effect.succeed(document)
  })

export const capture = Effect.fnUntraced(function*(input: unknown, limits?: DecodeLimits) {
  const decoded = Schema.decodeUnknownResult(Document, { onExcessProperty: "error" })(input)
  if (Result.isFailure(decoded)) return yield* error("InvalidStructure")
  const document = decoded.success
  const records = new Map<string, Record>()
  let entries = 0
  let payload = 0
  if (limits !== undefined && document.records.length > limits.maxRecords) {
    return yield* error("LimitExceeded", "records")
  }
  for (const record of document.records) {
    if (records.has(record.id)) return yield* error("InvalidStructure", "id")
    records.set(record.id, record)
    if (record.kind === "directory") entries += record.entries.length
  }
  if (limits !== undefined && entries > limits.maxEntries) return yield* error("LimitExceeded", "entries")
  // Count every payload before allocating any decoded payload buffer.
  for (const record of document.records) {
    const values = record.kind === "directory"
      ? record.entries.map((entry) => entry.name)
      : [record.kind === "file" ? record.data : record.target]
    for (const value of values) {
      if (!canonicalBase64.test(value)) return yield* error("InvalidEncoding", record.id)
      payload += decodedLength(value)
      if (!Number.isSafeInteger(payload) || (limits !== undefined && payload > limits.maxDecodedBytes)) {
        return yield* error("LimitExceeded", "bytes")
      }
    }
  }
  const root = records.get(document.root)
  if (root?.kind !== "directory") return yield* error("InvalidStructure", "root")
  const parents = new Map<string, number>()
  for (const record of document.records) {
    if (record.kind === "directory") {
      const names = new Set<string>()
      for (const entry of record.entries) {
        if (names.has(entry.name) || decodedLength(entry.name) < 1 || decodedLength(entry.name) > 255) {
          return yield* error("InvalidStructure", "name")
        }
        names.add(entry.name)
        const name = bytes(entry.name)
        if (
          name.includes(0) || name.includes(47) || (name.length === 1 && name[0] === 46) ||
          (name.length === 2 && name[0] === 46 && name[1] === 46)
        ) return yield* error("InvalidStructure", "name")
        const target = records.get(entry.target)
        if (target === undefined) return yield* error("InvalidStructure", "target")
        parents.set(target.id, (parents.get(target.id) ?? 0) + 1)
      }
    } else if (record.kind === "symlink" && bytes(record.target).includes(0)) {
      return yield* error("InvalidStructure", "symlink")
    }
  }
  if (parents.has(root.id)) return yield* error("InvalidStructure", "root")
  for (const record of document.records) {
    if (record !== root && (record.kind === "directory" ? parents.get(record.id) !== 1 : !parents.has(record.id))) {
      return yield* error("InvalidStructure", "parent")
    }
  }
  const visited = new Set<string>()
  const pending = [root.id]
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined || visited.has(next)) continue
    visited.add(next)
    const record = records.get(next)
    if (record?.kind === "directory") { for (const entry of record.entries) pending.push(entry.target) }
  }
  if (visited.size !== records.size) return yield* error("InvalidStructure", "reachability")
  const snapshot: Snapshot = Object.freeze({ [SnapshotId]: true as const })
  snapshots.set(snapshot, document)
  return snapshot
})

export const encodeSnapshot = Effect.fn("VirtualFileSystem.encodeSnapshot")(function*(snapshot: Snapshot) {
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* inspect(snapshot)).pipe(
    Effect.mapError(() => error("InvalidStructure"))
  )
  return new TextEncoder().encode(text)
})
export const decodeSnapshot = Effect.fn("VirtualFileSystem.decodeSnapshot")(
  function*(input: Uint8Array, limits: DecodeLimits) {
    const checked = Schema.decodeResult(DecodeLimits, { onExcessProperty: "error" })(limits)
    if (Result.isFailure(checked)) return yield* error("InvalidStructure", "limits")
    if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) return yield* error("InvalidEncoding")
    if (input.byteLength > checked.success.maxEncodedBytes) return yield* error("LimitExceeded", "encodedBytes")
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(input)),
      catch: () => error("InvalidEncoding")
    })
    const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
      Effect.mapError(() => error("InvalidEncoding"))
    )
    if (
      typeof value === "object" && value !== null && "format" in value && value.format === "effect-vfs" &&
      "version" in value && value.version !== 1
    ) return yield* error("UnsupportedVersion")
    return yield* capture(value, checked.success)
  }
)
