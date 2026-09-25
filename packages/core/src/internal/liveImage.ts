// Private, versioned image for a live volume. Unlike a public snapshot, this
// retains inode numbers, revisions, allocator state, and open unlinked files.
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { decodeUtf8 } from "./bytes.js"
import { CanonicalBase64 } from "./canonicalBase64.js"
import { imageFailure } from "./errors.js"
import { StoredMetadata } from "./metadata.js"

const NaturalBigInt = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,127})$/)).pipe(
  Schema.decodeTo(Schema.BigInt, SchemaTransformation.bigintFromString)
)

const Common = {
  ino: NaturalBigInt,
  revision: NaturalBigInt,
  lineage: Schema.optionalKey(Schema.String),
  metadata: Schema.Struct({
    ...StoredMetadata.fields,
    nlink: Schema.Natural,
    size: NaturalBigInt
  })
}

/** @internal */
export const Record = Schema.TaggedUnion({
  directory: {
    ...Common,
    entries: Schema.Array(Schema.Struct({ name: CanonicalBase64.Encoded, target: NaturalBigInt }))
  },
  file: { ...Common, data: CanonicalBase64.Encoded },
  symlink: { ...Common, target: CanonicalBase64.Encoded }
})

/** @internal */
export type Record = typeof Record.Type

/** @internal */
export const Document = Schema.Struct({
  format: Schema.Literal("effect-vfs-live"),
  version: Schema.Literal(1),
  identity: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
  root: NaturalBigInt,
  nextInode: NaturalBigInt,
  revisionCounter: NaturalBigInt,
  entries: Schema.Natural,
  usedBytes: NaturalBigInt,
  limits: Schema.Struct({
    maxEntries: Schema.optionalKey(Schema.Natural),
    maxBytes: Schema.optionalKey(NaturalBigInt),
    maxFileBytes: Schema.optionalKey(NaturalBigInt),
    maxPathBytes: Schema.optionalKey(NaturalBigInt)
  }),
  retainedFiles: Schema.Array(NaturalBigInt),
  records: Schema.Array(Record)
})

/** @internal */
export type Document = typeof Document.Type

const invalid = () => imageFailure("openImage", "InvalidStructure", { field: "liveImage" })

// The engine keys its inode table by a JavaScript number, so every inode an image allocates must be exactly
// representable. Every record's inode lies below the allocator, so bounding the allocator bounds them all.
const MAX_INODE_ALLOCATOR = BigInt(Number.MAX_SAFE_INTEGER)

const validate = Effect.fnUntraced(function*(document: Document) {
  if (document.nextInode > MAX_INODE_ALLOCATOR) return yield* invalid()
  const records = new Map<bigint, Record>()

  for (const record of document.records) {
    if (
      record.ino < 1n || records.has(record.ino) || record.revision < 1n ||
      record.revision > document.revisionCounter || record.ino >= document.nextInode
    ) return yield* invalid()
    records.set(record.ino, record)
  }

  const root = records.get(document.root)

  if (document.root !== 1n || root?._tag !== "directory" || document.revisionCounter < 1n) {
    return yield* invalid()
  }

  const links = new Map<bigint, number>()
  const pending: Array<readonly [typeof root, bigint]> = [[root, 1n]]
  const seenDirectories = new Set<bigint>()
  const reachable = new Set<bigint>()
  let entries = 0

  for (let index = 0; index < pending.length; index++) {
    const current = pending[index]

    if (current === undefined) return yield* invalid()
    const [directory, pathBytes] = current

    if (seenDirectories.has(directory.ino)) return yield* invalid()
    seenDirectories.add(directory.ino)
    reachable.add(directory.ino)
    const names = new Set<string>()

    for (const entry of directory.entries) {
      if (names.has(entry.name) || entry.target === document.root) return yield* invalid()
      names.add(entry.name)
      const name = yield* CanonicalBase64.decode(entry.name)

      if (
        name.length < 1 || name.length > 255 || name.includes(0) || name.includes(47) ||
        (name.length === 1 && name[0] === 46) ||
        (name.length === 2 && name[0] === 46 && name[1] === 46)
      ) return yield* invalid()
      const childPathBytes = pathBytes + BigInt(name.length) + (pathBytes === 1n ? 0n : 1n)

      if (document.limits.maxPathBytes !== undefined && childPathBytes > document.limits.maxPathBytes) {
        return yield* invalid()
      }

      const target = records.get(entry.target)

      if (target === undefined) return yield* invalid()
      entries++
      links.set(target.ino, (links.get(target.ino) ?? 0) + 1)
      reachable.add(target.ino)

      if (Record.guards.directory(target)) pending.push([target, childPathBytes])
    }
  }

  if (entries !== document.entries || links.has(root.ino)) return yield* invalid()
  const retained = new Set(document.retainedFiles)

  if (retained.size !== document.retainedFiles.length) return yield* invalid()
  let usedBytes = 0n

  for (const record of document.records) {
    const actualLinks = links.get(record.ino) ?? 0

    if (Record.guards.directory(record)) {
      const childDirectories = record.entries.filter((entry) => {
        const child = records.get(entry.target)

        return child !== undefined && Record.guards.directory(child)
      }).length

      if (
        !seenDirectories.has(record.ino) || (record.ino !== root.ino && actualLinks !== 1) ||
        record.metadata.nlink !== 2 + childDirectories || record.metadata.size !== 0n
      ) return yield* invalid()
    } else {
      const payload = Record.guards.file(record) ? record.data : record.target
      const length = BigInt(CanonicalBase64.decodedLength(payload))

      if (record.metadata.size !== length || record.metadata.nlink !== actualLinks) return yield* invalid()

      if (Record.guards.file(record)) {
        if (document.limits.maxFileBytes !== undefined && length > document.limits.maxFileBytes) {
          return yield* invalid()
        }

        if (actualLinks === 0 && !retained.has(record.ino)) return yield* invalid()

        if (actualLinks > 0 && retained.has(record.ino)) return yield* invalid()
      } else {
        if (
          actualLinks === 0 || retained.has(record.ino) || (yield* CanonicalBase64.decode(record.target)).includes(0)
        ) {
          return yield* invalid()
        }
      }

      usedBytes += length
    }

    if (!reachable.has(record.ino) && !retained.has(record.ino)) return yield* invalid()
  }

  if (document.limits.maxPathBytes !== undefined && document.limits.maxPathBytes < 1n) return yield* invalid()

  if (
    usedBytes !== document.usedBytes ||
    (document.limits.maxEntries !== undefined && entries > document.limits.maxEntries) ||
    (document.limits.maxBytes !== undefined && usedBytes > document.limits.maxBytes)
  ) return yield* invalid()

  for (const ino of retained) {
    if (records.get(ino)?._tag !== "file" || reachable.has(ino)) return yield* invalid()
  }

  return document
})

/** @internal */
export const encode = Effect.fnUntraced(function*(document: Document) {
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(Document))(yield* validate(document)).pipe(
    Effect.mapError((cause) => imageFailure("openImage", "InvalidStructure", { field: "liveImage", cause }))
  )

  return new TextEncoder().encode(text)
})

/** @internal */
export const decode = Effect.fnUntraced(function*(bytes: Uint8Array, maxEncodedBytes: ByteSize.ByteSize) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) {
    return yield* imageFailure("openImage", "InvalidEncoding", { field: "liveImage" })
  }

  if (ByteSize.isGreaterThan(ByteSize.bytes(bytes.byteLength), maxEncodedBytes)) {
    return yield* imageFailure("openImage", "LimitExceeded", { field: "encodedBytes" })
  }

  const text = yield* decodeUtf8(
    bytes,
    (cause) => imageFailure("openImage", "InvalidEncoding", { field: "liveImage", cause })
  )

  const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError((cause) => imageFailure("openImage", "InvalidEncoding", { field: "liveImage", cause }))
  )

  const document = yield* Schema.decodeUnknownEffect(Document, { onExcessProperty: "error" })(parsed).pipe(
    Effect.mapError((cause) => imageFailure("openImage", "InvalidStructure", { field: "liveImage", cause }))
  )

  return yield* validate(document)
})
