// Exact snapshot delta construction, inspection, serialization, and application.
import * as ByteSize from "effect/ByteSize"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Fn from "effect/Function"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { Snapshot } from "../Snapshot.js"
import {
  type SnapshotChange,
  type SnapshotChangesOptions,
  type SnapshotDelta,
  SnapshotDifference,
  SnapshotNodeKind
} from "../SnapshotDelta.js"
import type { ImageFailure } from "../VfsError.js"
import type { DeltaBudget } from "./budget.js"
import { make as makeBytePath } from "./bytePath.js"
import { bytesOrder, decodeUtf8, sameBytes } from "./bytes.js"
import { CanonicalBase64 } from "./canonicalBase64.js"
import { imageFailure, VfsError } from "./errors.js"
import * as Image from "./image.js"
import { StoredMetadata, WireStoredMetadata } from "./metadata.js"
import { isNameBytes, nameBytes, NUL_BYTE, SLASH_BYTE } from "./path.js"
import * as SnapshotDeltaModel from "./snapshotDeltaModel.js"
import {
  assemble,
  getNode,
  Ino,
  type Link,
  type NodeSpec,
  reachableNodes,
  ROOT_INO,
  storedMetadata
} from "./volumeState.js"

const FORMAT = "effect-vfs-delta"

const ALGORITHM = "effect-vfs-semantic-sha256-v1"

const SHA256_BYTES = 32

const ROOT_PATH = new Uint8Array([SLASH_BYTE])

const Path = CanonicalBase64.Encoded

const InlinePayload = Schema.TaggedStruct("Inline", { bytes: CanonicalBase64.Encoded })

const BasePayload = Schema.TaggedStruct("Base", { path: Path })

const Payload = Schema.Union([InlinePayload, BasePayload])

const DeltaRecord = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("directory"), paths: Schema.Array(Path), metadata: StoredMetadata }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    paths: Schema.Array(Path),
    metadata: StoredMetadata,
    payload: Payload
  }),
  Schema.Struct({
    kind: Schema.Literal("symlink"),
    paths: Schema.Array(Path),
    metadata: StoredMetadata,
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
  readonly metadata: StoredMetadata
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

const parentOf = (path: Uint8Array) => {
  let slash = path.length - 1

  while (slash > 0 && path[slash] !== SLASH_BYTE) slash--

  return slash === 0 ? ROOT_PATH : path.subarray(0, slash)
}

const parentKey = (path: Uint8Array) => key(parentOf(path))

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

// An absolute path of valid names: the root alone, or a slash before each name and none after the last.
const validPath = (path: Uint8Array) => {
  if (path[0] !== SLASH_BYTE) return false
  let start = 1

  for (let i = 1; i <= path.length && path.length > 1; i++) {
    if (i === path.length || path[i] === SLASH_BYTE) {
      if (!isNameBytes(path.subarray(start, i))) return false
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

const roleBudget = (limits: DeltaBudget, role: Role): RoleBudget =>
  role === "base"
    ? {
      records: limits.baseRecords,
      recordsField: "baseRecords",
      pathBytes: limits.identityBytes,
      pathBytesField: "identityBytes",
      payloadBytes: limits.identityBytes,
      payloadBytesField: "identityBytes"
    }
    : {
      records: limits.targetRecords,
      recordsField: "targetRecords",
      pathBytes: limits.decodedBytes,
      pathBytesField: "decodedDeltaBytes",
      payloadBytes: limits.outputBytes,
      payloadBytesField: "outputBytes"
    }

const normalize = Effect.fnUntraced(
  function*(snapshot: Snapshot, limits: DeltaBudget, role: Role): Effect.fn.Return<SnapshotView, ImageFailure> {
    const value = yield* Image.valueOf(snapshot)
    const budget = roleBudget(limits, role)
    const nodes = yield* reachableNodes(value)

    if (nodes.length > budget.records) {
      return yield* imageFailure("snapshotDelta", "LimitExceeded", { field: budget.recordsField })
    }

    const pathsByIno = new Map<Ino, Array<Uint8Array>>()
    const pending: Array<readonly [Ino, Uint8Array]> = [[ROOT_INO, ROOT_PATH]]
    let entries = 0
    let pathBytes = ByteSize.bytes(ROOT_PATH.length)

    // Index loop: `pending` grows while it is being walked.
    for (let i = 0; i < pending.length; i++) {
      const [ino, path] = pending[i]!
      const paths = pathsByIno.get(ino)

      if (paths === undefined) pathsByIno.set(ino, [path])
      else paths.push(path)
      const node = getNode(value, ino)

      if (node?.kind !== "directory") continue

      for (const [name, child] of node.entries) {
        if (++entries > limits.entries) {
          return yield* imageFailure("snapshotDelta", "LimitExceeded", { field: "entries" })
        }

        const bytes = nameBytes(name)
        const separator = path.length === ROOT_PATH.length ? 0 : 1
        pathBytes = ByteSize.sum(pathBytes, ByteSize.bytes(path.length + separator + bytes.length))

        if (ByteSize.isGreaterThan(pathBytes, budget.pathBytes)) {
          return yield* imageFailure("snapshotDelta", "LimitExceeded", { field: budget.pathBytesField })
        }

        pending.push([child, join(path, bytes)])
      }
    }

    const objects: Array<ObjectView> = []
    const byPath = new Map<string, { readonly object: ObjectView; readonly path: Uint8Array }>()
    let payloadBytes = ByteSize.zero

    for (const node of nodes) {
      const paths = pathsByIno.get(node.ino) ?? []
      paths.sort(bytesOrder)
      const payload = node.kind === "file" ? node.data.bytes : node.kind === "symlink" ? node.target : undefined

      if (payload !== undefined) {
        payloadBytes = ByteSize.sum(payloadBytes, ByteSize.bytes(payload.length))

        if (ByteSize.isGreaterThan(payloadBytes, budget.payloadBytes)) {
          return yield* imageFailure("snapshotDelta", "LimitExceeded", { field: budget.payloadBytesField })
        }
      }

      const object = {
        kind: node.kind,
        metadata: storedMetadata(node.metadata),
        paths,
        pathIdentity: paths.map(key).join("/"),
        payload
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

const timestampBytes = (metadata: StoredMetadata): ReadonlyArray<Uint8Array> =>
  [metadata.atimeNs, metadata.mtimeNs, metadata.ctimeNs, metadata.birthtimeNs].map((value) =>
    encoder.encode(String(value))
  )

// This is the versioned semantic identity encoding, not a generic byte builder.
// Field framing, ordering, and the domain prefix are part of the persisted delta contract.
const identityBytes = (view: SnapshotView, limits: DeltaBudget): Result.Result<Uint8Array, ImageFailure> => {
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

  if (ByteSize.isGreaterThan(total, limits.identityBytes)) {
    return Result.fail(imageFailure("snapshotDelta", "LimitExceeded", { field: "identityBytes" }))
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

const digest = Effect.fnUntraced(function*(view: SnapshotView, limits: DeltaBudget) {
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

const getDocument = (delta: SnapshotDelta): Effect.Effect<Document, ImageFailure> =>
  Effect.suspend(() => {
    const value = SnapshotDeltaModel.value(delta)

    return value !== undefined && Schema.is(Document)(value)
      ? Effect.succeed(value)
      : Effect.fail(imageFailure("snapshotDelta", "InvalidStructure", { field: "delta" }))
  })

interface PathEntry {
  readonly id: string
  readonly kind: SnapshotNodeKind
  readonly bytes: Uint8Array
}

// Every recorded path must be the root directory or the child of a recorded directory. Together with `validPath`
// and the per-record path rules in `validate`, this makes the recorded paths one tree, so the applied value needs
// no further structural check. Returns the root's record.
const linkTree = (paths: ReadonlyMap<string, PathEntry>): Result.Result<string, ImageFailure> => {
  const rootKey = key(ROOT_PATH)
  const root = paths.get(rootKey)

  if (root?.kind !== "directory") {
    return Result.fail(imageFailure("snapshotDelta", "InvalidStructure", { field: "root" }))
  }

  for (const [pathKey, child] of paths) {
    if (pathKey !== rootKey && paths.get(parentKey(child.bytes))?.kind !== "directory") {
      return Result.fail(imageFailure("snapshotDelta", "InvalidStructure", { field: "parent" }))
    }
  }

  return Result.succeed(root.id)
}

const inheritedPayload = Effect.fnUntraced(
  function*(base: SnapshotView, kind: SnapshotNodeKind, encodedPath: typeof Path.Type) {
    const source = base.byPath.get(key(yield* CanonicalBase64.decode(encodedPath)))?.object

    return source?.kind === kind ? source.payload : undefined
  }
)

// Expects a document that already passed `validate`. Inode numbers follow record order after the root.
const buildSnapshot = Effect.fnUntraced(
  function*(
    document: Document,
    base: SnapshotView,
    limits: DeltaBudget
  ): Effect.fn.Return<Snapshot, ImageFailure> {
    const paths = new Map<string, PathEntry>()

    for (const [index, record] of document.records.entries()) {
      for (const encodedPath of record.paths) {
        const bytes = yield* CanonicalBase64.decode(encodedPath)
        paths.set(key(bytes), { id: String(index), kind: record.kind, bytes })
      }
    }

    const root = yield* Effect.fromResult(linkTree(paths))
    const inos = new Map<string, Ino>()
    let next = ROOT_INO

    for (const index of document.records.keys()) {
      if (String(index) === root) inos.set(root, ROOT_INO)
      else {
        next = Ino(next + 1)
        inos.set(String(index), next)
      }
    }

    // Each path names its object inside the directory its parent path records; the root's path names the root.
    const inoAt = (path: Uint8Array) => {
      const entry = paths.get(key(path))

      return entry === undefined ? undefined : inos.get(entry.id)
    }

    const specs: Array<NodeSpec> = []
    let outputBytes = ByteSize.zero

    for (const record of document.records) {
      const links: Array<Link> = []
      let ino: Ino | undefined

      for (const encodedPath of record.paths) {
        const bytes = yield* CanonicalBase64.decode(encodedPath)
        const parent = inoAt(parentOf(bytes))
        ino = inoAt(bytes)

        if (parent === undefined || ino === undefined) {
          return yield* imageFailure("snapshotDelta", "InvalidStructure", { field: "parent" })
        }

        links.push({ parent, name: key(basename(bytes)) })
      }

      const [link] = links

      if (ino === undefined || link === undefined) {
        return yield* imageFailure("snapshotDelta", "InvalidStructure", { field: "paths" })
      }

      const common = { ino, metadata: record.metadata, revision: 1n }

      if (record.kind === "directory") {
        specs.push({ ...common, kind: "directory", parent: link.parent, name: link.name })
        continue
      }

      const payload = Predicate.isTagged("Inline")(record.payload)
        ? yield* CanonicalBase64.decode(record.payload.bytes)
        : yield* inheritedPayload(base, record.kind, record.payload.path)

      if (payload === undefined) {
        return yield* imageFailure("snapshotDelta", "InvalidStructure", { field: "baseReference" })
      }

      outputBytes = ByteSize.sum(outputBytes, ByteSize.bytes(payload.length))

      if (ByteSize.isGreaterThan(outputBytes, limits.outputBytes)) {
        return yield* imageFailure("snapshotDelta", "LimitExceeded", { field: "outputBytes" })
      }

      specs.push(
        record.kind === "file"
          ? { ...common, kind: "file", links, data: payload }
          : { ...common, kind: "symlink", links, target: payload }
      )
    }

    return Image.make(assemble(specs))
  }
)

const validate = Effect.fnUntraced(
  function*(document: ValidatableDocument, limits: DeltaBudget): Effect.fn.Return<void, ImageFailure> {
    const deltaRecords = safeAdd(document.records.length, document.changes.length)

    if (deltaRecords === undefined || deltaRecords > limits.records) {
      return yield* imageFailure("snapshotDelta", "LimitExceeded", { field: "deltaRecords" })
    }

    if (document.records.length > limits.outputRecords) {
      return yield* imageFailure("snapshotDelta", "LimitExceeded", { field: "outputRecords" })
    }

    if (
      !CanonicalBase64.is(document.base.digest) ||
      CanonicalBase64.decodedLength(document.base.digest) !== SHA256_BYTES
    ) {
      return yield* imageFailure("snapshotDelta", "InvalidEncoding", { field: "digest" })
    }

    let decoded = ByteSize.bytes(SHA256_BYTES)
    let outputBytes = ByteSize.zero
    let entries = -1
    let inherited = 0
    const paths = new Map<string, PathEntry>()

    const charge = (encoded: typeof CanonicalBase64.Encoded.Type): Effect.Effect<void, ImageFailure> => {
      decoded = ByteSize.sum(decoded, ByteSize.bytes(CanonicalBase64.decodedLength(encoded)))

      return ByteSize.isGreaterThan(decoded, limits.decodedBytes)
        ? Effect.fail(imageFailure("snapshotDelta", "LimitExceeded", { field: "decodedDeltaBytes" }))
        : Effect.void
    }

    for (const [index, record] of document.records.entries()) {
      if (record.paths.length < 1 || (record.kind === "directory" && record.paths.length !== 1)) {
        return yield* imageFailure("snapshotDelta", "InvalidStructure", { field: "paths" })
      }

      for (const encodedPath of record.paths) {
        if (!CanonicalBase64.is(encodedPath)) {
          return yield* imageFailure("snapshotDelta", "InvalidEncoding", { field: "path" })
        }

        yield* charge(encodedPath)
        entries++

        if (entries > limits.entries) {
          return yield* imageFailure("snapshotDelta", "LimitExceeded", { field: "entries" })
        }

        const bytes = yield* CanonicalBase64.decode(encodedPath)
        const pathKey = key(bytes)

        if (!validPath(bytes) || paths.has(pathKey)) {
          return yield* imageFailure("snapshotDelta", "InvalidStructure", { field: "path" })
        }

        paths.set(pathKey, { id: String(index), kind: record.kind, bytes })
      }

      if (record.kind === "directory") continue

      if (Predicate.isTagged("Inline")(record.payload)) {
        if (!CanonicalBase64.is(record.payload.bytes)) {
          return yield* imageFailure("snapshotDelta", "InvalidEncoding", { field: "payload" })
        }

        yield* charge(record.payload.bytes)
        outputBytes = ByteSize.sum(outputBytes, ByteSize.bytes(CanonicalBase64.decodedLength(record.payload.bytes)))
      } else {
        if (!CanonicalBase64.is(record.payload.path)) {
          return yield* imageFailure("snapshotDelta", "InvalidEncoding", { field: "basePath" })
        }

        yield* charge(record.payload.path)
        inherited++

        if (inherited > limits.inheritedRecords) {
          return yield* imageFailure("snapshotDelta", "LimitExceeded", { field: "inheritedRecords" })
        }

        if (
          !validPath(yield* CanonicalBase64.decode(record.payload.path)) || !record.paths.includes(record.payload.path)
        ) {
          return yield* imageFailure("snapshotDelta", "InvalidStructure", { field: "basePath" })
        }
      }
    }

    let previous: Uint8Array | undefined

    for (const change of document.changes) {
      if (!CanonicalBase64.is(change.path)) {
        return yield* imageFailure("snapshotDelta", "InvalidEncoding", { field: "changePath" })
      }

      yield* charge(change.path)
      const path = yield* CanonicalBase64.decode(change.path)

      if (!validPath(path) || (previous !== undefined && bytesOrder(previous, path) >= 0)) {
        return yield* imageFailure("snapshotDelta", "InvalidStructure", { field: "changes" })
      }

      previous = path
    }

    if (ByteSize.isGreaterThan(outputBytes, limits.outputBytes)) {
      return yield* imageFailure("snapshotDelta", "LimitExceeded", { field: "outputBytes" })
    }

    yield* Effect.fromResult(linkTree(paths))

    // Inline symlink targets are the only applied payloads a base snapshot has not already vetted.
    for (const record of document.records) {
      if (record.kind !== "symlink" || !Predicate.isTagged("Inline")(record.payload)) continue

      if (!CanonicalBase64.is(record.payload.bytes)) {
        return yield* imageFailure("snapshotDelta", "InvalidEncoding", { field: "payload" })
      }

      if ((yield* CanonicalBase64.decode(record.payload.bytes)).includes(NUL_BYTE)) {
        return yield* imageFailure("snapshotDelta", "InvalidStructure", { field: "symlink" })
      }
    }
  }
)

/** @internal */
export const diffSnapshots = Effect.fnUntraced(
  function*(base: Snapshot, target: Snapshot, limits: DeltaBudget) {
    const before = yield* normalize(base, limits, "base")
    const after = yield* normalize(target, limits, "target")
    const changes = [...compare(before, after)]
    const deltaRecords = safeAdd(after.objects.length, changes.length)

    if (deltaRecords === undefined || deltaRecords > limits.records) {
      return yield* imageFailure("snapshotDelta", "LimitExceeded", { field: "deltaRecords" })
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
  limits: DeltaBudget
) {
  yield* validate(document, limits)
  const before = yield* normalize(base, limits, "base")

  if (!sameBytes(yield* digest(before, limits), yield* CanonicalBase64.decode(document.base.digest))) {
    return yield* new VfsError({ code: "BaseMismatch", operation: "snapshotDelta" })
  }

  const target = yield* buildSnapshot(document, before, limits)
  const changes = compare(before, yield* normalize(target, limits, "target"))

  if (!sameChanges(changes, document.changes)) {
    return yield* imageFailure("snapshotDelta", "InvalidStructure", { field: "changes" })
  }

  return { changes, target }
})

/** @internal */
export const inspectSnapshotDelta = Effect.fnUntraced(
  function*(base: Snapshot, delta: SnapshotDelta, options: SnapshotChangesOptions, limits: DeltaBudget) {
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
export const encodeSnapshotDelta = Effect.fnUntraced(function*(delta: SnapshotDelta, limits: DeltaBudget) {
  const document = yield* getDocument(delta)
  yield* validate(document, limits)

  const text = yield* Schema.encodeEffect(JsonDocument)(document).pipe(
    Effect.mapError((cause) => imageFailure("snapshotDelta", "InvalidStructure", { cause }))
  )

  const bytes = encoder.encode(text)

  if (exceeds(bytes.length, limits.encodedBytes)) {
    return yield* imageFailure("snapshotDelta", "LimitExceeded", { field: "encodedBytes" })
  }

  return bytes
})

/** @internal */
export const decodeSnapshotDelta = Effect.fnUntraced(function*(input: Uint8Array, limits: DeltaBudget) {
  if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) {
    return yield* imageFailure("snapshotDelta", "InvalidEncoding")
  }

  if (exceeds(input.byteLength, limits.encodedBytes)) {
    return yield* imageFailure("snapshotDelta", "LimitExceeded", { field: "encodedBytes" })
  }

  const text = yield* decodeUtf8(input, (cause) => imageFailure("snapshotDelta", "InvalidEncoding", { cause }))

  const value = yield* Schema.decodeEffect(Json)(text).pipe(
    Effect.mapError((cause) => imageFailure("snapshotDelta", "InvalidEncoding", { cause }))
  )

  const version = Schema.decodeUnknownResult(VersionProbe)(value)

  if (Result.isSuccess(version) && version.success.version !== 1) {
    return yield* imageFailure("snapshotDelta", "UnsupportedVersion")
  }

  const wire = yield* Schema.decodeUnknownEffect(WireDocument, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError((cause) => imageFailure("snapshotDelta", "InvalidStructure", { cause }))
  )

  yield* validate(wire, limits)

  const parsed = yield* Schema.decodeUnknownEffect(Document, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError((cause) => imageFailure("snapshotDelta", "InvalidEncoding", { cause }))
  )

  return SnapshotDeltaModel.make(parsed)
})

/** @internal */
export const applySnapshotDelta = Effect.fnUntraced(
  function*(base: Snapshot, delta: SnapshotDelta, limits: DeltaBudget) {
    return (yield* verify(base, yield* getDocument(delta), limits)).target
  }
)
