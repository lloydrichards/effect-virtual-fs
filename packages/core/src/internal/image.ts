// Snapshot validation and serialization used by VirtualFileSystem.
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Match from "effect/Match"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { DecodeLimits, type Snapshot, SnapshotTypeId } from "../Snapshot.js"
import type { ImageFailure } from "../VfsError.js"
import { decodeUtf8 } from "./bytes.js"
import { CanonicalBase64 } from "./canonicalBase64.js"
import { decodeConfiguration, imageFailure } from "./errors.js"
import * as InodeTable from "./inodeTable.js"
import { StoredMetadata, WireStoredMetadata } from "./metadata.js"
import * as Content from "./overlayContent.js"
import { nameBytes } from "./path.js"
import {
  getNode,
  Ino,
  type Link,
  type Node,
  type NodeMetadata,
  ROOT_INO,
  storedMetadata,
  type VolumeState,
  WALK_YIELD_INTERVAL
} from "./volumeState.js"

// A snapshot is the volume value it was captured from. The value is immutable, so capture shares it rather than
// copying it, and the private field keeps it out of reach of anything but this module.
class SnapshotImpl implements Snapshot {
  readonly [SnapshotTypeId]: SnapshotTypeId = SnapshotTypeId
  readonly #value: VolumeState

  constructor(value: VolumeState) {
    this.#value = value
  }

  static valueOf(snapshot: Snapshot): VolumeState | undefined {
    return #value in snapshot ? snapshot.#value : undefined
  }
}

/** @internal */
export const make = (value: VolumeState): Snapshot => Object.freeze(new SnapshotImpl(value))

/** @internal */
export const valueOf = (snapshot: Snapshot): Effect.Effect<VolumeState, ImageFailure> =>
  Effect.suspend(() => {
    const value = SnapshotImpl.valueOf(snapshot)

    return value === undefined
      ? imageFailure("decodeSnapshot", "InvalidStructure", { field: "snapshot" })
      : Effect.succeed(value)
  })

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

// The value's reachable namespace as an image, numbering records in walk order.
const toDocument = Effect.fnUntraced(function*(value: VolumeState) {
  const ids = new Map<Ino, string>([[ROOT_INO, "0"]])
  const pending: Array<Ino> = [ROOT_INO]
  const records: Array<Record> = []

  for (let index = 0; index < pending.length; index++) {
    if (index % WALK_YIELD_INTERVAL === 0) yield* Effect.yieldNow
    const ino = pending[index]

    if (ino === undefined) continue
    const node = getNode(value, ino)
    const id = ids.get(ino)

    if (id === undefined || node === undefined) return yield* imageFailure("snapshot", "InvalidStructure")
    const metadata = storedMetadata(node.metadata)

    if (node.kind === "directory") {
      const children: Array<{ name: typeof CanonicalBase64.Encoded.Type; target: string }> = []

      for (const [name, child] of node.entries) {
        let target = ids.get(child)

        if (target === undefined) {
          target = String(ids.size)
          ids.set(child, target)
          pending.push(child)
        }

        children.push({ name: CanonicalBase64.encode(nameBytes(name)), target })
      }

      records.push(Record.cases.directory.make({ id, metadata, entries: children }))
    } else if (node.kind === "file") {
      records.push(Record.cases.file.make({ id, metadata, data: CanonicalBase64.encode(node.data.bytes) }))
    } else {
      records.push(Record.cases.symlink.make({ id, metadata, target: CanonicalBase64.encode(node.target) }))
    }
  }

  const document: Document = { format: "effect-vfs", version: 1, root: "0", records }

  return document
})

/** @internal */
export const inspect = (snapshot: Snapshot): Effect.Effect<Document, ImageFailure> =>
  Effect.flatMap(valueOf(snapshot), toDocument)

// Restores a validated image into a volume value. Inode numbers follow record order, so every volume restored
// from one image assigns the same numbers.
const restore = Effect.fnUntraced(function*(image: Document) {
  // Restored inodes are built mutably here and frozen into the table once every entry is wired.
  const incoming = new Map<string, { node: Node; entries: Map<string, Ino>; links: Array<Link> }>()
  let nextInode = Ino(2)
  let entries = 0
  let usedBytes = 0n

  for (const record of image.records) {
    const isRoot = record.id === image.root
    const ino = isRoot ? ROOT_INO : nextInode

    if (!isRoot) nextInode = Ino(nextInode + 1)

    const metadata: NodeMetadata = {
      ...record.metadata,
      kind: record._tag,
      ino: BigInt(ino),
      nlink: Record.guards.directory(record) ? 2 : 0,
      size: 0n
    }

    if (Record.guards.directory(record)) {
      const entries = new Map<string, Ino>()
      incoming.set(record.id, {
        node: { kind: "directory", ino, parent: ROOT_INO, name: "", entries, metadata, revision: 1n },
        entries,
        links: []
      })
    } else if (Record.guards.file(record)) {
      const data = Content.make(yield* CanonicalBase64.decode(record.data))
      const links: Array<Link> = []
      usedBytes += BigInt(data.bytes.length)
      incoming.set(record.id, {
        node: {
          kind: "file",
          ino,
          data,
          links,
          metadata: { ...metadata, size: BigInt(data.bytes.length) },
          revision: 1n
        },
        entries: new Map(),
        links
      })
    } else {
      const target = yield* CanonicalBase64.decode(record.target)
      const links: Array<Link> = []
      usedBytes += BigInt(target.length)
      incoming.set(record.id, {
        node: {
          kind: "symlink",
          ino,
          target,
          links,
          metadata: { ...metadata, size: BigInt(target.length) },
          revision: 1n
        },
        entries: new Map(),
        links
      })
    }
  }

  for (const record of image.records) {
    if (!Record.guards.directory(record)) continue
    const parent = incoming.get(record.id)

    if (parent?.node.kind !== "directory") return yield* imageFailure("snapshot", "InvalidStructure")

    for (const entry of record.entries) {
      const child = incoming.get(entry.target)

      if (child === undefined) return yield* imageFailure("snapshot", "InvalidStructure")
      const name = Encoding.encodeHex(yield* CanonicalBase64.decode(entry.name))
      parent.entries.set(name, child.node.ino)
      entries++

      if (child.node.kind === "directory") {
        child.node = { ...child.node, parent: parent.node.ino, name }
        parent.node = {
          ...parent.node,
          metadata: { ...parent.node.metadata, nlink: parent.node.metadata.nlink + 1 }
        }
      } else {
        child.links.push({ parent: parent.node.ino, name })
        child.node = { ...child.node, metadata: { ...child.node.metadata, nlink: child.node.metadata.nlink + 1 } }
      }
    }
  }

  const owner = Symbol()
  let inodes = InodeTable.empty<Node>()

  for (const { node } of incoming.values()) inodes = InodeTable.set(inodes, node.ino, node, owner)

  const value: VolumeState = { inodes, open: new Map(), nextInode, revision: 1n, entries, usedBytes }

  return value
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

  return make(yield* restore(document))
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
