// Exact snapshot delta construction, inspection, serialization, and application.
import * as ByteSize from "effect/ByteSize"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Fn from "effect/Function"
import * as Match from "effect/Match"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { ImageError, type Snapshot } from "../Snapshot.js"
import {
  type SnapshotChange,
  type SnapshotChangesOptions,
  type SnapshotDelta,
  SnapshotDeltaError,
  type SnapshotDeltaLimits,
  SnapshotDifference,
  SnapshotNodeKind
} from "../SnapshotDelta.js"
import { make as makeBytePath } from "./bytePath.js"
import { bytesOrder, sameBytes } from "./bytes.js"
import { CanonicalBase64 } from "./canonicalBase64.js"
import * as Image from "./image.js"
import { WireStoredMetadata } from "./metadata.js"
import * as SnapshotDeltaModel from "./snapshotDeltaModel.js"

const FORMAT = "effect-vfs-delta"

const ALGORITHM = "effect-vfs-semantic-sha256-v1"

const SLASH_BYTE = 47

const DOT_BYTE = 46

const MAX_NAME_BYTES = 255

const NUL_BYTE = 0

const SHA256_BYTES = 32

const ROOT_PATH = new Uint8Array([SLASH_BYTE])

const Path = CanonicalBase64.Encoded

const InlinePayload = Schema.TaggedStruct("Inline", { bytes: CanonicalBase64.Encoded })

const BasePayload = Schema.TaggedStruct("Base", { path: Path })

const Payload = Schema.Union([InlinePayload, BasePayload])

const DeltaRecord = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("directory"), paths: Schema.Array(Path), metadata: Image.StoredMetadata }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    paths: Schema.Array(Path),
    metadata: Image.StoredMetadata,
    payload: Payload
  }),
  Schema.Struct({
    kind: Schema.Literal("symlink"),
    paths: Schema.Array(Path),
    metadata: Image.StoredMetadata,
    payload: Payload
  })
])

type DeltaRecord = typeof DeltaRecord.Type

const AddedChange = Schema.TaggedStruct("Added", { path: Path, kind: SnapshotNodeKind })

const RemovedChange = Schema.TaggedStruct("Removed", { path: Path, kind: SnapshotNodeKind })

const UpdatedChange = Schema.TaggedStruct("Updated", {
  path: Path,
  beforeKind: SnapshotNodeKind,
  afterKind: SnapshotNodeKind,
  differences: Schema.Array(SnapshotDifference).check(Schema.isMinLength(1))
})

const Change = Schema.Union([AddedChange, RemovedChange, UpdatedChange])

type Change = typeof Change.Type

const WirePayload = Schema.Union([
  Schema.TaggedStruct("Inline", { bytes: Schema.String }),
  Schema.TaggedStruct("Base", { path: Schema.String })
])

const WireDeltaRecord = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("directory"),
    paths: Schema.Array(Schema.String),
    metadata: WireStoredMetadata
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    paths: Schema.Array(Schema.String),
    metadata: WireStoredMetadata,
    payload: WirePayload
  }),
  Schema.Struct({
    kind: Schema.Literal("symlink"),
    paths: Schema.Array(Schema.String),
    metadata: WireStoredMetadata,
    payload: WirePayload
  })
])

const WireChange = Schema.Union([
  Schema.TaggedStruct("Added", { path: Schema.String, kind: SnapshotNodeKind }),
  Schema.TaggedStruct("Removed", { path: Schema.String, kind: SnapshotNodeKind }),
  Schema.TaggedStruct("Updated", {
    path: Schema.String,
    beforeKind: SnapshotNodeKind,
    afterKind: SnapshotNodeKind,
    differences: Schema.Array(SnapshotDifference).check(Schema.isMinLength(1))
  })
])

const sameChanges = Schema.toEquivalence(Schema.Array(Change))

const VersionProbe = Schema.Struct({
  format: Schema.Literal(FORMAT),
  version: Schema.Unknown
})

const Document = Schema.Struct({
  format: Schema.Literal(FORMAT),
  version: Schema.Literal(1),
  base: Schema.Struct({ algorithm: Schema.Literal(ALGORITHM), digest: CanonicalBase64.Encoded }),
  records: Schema.Array(DeltaRecord),
  changes: Schema.Array(Change)
})

type Document = typeof Document.Type

const WireDocument = Schema.Struct({
  format: Schema.Literal(FORMAT),
  version: Schema.Literal(1),
  base: Schema.Struct({ algorithm: Schema.Literal(ALGORITHM), digest: Schema.String }),
  records: Schema.Array(WireDeltaRecord),
  changes: Schema.Array(WireChange)
})

type WireDocument = typeof WireDocument.Type

type ValidatablePayload =
  | { readonly _tag: "Inline"; readonly bytes: string }
  | { readonly _tag: "Base"; readonly path: string }

type ValidatableRecord =
  | { readonly kind: "directory"; readonly paths: ReadonlyArray<string> }
  | {
    readonly kind: "file" | "symlink"
    readonly paths: ReadonlyArray<string>
    readonly payload: ValidatablePayload
  }

interface ValidatableDocument {
  readonly base: { readonly digest: string }
  readonly records: ReadonlyArray<ValidatableRecord>
  readonly changes: ReadonlyArray<{ readonly path: string }>
}

interface ObjectView {
  readonly kind: SnapshotNodeKind
  readonly metadata: Image.StoredMetadata
  readonly paths: ReadonlyArray<Uint8Array>
  readonly pathIdentity: string
  readonly payload: Uint8Array | undefined
}

interface SnapshotView {
  readonly objects: ReadonlyArray<ObjectView>
  readonly byPath: ReadonlyMap<string, { readonly object: ObjectView; readonly path: Uint8Array }>
}

const timestampFields = new Set<SnapshotDifference>(["atimeNs", "mtimeNs", "ctimeNs", "birthtimeNs"])

const differenceOrder = SnapshotDifference.literals

const encoder = new TextEncoder()

const Json = Schema.fromJsonString(Schema.Unknown)

const JsonDocument = Schema.fromJsonString(Document)

const key = Encoding.encodeHex

const join = (parent: Uint8Array, name: Uint8Array) => {
  const out = new Uint8Array(parent.length + (parent.length === 1 ? 0 : 1) + name.length)
  out.set(parent)
  let offset = parent.length

  if (parent.length !== 1) out[offset++] = SLASH_BYTE
  out.set(name, offset)

  return out
}

const parentKey = (path: Uint8Array) => {
  let slash = path.length - 1

  while (slash > 0 && path[slash] !== SLASH_BYTE) slash--

  return key(slash === 0 ? ROOT_PATH : path.subarray(0, slash))
}

const basename = (path: Uint8Array) => {
  let slash = path.length - 1

  while (slash > 0 && path[slash] !== SLASH_BYTE) slash--

  return path.subarray(slash + 1)
}

const safeAdd = (a: number, b: number) => {
  const n = a + b

  return Number.isSafeInteger(n) ? n : undefined
}

const exceeds = (value: number, limit: ByteSize.ByteSize) => ByteSize.isGreaterThan(ByteSize.bytes(value), limit)

const validPath = (path: Uint8Array) => {
  if (
    path.length === 0 || path[0] !== SLASH_BYTE || path.includes(NUL_BYTE) ||
    (path.length > 1 && path.at(-1) === SLASH_BYTE)
  ) return false

  if (path.length === 1) return true
  let start = 1

  for (let i = 1; i <= path.length; i++) {
    if (i === path.length || path[i] === SLASH_BYTE) {
      const length = i - start

      if (
        length < 1 || length > MAX_NAME_BYTES || (length === 1 && path[start] === DOT_BYTE) ||
        (length === 2 && path[start] === DOT_BYTE && path[start + 1] === DOT_BYTE)
      ) return false
      start = i + 1
    }
  }

  return true
}

type Role = "base" | "target"

interface RoleBudget {
  readonly records: number
  readonly recordsField: string
  readonly pathBytes: ByteSize.ByteSize
  readonly pathBytesField: string
  readonly payloadBytes: ByteSize.ByteSize
  readonly payloadBytesField: string
}

const roleBudget = (limits: SnapshotDeltaLimits, role: Role): RoleBudget =>
  role === "base"
    ? {
      records: limits.maxBaseRecords,
      recordsField: "baseRecords",
      pathBytes: limits.maxIdentityBytes,
      pathBytesField: "identityBytes",
      payloadBytes: limits.maxIdentityBytes,
      payloadBytesField: "identityBytes"
    }
    : {
      records: limits.maxTargetRecords,
      recordsField: "targetRecords",
      pathBytes: limits.maxDecodedDeltaBytes,
      pathBytesField: "decodedDeltaBytes",
      payloadBytes: limits.maxOutputBytes,
      payloadBytesField: "outputBytes"
    }

const encodedPayload = (record: Image.Record): typeof CanonicalBase64.Encoded.Type | undefined =>
  Match.value(record).pipe(
    Match.tag("directory", () => undefined),
    Match.tag("file", (record) => record.data),
    Match.tag("symlink", (record) => record.target),
    Match.exhaustive
  )

const normalize = Effect.fnUntraced(
  function*(snapshot: Snapshot, limits: SnapshotDeltaLimits, role: Role): Effect.fn.Return<SnapshotView, ImageError> {
    const doc = yield* Image.inspect(snapshot)
    const budget = roleBudget(limits, role)

    if (doc.records.length > budget.records) {
      return yield* new ImageError({ code: "LimitExceeded", field: budget.recordsField })
    }

    const records = new Map(doc.records.map((record) => [record.id, record]))
    const pathsById = new Map<string, Array<Uint8Array>>()
    const pending: Array<readonly [string, Uint8Array]> = [[doc.root, ROOT_PATH]]
    let entries = 0
    let pathBytes = ByteSize.bytes(ROOT_PATH.length)

    // Index loop: `pending` grows while it is being walked.
    for (let i = 0; i < pending.length; i++) {
      const [recordId, path] = pending[i]!
      const record = records.get(recordId)

      if (record === undefined) return yield* new ImageError({ code: "InvalidStructure", field: role })
      const paths = pathsById.get(recordId)

      if (paths === undefined) pathsById.set(recordId, [path])
      else paths.push(path)

      if (Image.Record.guards.directory(record)) {
        for (const entry of record.entries) {
          if (++entries > limits.maxEntries) return yield* new ImageError({ code: "LimitExceeded", field: "entries" })
          const separator = path.length === ROOT_PATH.length ? 0 : 1
          const pathLength = path.length + separator + CanonicalBase64.decodedLength(entry.name)
          pathBytes = ByteSize.sum(pathBytes, ByteSize.bytes(pathLength))

          if (ByteSize.isGreaterThan(pathBytes, budget.pathBytes)) {
            return yield* new ImageError({ code: "LimitExceeded", field: budget.pathBytesField })
          }

          pending.push([entry.target, join(path, yield* CanonicalBase64.decode(entry.name))])
        }
      }
    }

    const objects: Array<ObjectView> = []
    const byPath = new Map<string, { readonly object: ObjectView; readonly path: Uint8Array }>()
    let payloadBytes = ByteSize.zero

    for (const record of doc.records) {
      const paths = pathsById.get(record.id)

      if (paths === undefined) return yield* new ImageError({ code: "InvalidStructure", field: role })
      paths.sort(bytesOrder)
      const encoded = encodedPayload(record)

      if (encoded !== undefined) {
        payloadBytes = ByteSize.sum(payloadBytes, ByteSize.bytes(CanonicalBase64.decodedLength(encoded)))

        if (ByteSize.isGreaterThan(payloadBytes, budget.payloadBytes)) {
          return yield* new ImageError({ code: "LimitExceeded", field: budget.payloadBytesField })
        }
      }

      const object = {
        kind: record._tag,
        metadata: record.metadata,
        paths,
        pathIdentity: paths.map(key).join("/"),
        payload: encoded === undefined ? undefined : yield* CanonicalBase64.decode(encoded)
      } satisfies ObjectView

      objects.push(object)

      for (const path of paths) byPath.set(key(path), { object, path })
    }

    objects.sort((a, b) => bytesOrder(a.paths[0]!, b.paths[0]!))

    return { objects, byPath }
  }
)

const U64_BYTES = 8

const EMPTY = new Uint8Array()

const IDENTITY_PREFIX = encoder.encode(`${ALGORITHM}\0`)

const KIND_BYTE = { directory: 0, file: 1, symlink: 2 } as const satisfies Record<SnapshotNodeKind, number>

const u64 = (n: number) => {
  const out = new Uint8Array(U64_BYTES)
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false)

  return out
}

const framedLength = (bytes: Uint8Array) => U64_BYTES + bytes.length

const timestampBytes = (metadata: Image.StoredMetadata): ReadonlyArray<Uint8Array> =>
  [metadata.atimeNs, metadata.mtimeNs, metadata.ctimeNs, metadata.birthtimeNs].map((value) =>
    encoder.encode(String(value))
  )

// This is the versioned semantic identity encoding, not a generic byte builder.
// Field framing, ordering, and the domain prefix are part of the persisted delta contract.
const identityBytes = (view: SnapshotView, limits: SnapshotDeltaLimits): Result.Result<Uint8Array, ImageError> => {
  const timestamps = view.objects.map((object) => timestampBytes(object.metadata))
  let total = ByteSize.bytes(IDENTITY_PREFIX.length + U64_BYTES)

  for (const [index, object] of view.objects.entries()) {
    const objectBytes = U64_BYTES +
      object.paths.reduce((sum, path) => sum + framedLength(path), 0) +
      1 + 3 * U64_BYTES +
      timestamps[index]!.reduce((sum, stamp) => sum + framedLength(stamp), 0) +
      framedLength(object.payload ?? EMPTY)

    total = ByteSize.sum(total, ByteSize.bytes(objectBytes))
  }

  if (ByteSize.isGreaterThan(total, limits.maxIdentityBytes)) {
    return Result.fail(new ImageError({ code: "LimitExceeded", field: "identityBytes" }))
  }

  const output = new Uint8Array(Number(ByteSize.toBigInt(total)))
  let offset = 0

  const put = (bytes: Uint8Array) => {
    output.set(bytes, offset)
    offset += bytes.length
  }

  const frame = (bytes: Uint8Array) => {
    put(u64(bytes.length))
    put(bytes)
  }

  put(IDENTITY_PREFIX)
  put(u64(view.objects.length))

  for (const [index, object] of view.objects.entries()) {
    put(u64(object.paths.length))

    for (const path of object.paths) frame(path)
    put(new Uint8Array([KIND_BYTE[object.kind]]))
    put(u64(object.metadata.uid))
    put(u64(object.metadata.gid))
    put(u64(object.metadata.mode))

    for (const stamp of timestamps[index]!) frame(stamp)
    frame(object.payload ?? EMPTY)
  }

  return Result.succeed(output)
}

const digest = Effect.fnUntraced(function*(view: SnapshotView, limits: SnapshotDeltaLimits) {
  const crypto = yield* Crypto.Crypto

  return yield* crypto.digest("SHA-256", yield* Effect.fromResult(identityBytes(view, limits)))
})

const samePaths = (a: ObjectView, b: ObjectView) => a.pathIdentity === b.pathIdentity

const differences = (before: ObjectView, after: ObjectView): ReadonlyArray<SnapshotDifference> =>
  differenceOrder.filter((field) => {
    if (field === "kind") return before.kind !== after.kind

    if (field === "content") {
      return before.kind === after.kind && after.kind === "file" && !sameBytes(before.payload, after.payload)
    }

    if (field === "target") {
      return before.kind === after.kind && after.kind === "symlink" && !sameBytes(before.payload, after.payload)
    }

    if (field === "hardLinks") return !samePaths(before, after)

    return before.metadata[field] !== after.metadata[field]
  })

const compare = (base: SnapshotView, target: SnapshotView): ReadonlyArray<Change> => {
  const changes: Array<{ readonly change: Change; readonly path: Uint8Array }> = []
  const add = (change: Change, path: Uint8Array) => changes.push({ change, path })

  // Memoized per object pair so hard-link groups compare each pair once.
  const cachedDifferences = Fn.memoize((before: ObjectView) =>
    Fn.memoize((after: ObjectView) => differences(before, after))
  )

  for (const [pathKey, before] of base.byPath) {
    const after = target.byPath.get(pathKey)

    if (after === undefined) {
      add(RemovedChange.make({ path: CanonicalBase64.encode(before.path), kind: before.object.kind }), before.path)
    } else {
      const diff = cachedDifferences(before.object)(after.object)

      if (diff.length > 0) {
        add(
          UpdatedChange.make({
            path: CanonicalBase64.encode(before.path),
            beforeKind: before.object.kind,
            afterKind: after.object.kind,
            differences: diff
          }),
          before.path
        )
      }
    }
  }

  for (const [pathKey, after] of target.byPath) {
    if (!base.byPath.has(pathKey)) {
      add(AddedChange.make({ path: CanonicalBase64.encode(after.path), kind: after.object.kind }), after.path)
    }
  }

  changes.sort((a, b) => bytesOrder(a.path, b.path))

  return changes.map(({ change }) => change)
}

const getDocument = (delta: SnapshotDelta): Effect.Effect<Document, ImageError> =>
  Effect.suspend(() => {
    const value = SnapshotDeltaModel.value(delta)

    return value !== undefined && Schema.is(Document)(value)
      ? Effect.succeed(value)
      : Effect.fail(new ImageError({ code: "InvalidStructure", field: "delta" }))
  })

interface PathEntry {
  readonly id: string
  readonly kind: SnapshotNodeKind
  readonly bytes: Uint8Array
}

// `name` holds the raw basename bytes so ordering never decodes base64. `buildImage` encodes each
// name once when it materialises the image record.
interface DirectoryEntry {
  readonly name: Uint8Array
  readonly target: string
}

const byEntryName = (a: DirectoryEntry, b: DirectoryEntry) => bytesOrder(a.name, b.name)

// Every recorded path must be the root directory or the child of a recorded directory.
// Together with `validPath` and the per-record path rules in `validate`, this subsumes the
// structural checks `Image.capture` would otherwise perform on the applied image.
const linkTree = (
  paths: ReadonlyMap<string, PathEntry>
): Result.Result<
  { readonly root: string; readonly entriesById: ReadonlyMap<string, Array<DirectoryEntry>> },
  ImageError
> => {
  const rootKey = key(ROOT_PATH)
  const root = paths.get(rootKey)

  if (root?.kind !== "directory") return Result.fail(new ImageError({ code: "InvalidStructure", field: "root" }))
  const entriesById = new Map<string, Array<DirectoryEntry>>()

  for (const entry of paths.values()) {
    if (entry.kind === "directory") entriesById.set(entry.id, [])
  }

  for (const [pathKey, child] of paths) {
    if (pathKey === rootKey) continue
    const parent = paths.get(parentKey(child.bytes))
    const entries = parent === undefined ? undefined : entriesById.get(parent.id)

    if (entries === undefined) return Result.fail(new ImageError({ code: "InvalidStructure", field: "parent" }))
    entries.push({ name: basename(child.bytes), target: child.id })
  }

  for (const entries of entriesById.values()) entries.sort(byEntryName)

  return Result.succeed({ root: root.id, entriesById })
}

const inheritedPayload = Effect.fnUntraced(
  function*(base: SnapshotView, kind: SnapshotNodeKind, encodedPath: typeof Path.Type) {
    const source = base.byPath.get(key(yield* CanonicalBase64.decode(encodedPath)))?.object

    return source?.kind === kind ? source.payload : undefined
  }
)

// Expects a document that already passed `validate`.
const buildImage = Effect.fnUntraced(
  function*(
    document: Document,
    base: SnapshotView,
    limits: SnapshotDeltaLimits
  ): Effect.fn.Return<Snapshot, ImageError> {
    const paths = new Map<string, PathEntry>()

    for (const [index, record] of document.records.entries()) {
      for (const encodedPath of record.paths) {
        const bytes = yield* CanonicalBase64.decode(encodedPath)
        paths.set(key(bytes), { id: String(index), kind: record.kind, bytes })
      }
    }

    const tree = yield* Effect.fromResult(linkTree(paths))
    const records: Array<Image.Record> = []
    let outputBytes = ByteSize.zero

    for (const [index, record] of document.records.entries()) {
      const id = String(index)

      if (record.kind === "directory") {
        records.push(Image.Record.cases.directory.make({
          id,
          metadata: record.metadata,
          entries: (tree.entriesById.get(id) ?? []).map((entry) => ({
            name: CanonicalBase64.encode(entry.name),
            target: entry.target
          }))
        }))
        continue
      }

      const payload = Predicate.isTagged("Inline")(record.payload)
        ? yield* CanonicalBase64.decode(record.payload.bytes)
        : yield* inheritedPayload(base, record.kind, record.payload.path)

      if (payload === undefined) return yield* new ImageError({ code: "InvalidStructure", field: "baseReference" })
      outputBytes = ByteSize.sum(outputBytes, ByteSize.bytes(payload.length))

      if (ByteSize.isGreaterThan(outputBytes, limits.maxOutputBytes)) {
        return yield* new ImageError({ code: "LimitExceeded", field: "outputBytes" })
      }

      records.push(
        record.kind === "file"
          ? Image.Record.cases.file.make({ id, metadata: record.metadata, data: CanonicalBase64.encode(payload) })
          : Image.Record.cases.symlink.make({
            id,
            metadata: record.metadata,
            target: CanonicalBase64.encode(payload)
          })
      )
    }

    return yield* Image.capture({ format: "effect-vfs", version: 1, root: tree.root, records }, undefined, true)
  }
)

const validate = Effect.fnUntraced(
  function*(document: ValidatableDocument, limits: SnapshotDeltaLimits): Effect.fn.Return<void, ImageError> {
    const deltaRecords = safeAdd(document.records.length, document.changes.length)

    if (deltaRecords === undefined || deltaRecords > limits.maxDeltaRecords) {
      return yield* new ImageError({ code: "LimitExceeded", field: "deltaRecords" })
    }

    if (document.records.length > limits.maxOutputRecords) {
      return yield* new ImageError({ code: "LimitExceeded", field: "outputRecords" })
    }

    if (
      !CanonicalBase64.is(document.base.digest) ||
      CanonicalBase64.decodedLength(document.base.digest) !== SHA256_BYTES
    ) {
      return yield* new ImageError({ code: "InvalidEncoding", field: "digest" })
    }

    let decoded = ByteSize.bytes(SHA256_BYTES)
    let outputBytes = ByteSize.zero
    let entries = -1
    let inherited = 0
    const paths = new Map<string, PathEntry>()

    const charge = (encoded: typeof CanonicalBase64.Encoded.Type): Effect.Effect<void, ImageError> => {
      decoded = ByteSize.sum(decoded, ByteSize.bytes(CanonicalBase64.decodedLength(encoded)))

      return ByteSize.isGreaterThan(decoded, limits.maxDecodedDeltaBytes)
        ? Effect.fail(new ImageError({ code: "LimitExceeded", field: "decodedDeltaBytes" }))
        : Effect.void
    }

    for (const [index, record] of document.records.entries()) {
      if (record.paths.length < 1 || (record.kind === "directory" && record.paths.length !== 1)) {
        return yield* new ImageError({ code: "InvalidStructure", field: "paths" })
      }

      for (const encodedPath of record.paths) {
        if (!CanonicalBase64.is(encodedPath)) {
          return yield* new ImageError({ code: "InvalidEncoding", field: "path" })
        }

        yield* charge(encodedPath)
        entries++

        if (entries > limits.maxEntries) return yield* new ImageError({ code: "LimitExceeded", field: "entries" })
        const bytes = yield* CanonicalBase64.decode(encodedPath)
        const pathKey = key(bytes)

        if (!validPath(bytes) || paths.has(pathKey)) {
          return yield* new ImageError({ code: "InvalidStructure", field: "path" })
        }

        paths.set(pathKey, { id: String(index), kind: record.kind, bytes })
      }

      if (record.kind === "directory") continue

      if (Predicate.isTagged("Inline")(record.payload)) {
        if (!CanonicalBase64.is(record.payload.bytes)) {
          return yield* new ImageError({ code: "InvalidEncoding", field: "payload" })
        }

        yield* charge(record.payload.bytes)
        outputBytes = ByteSize.sum(outputBytes, ByteSize.bytes(CanonicalBase64.decodedLength(record.payload.bytes)))
      } else {
        if (!CanonicalBase64.is(record.payload.path)) {
          return yield* new ImageError({ code: "InvalidEncoding", field: "basePath" })
        }

        yield* charge(record.payload.path)
        inherited++

        if (inherited > limits.maxInheritedRecords) {
          return yield* new ImageError({ code: "LimitExceeded", field: "inheritedRecords" })
        }

        if (
          !validPath(yield* CanonicalBase64.decode(record.payload.path)) || !record.paths.includes(record.payload.path)
        ) {
          return yield* new ImageError({ code: "InvalidStructure", field: "basePath" })
        }
      }
    }

    let previous: Uint8Array | undefined

    for (const change of document.changes) {
      if (!CanonicalBase64.is(change.path)) {
        return yield* new ImageError({ code: "InvalidEncoding", field: "changePath" })
      }

      yield* charge(change.path)
      const path = yield* CanonicalBase64.decode(change.path)

      if (!validPath(path) || (previous !== undefined && bytesOrder(previous, path) >= 0)) {
        return yield* new ImageError({ code: "InvalidStructure", field: "changes" })
      }

      previous = path
    }

    if (ByteSize.isGreaterThan(outputBytes, limits.maxOutputBytes)) {
      return yield* new ImageError({ code: "LimitExceeded", field: "outputBytes" })
    }

    yield* Effect.fromResult(linkTree(paths))

    // Inline symlink targets are the only applied payloads a base snapshot has not already vetted.
    for (const record of document.records) {
      if (record.kind !== "symlink" || !Predicate.isTagged("Inline")(record.payload)) continue

      if (!CanonicalBase64.is(record.payload.bytes)) {
        return yield* new ImageError({ code: "InvalidEncoding", field: "payload" })
      }

      if ((yield* CanonicalBase64.decode(record.payload.bytes)).includes(NUL_BYTE)) {
        return yield* new ImageError({ code: "InvalidStructure", field: "symlink" })
      }
    }
  }
)

/** @internal */
export const diffSnapshots = Effect.fnUntraced(
  function*(base: Snapshot, target: Snapshot, limits: SnapshotDeltaLimits) {
    const before = yield* normalize(base, limits, "base")
    const after = yield* normalize(target, limits, "target")
    const changes = [...compare(before, after)]
    const deltaRecords = safeAdd(after.objects.length, changes.length)

    if (deltaRecords === undefined || deltaRecords > limits.maxDeltaRecords) {
      return yield* new ImageError({ code: "LimitExceeded", field: "deltaRecords" })
    }

    const samePayload = Fn.memoize((source: ObjectView) =>
      Fn.memoize((candidate: ObjectView) => sameBytes(source.payload, candidate.payload))
    )

    const records: Array<DeltaRecord> = after.objects.map((object) => {
      const paths = object.paths.map(CanonicalBase64.encode)

      if (object.kind === "directory") return { kind: object.kind, paths, metadata: object.metadata }

      const inherited = object.paths.find((path) => {
        const source = before.byPath.get(key(path))

        return source?.object.kind === object.kind && samePayload(source.object)(object)
      })

      return {
        kind: object.kind,
        paths,
        metadata: object.metadata,
        payload: inherited === undefined
          ? InlinePayload.make({ bytes: CanonicalBase64.encode(object.payload ?? new Uint8Array()) })
          : BasePayload.make({ path: CanonicalBase64.encode(inherited) })
      }
    })

    const document: Document = {
      format: FORMAT,
      version: 1,
      base: { algorithm: ALGORITHM, digest: CanonicalBase64.encode(yield* digest(before, limits)) },
      records,
      changes
    }

    yield* validate(document, limits)

    return SnapshotDeltaModel.make(document)
  }
)

/** @internal */
const verify = Effect.fnUntraced(function*(
  base: Snapshot,
  document: Document,
  limits: SnapshotDeltaLimits
) {
  yield* validate(document, limits)
  const before = yield* normalize(base, limits, "base")

  if (!sameBytes(yield* digest(before, limits), yield* CanonicalBase64.decode(document.base.digest))) {
    return yield* new SnapshotDeltaError({ code: "BaseMismatch" })
  }

  const target = yield* buildImage(document, before, limits)
  const changes = compare(before, yield* normalize(target, limits, "target"))

  if (!sameChanges(changes, document.changes)) {
    return yield* new ImageError({ code: "InvalidStructure", field: "changes" })
  }

  return { changes, target }
})

/** @internal */
export const inspectSnapshotDelta = Effect.fnUntraced(
  function*(base: Snapshot, delta: SnapshotDelta, options: SnapshotChangesOptions, limits: SnapshotDeltaLimits) {
    const output: Array<SnapshotChange> = []
    const { changes } = yield* verify(base, yield* getDocument(delta), limits)

    for (const change of changes) {
      const path = makeBytePath(yield* CanonicalBase64.decode(change.path))

      if (!Predicate.isTagged("Updated")(change)) output.push(Object.freeze({ ...change, path }))
      else {
        const fields = change.differences.filter((field) =>
          options.includeTimestamps === true || !timestampFields.has(field)
        )

        if (fields.length > 0) output.push(Object.freeze({ ...change, path, differences: Object.freeze([...fields]) }))
      }
    }

    return Object.freeze(output)
  }
)

/** @internal */
export const encodeSnapshotDelta = Effect.fnUntraced(function*(delta: SnapshotDelta, limits: SnapshotDeltaLimits) {
  const document = yield* getDocument(delta)
  yield* validate(document, limits)

  const text = yield* Schema.encodeEffect(JsonDocument)(document).pipe(
    Effect.mapError((cause) => new ImageError({ code: "InvalidStructure", cause }))
  )

  const bytes = encoder.encode(text)

  if (exceeds(bytes.length, limits.maxEncodedBytes)) {
    return yield* new ImageError({ code: "LimitExceeded", field: "encodedBytes" })
  }

  return bytes
})

/** @internal */
export const decodeSnapshotDelta = Effect.fnUntraced(function*(input: Uint8Array, limits: SnapshotDeltaLimits) {
  if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) {
    return yield* new ImageError({ code: "InvalidEncoding" })
  }

  if (exceeds(input.byteLength, limits.maxEncodedBytes)) {
    return yield* new ImageError({ code: "LimitExceeded", field: "encodedBytes" })
  }

  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(input)),
    // SAFETY: a fatal TextDecoder throws only TypeError.
    catch: (cause) => new ImageError({ code: "InvalidEncoding", cause: cause as TypeError })
  })

  const value = yield* Schema.decodeEffect(Json)(text).pipe(
    Effect.mapError((cause) => new ImageError({ code: "InvalidEncoding", cause }))
  )

  const version = Schema.decodeUnknownResult(VersionProbe)(value)

  if (Result.isSuccess(version) && version.success.version !== 1) {
    return yield* new ImageError({ code: "UnsupportedVersion" })
  }

  const wire = Schema.decodeUnknownResult(WireDocument, { onExcessProperty: "error" })(value)

  if (Result.isFailure(wire)) return yield* new ImageError({ code: "InvalidStructure" })
  yield* validate(wire.success, limits)

  const parsed = Schema.decodeUnknownResult(Document, { onExcessProperty: "error" })(value)

  if (Result.isFailure(parsed)) return yield* new ImageError({ code: "InvalidEncoding" })

  return SnapshotDeltaModel.make(parsed.success)
})

/** @internal */
export const applySnapshotDelta = Effect.fnUntraced(
  function*(base: Snapshot, delta: SnapshotDelta, limits: SnapshotDeltaLimits) {
    return (yield* verify(base, yield* getDocument(delta), limits)).target
  }
)
