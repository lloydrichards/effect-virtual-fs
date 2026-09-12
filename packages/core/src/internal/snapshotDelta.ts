/** Exact snapshot delta construction, inspection, serialization, and application. @internal */
import * as ByteSize from "effect/ByteSize"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Equal from "effect/Equal"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { make as makeBytePath } from "../BytePath.js"
import { ImageError, type Snapshot } from "../Snapshot.js"
import {
  makeSnapshotDelta,
  type SnapshotChange,
  type SnapshotChangesOptions,
  type SnapshotDelta,
  SnapshotDeltaError,
  type SnapshotDeltaLimits,
  snapshotDeltaValue,
  type SnapshotDifference,
  type SnapshotNodeKind
} from "../SnapshotDelta.js"
import * as CanonicalBase64 from "./canonicalBase64.js"
import * as Image from "./image.js"

const Path = Schema.String
const Payload = Schema.Union([
  Schema.TaggedStruct("Inline", { bytes: Schema.String }),
  Schema.TaggedStruct("Base", { path: Path })
])
const Record = Schema.Union([
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
type Record = typeof Record.Type
const Kind = Schema.Literals(["directory", "file", "symlink"])
const Difference = Schema.Literals([
  "kind",
  "content",
  "target",
  "hardLinks",
  "mode",
  "uid",
  "gid",
  "atimeNs",
  "mtimeNs",
  "ctimeNs",
  "birthtimeNs"
])
const Change = Schema.Union([
  Schema.TaggedStruct("Added", { path: Path, kind: Kind }),
  Schema.TaggedStruct("Removed", { path: Path, kind: Kind }),
  Schema.TaggedStruct("Updated", {
    path: Path,
    beforeKind: Kind,
    afterKind: Kind,
    differences: Schema.Array(Difference).check(Schema.isMinLength(1))
  })
])
type Change = typeof Change.Type
const Document = Schema.Struct({
  format: Schema.Literal("effect-vfs-delta"),
  version: Schema.Literal(1),
  base: Schema.Struct({ algorithm: Schema.Literal("effect-vfs-semantic-sha256-v1"), digest: Schema.String }),
  records: Schema.Array(Record),
  changes: Schema.Array(Change)
})
type Document = typeof Document.Type

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
const differenceOrder = [
  "kind",
  "content",
  "target",
  "hardLinks",
  "mode",
  "uid",
  "gid",
  "atimeNs",
  "mtimeNs",
  "ctimeNs",
  "birthtimeNs"
] as const
const encoder = new TextEncoder()
const Json = Schema.fromJsonString(Schema.Unknown)
const failure = (code: ImageError["code"], field?: string) =>
  new ImageError({ code, ...(field === undefined ? {} : { field }) })
const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) => Equal.equals(a, b)
const compareBytes = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i]! - b[i]!
    if (d !== 0) return d
  }
  return a.length - b.length
}
const key = Encoding.encodeHex
const join = (parent: Uint8Array, name: Uint8Array) => {
  const out = new Uint8Array(parent.length + (parent.length === 1 ? 0 : 1) + name.length)
  out.set(parent)
  let offset = parent.length
  if (parent.length !== 1) out[offset++] = 47
  out.set(name, offset)
  return out
}
const parentKey = (path: Uint8Array) => {
  let slash = path.length - 1
  while (slash > 0 && path[slash] !== 47) slash--
  return key(slash === 0 ? new Uint8Array([47]) : path.subarray(0, slash))
}
const basename = (path: Uint8Array) => {
  let slash = path.length - 1
  while (slash > 0 && path[slash] !== 47) slash--
  return path.subarray(slash + 1)
}
const decode64 = (s: string, field: string): Effect.Effect<Uint8Array, ImageError> =>
  CanonicalBase64.isCanonical(s) ? Effect.succeed(Image.bytes(s)) : Effect.fail(failure("InvalidEncoding", field))
const safeAdd = (a: number, b: number) => {
  const n = a + b
  return Number.isSafeInteger(n) ? n : undefined
}
const encodedPayloadLength = (value: string) =>
  value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)
const exceedsByteLimit = (value: number, limit: number | bigint) => BigInt(value) > BigInt(limit)
const validPath = (path: Uint8Array) => {
  if (path.length === 0 || path[0] !== 47 || path.includes(0) || (path.length > 1 && path.at(-1) === 47)) return false
  if (path.length === 1) return true
  let start = 1
  for (let i = 1; i <= path.length; i++) {
    if (i === path.length || path[i] === 47) {
      const length = i - start
      if (
        length < 1 || length > 255 || (length === 1 && path[start] === 46) ||
        (length === 2 && path[start] === 46 && path[start + 1] === 46)
      ) return false
      start = i + 1
    }
  }
  return true
}

const normalize = Effect.fnUntraced(
  function*(
    snapshot: Snapshot,
    limits: SnapshotDeltaLimits,
    role: "base" | "target"
  ): Effect.fn.Return<SnapshotView, ImageError> {
    const doc = yield* Image.inspect(snapshot)
    if (doc.records.length > (role === "base" ? limits.maxBaseRecords : limits.maxTargetRecords)) {
      return yield* failure("LimitExceeded", `${role}Records`)
    }
    const records = new Map(doc.records.map((record) => [record.id, record]))
    const pathsById = new Map<string, Array<Uint8Array>>()
    const pending: Array<readonly [string, Uint8Array]> = [[doc.root, new Uint8Array([47])]]
    let entries = 0
    let pathBytes = 1
    for (let i = 0; i < pending.length; i++) {
      const [recordId, path] = pending[i]!
      const record = records.get(recordId)
      if (record === undefined) return yield* failure("InvalidStructure", role)
      const paths = pathsById.get(recordId)
      if (paths === undefined) pathsById.set(recordId, [path])
      else paths.push(path)
      if (record.kind === "directory") {
        for (const entry of record.entries) {
          if (++entries > limits.maxEntries) return yield* failure("LimitExceeded", "entries")
          const nameLength = encodedPayloadLength(entry.name)
          const pathLength = safeAdd(path.length + (path.length === 1 ? 0 : 1), nameLength)
          const nextPathBytes = pathLength === undefined ? undefined : safeAdd(pathBytes, pathLength)
          const pathLimit = role === "base" ? limits.maxIdentityBytes : limits.maxDecodedDeltaBytes
          if (nextPathBytes === undefined || exceedsByteLimit(nextPathBytes, pathLimit)) {
            return yield* failure("LimitExceeded", role === "base" ? "identityBytes" : "decodedDeltaBytes")
          }
          pathBytes = nextPathBytes
          pending.push([entry.target, join(path, Image.bytes(entry.name))])
        }
      }
    }
    const objects: Array<ObjectView> = []
    const byPath = new Map<string, { readonly object: ObjectView; readonly path: Uint8Array }>()
    let payloadBytes = 0
    let basePayloadBytes = 0
    for (const record of doc.records) {
      const paths = pathsById.get(record.id)
      if (paths === undefined) return yield* failure("InvalidStructure", role)
      paths.sort(compareBytes)
      const encodedPayload = record.kind === "directory"
        ? undefined
        : record.kind === "file"
        ? record.data
        : record.target
      if (encodedPayload !== undefined) {
        const payloadLength = encodedPayloadLength(encodedPayload)
        const next = safeAdd(role === "base" ? basePayloadBytes : payloadBytes, payloadLength)
        const limit = role === "base" ? limits.maxIdentityBytes : limits.maxOutputBytes
        if (next === undefined || exceedsByteLimit(next, limit)) {
          return yield* failure("LimitExceeded", role === "base" ? "identityBytes" : "outputBytes")
        }
        if (role === "base") basePayloadBytes = next
        else payloadBytes = next
      }
      const payload = encodedPayload === undefined ? undefined : Image.bytes(encodedPayload)
      const object = {
        kind: record.kind,
        metadata: record.metadata,
        paths,
        pathIdentity: paths.map(key).join("/"),
        payload
      } satisfies ObjectView
      objects.push(object)
      for (const path of paths) byPath.set(key(path), { object, path })
    }
    objects.sort((a, b) => compareBytes(a.paths[0]!, b.paths[0]!))
    return { objects, byPath }
  }
)
const u64 = (n: number) => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false)
  return out
}
// This is the versioned semantic identity encoding, not a generic byte builder.
// Field framing, ordering, and the domain prefix are part of the persisted delta contract.
const identityBytes = Effect.fnUntraced(function*(view: SnapshotView, limits: SnapshotDeltaLimits) {
  let length = 0
  const initialCapacity = ByteSize.isGreaterThanOrEqualTo(limits.maxIdentityBytes, ByteSize.kibibytes(1))
    ? 1024
    : Number(ByteSize.toBigInt(limits.maxIdentityBytes))
  let output = new Uint8Array(initialCapacity)
  const append = (bytes: Uint8Array): Effect.Effect<void, ImageError> => {
    const next = safeAdd(length, bytes.length)
    if (next === undefined || BigInt(next) > ByteSize.toBigInt(limits.maxIdentityBytes)) {
      return Effect.fail(failure("LimitExceeded", "identityBytes"))
    }
    if (next > output.length) {
      let capacity = Math.max(1, output.length)
      while (capacity < next) capacity = Math.min(next, capacity * 2)
      const expanded = new Uint8Array(capacity)
      expanded.set(output)
      output = expanded
    }
    output.set(bytes, length)
    length = next
    return Effect.void
  }
  const frame = Effect.fnUntraced(function*(bytes: Uint8Array) {
    yield* append(u64(bytes.length))
    yield* append(bytes)
  })
  yield* append(encoder.encode("effect-vfs-semantic-sha256-v1\0"))
  yield* append(u64(view.objects.length))
  for (const object of view.objects) {
    yield* append(u64(object.paths.length))
    for (const path of object.paths) yield* frame(path)
    yield* append(new Uint8Array([object.kind === "directory" ? 0 : object.kind === "file" ? 1 : 2]))
    yield* append(u64(object.metadata.uid))
    yield* append(u64(object.metadata.gid))
    yield* append(u64(object.metadata.mode))
    yield* frame(encoder.encode(object.metadata.atimeNs))
    yield* frame(encoder.encode(object.metadata.mtimeNs))
    yield* frame(encoder.encode(object.metadata.ctimeNs))
    yield* frame(encoder.encode(object.metadata.birthtimeNs))
    yield* frame(object.payload ?? new Uint8Array())
  }
  return output.slice(0, length)
})
const digest = Effect.fnUntraced(function*(view: SnapshotView, limits: SnapshotDeltaLimits) {
  const crypto = yield* Crypto.Crypto
  return yield* crypto.digest("SHA-256", yield* identityBytes(view, limits))
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
  const differencesByPair = new WeakMap<ObjectView, WeakMap<ObjectView, ReadonlyArray<SnapshotDifference>>>()
  const cachedDifferences = (before: ObjectView, after: ObjectView) => {
    let byAfter = differencesByPair.get(before)
    if (byAfter === undefined) {
      byAfter = new WeakMap()
      differencesByPair.set(before, byAfter)
    }
    const cached = byAfter.get(after)
    if (cached !== undefined) return cached
    const value = differences(before, after)
    byAfter.set(after, value)
    return value
  }
  for (const [pathKey, before] of base.byPath) {
    const after = target.byPath.get(pathKey)
    if (after === undefined) {
      add({ _tag: "Removed", path: Image.base64(before.path), kind: before.object.kind }, before.path)
    } else {
      const diff = cachedDifferences(before.object, after.object)
      if (diff.length > 0) {
        add({
          _tag: "Updated",
          path: Image.base64(before.path),
          beforeKind: before.object.kind,
          afterKind: after.object.kind,
          differences: diff
        }, before.path)
      }
    }
  }
  for (const [pathKey, after] of target.byPath) {
    if (!base.byPath.has(pathKey)) {
      add({ _tag: "Added", path: Image.base64(after.path), kind: after.object.kind }, after.path)
    }
  }
  changes.sort((a, b) => compareBytes(a.path, b.path))
  return changes.map(({ change }) => change)
}
const getDocument = (delta: SnapshotDelta): Effect.Effect<Document, ImageError> =>
  Effect.suspend(() => {
    const value = snapshotDeltaValue(delta)
    return value !== undefined && Schema.is(Document)(value)
      ? Effect.succeed(value)
      : Effect.fail(failure("InvalidStructure", "delta"))
  })

const buildImage = Effect.fnUntraced(
  function*(
    document: Document,
    base: SnapshotView | undefined,
    limits: SnapshotDeltaLimits
  ): Effect.fn.Return<Snapshot, ImageError> {
    const paths = new Map<
      string,
      { readonly id: string; readonly kind: SnapshotNodeKind; readonly bytes: Uint8Array }
    >()
    const records: Array<Image.Record> = []
    const entriesById = new Map<string, Array<{ name: string; target: string }>>()
    let bytes = 0
    for (let i = 0; i < document.records.length; i++) {
      const record = document.records[i]!
      const recordId = String(i)
      for (const encodedPath of record.paths) {
        const path = yield* decode64(encodedPath, "path")
        paths.set(key(path), { id: recordId, kind: record.kind, bytes: path })
      }
      if (record.kind === "directory") {
        const entries: Array<{ name: string; target: string }> = []
        entriesById.set(recordId, entries)
        records.push({ id: recordId, kind: "directory", metadata: record.metadata, entries })
        continue
      }
      const inherited = record.payload._tag === "Base"
        ? base?.byPath.get(key(yield* decode64(record.payload.path, "basePath")))?.object
        : undefined
      const inlineLength = record.payload._tag === "Inline"
        ? encodedPayloadLength(record.payload.bytes)
        : undefined
      const payloadLength = inlineLength ?? (base === undefined
        ? 0
        : inherited?.kind === record.kind
        ? inherited.payload?.length
        : undefined)
      const next = payloadLength === undefined ? undefined : safeAdd(bytes, payloadLength)
      if (next !== undefined && exceedsByteLimit(next, limits.maxOutputBytes)) {
        return yield* failure("LimitExceeded", "outputBytes")
      }
      const payload = record.payload._tag === "Inline"
        ? yield* decode64(record.payload.bytes, "payload")
        : inherited?.kind === record.kind
        ? inherited.payload
        : undefined
      if (payload === undefined && base !== undefined) return yield* failure("InvalidStructure", "baseReference")
      const actual = payload ?? new Uint8Array()
      if (next === undefined) return yield* failure("LimitExceeded", "outputBytes")
      bytes = next
      records.push(
        record.kind === "file"
          ? { id: recordId, kind: "file", metadata: record.metadata, data: Image.base64(actual) }
          : { id: recordId, kind: "symlink", metadata: record.metadata, target: Image.base64(actual) }
      )
    }
    const root = paths.get(key(new Uint8Array([47])))
    if (root?.kind !== "directory") return yield* failure("InvalidStructure", "root")
    for (const [pathKey, child] of paths) {
      if (pathKey !== key(new Uint8Array([47]))) {
        const parent = paths.get(parentKey(child.bytes))
        const entries = parent === undefined ? undefined : entriesById.get(parent.id)
        if (entries === undefined) return yield* failure("InvalidStructure", "parent")
        entries.push({ name: Image.base64(basename(child.bytes)), target: child.id })
      }
    }
    for (const entries of entriesById.values()) entries.sort((a, b) => a.name.localeCompare(b.name))
    return yield* Image.capture({ format: "effect-vfs", version: 1, root: root.id, records })
  }
)

const validate = Effect.fnUntraced(
  function*(document: Document, limits: SnapshotDeltaLimits): Effect.fn.Return<void, ImageError> {
    const deltaRecords = safeAdd(document.records.length, document.changes.length)
    if (deltaRecords === undefined || deltaRecords > limits.maxDeltaRecords) {
      return yield* failure("LimitExceeded", "deltaRecords")
    }
    if (document.records.length > limits.maxOutputRecords) return yield* failure("LimitExceeded", "outputRecords")
    if (
      !CanonicalBase64.isCanonical(document.base.digest) || CanonicalBase64.decodedLength(document.base.digest) !== 32
    ) {
      return yield* failure("InvalidEncoding", "digest")
    }
    let decoded = 32
    let entries = -1
    let inherited = 0
    const seen = new Set<string>()
    for (const record of document.records) {
      if (record.paths.length < 1 || (record.kind === "directory" && record.paths.length !== 1)) {
        return yield* failure("InvalidStructure", "paths")
      }
      for (const encodedPath of record.paths) {
        if (!CanonicalBase64.isCanonical(encodedPath)) return yield* failure("InvalidEncoding", "path")
        decoded = safeAdd(decoded, CanonicalBase64.decodedLength(encodedPath)) ?? Number.POSITIVE_INFINITY
        if (BigInt(decoded) > ByteSize.toBigInt(limits.maxDecodedDeltaBytes)) {
          return yield* failure("LimitExceeded", "decodedDeltaBytes")
        }
        entries++
        if (entries > limits.maxEntries) return yield* failure("LimitExceeded", "entries")
        const path = yield* decode64(encodedPath, "path")
        if (!validPath(path) || seen.has(key(path))) return yield* failure("InvalidStructure", "path")
        seen.add(key(path))
      }
      if (record.kind !== "directory") {
        if (record.payload._tag === "Inline") {
          if (!CanonicalBase64.isCanonical(record.payload.bytes)) return yield* failure("InvalidEncoding", "payload")
          decoded = safeAdd(decoded, CanonicalBase64.decodedLength(record.payload.bytes)) ?? Number.POSITIVE_INFINITY
          if (BigInt(decoded) > ByteSize.toBigInt(limits.maxDecodedDeltaBytes)) {
            return yield* failure("LimitExceeded", "decodedDeltaBytes")
          }
        } else {
          if (!CanonicalBase64.isCanonical(record.payload.path)) return yield* failure("InvalidEncoding", "basePath")
          decoded = safeAdd(decoded, CanonicalBase64.decodedLength(record.payload.path)) ?? Number.POSITIVE_INFINITY
          if (BigInt(decoded) > ByteSize.toBigInt(limits.maxDecodedDeltaBytes)) {
            return yield* failure("LimitExceeded", "decodedDeltaBytes")
          }
          inherited++
          if (inherited > limits.maxInheritedRecords) {
            return yield* failure("LimitExceeded", "inheritedRecords")
          }
          const path = yield* decode64(record.payload.path, "basePath")
          if (!validPath(path) || !record.paths.includes(record.payload.path)) {
            return yield* failure("InvalidStructure", "basePath")
          }
        }
      }
    }
    let previous: Uint8Array | undefined
    for (const change of document.changes) {
      if (!CanonicalBase64.isCanonical(change.path)) return yield* failure("InvalidEncoding", "changePath")
      decoded = safeAdd(decoded, CanonicalBase64.decodedLength(change.path)) ?? Number.POSITIVE_INFINITY
      if (BigInt(decoded) > ByteSize.toBigInt(limits.maxDecodedDeltaBytes)) {
        return yield* failure("LimitExceeded", "decodedDeltaBytes")
      }
      const path = yield* decode64(change.path, "changePath")
      if (!validPath(path) || (previous !== undefined && compareBytes(previous, path) >= 0)) {
        return yield* failure("InvalidStructure", "changes")
      }
      previous = path
    }
    yield* buildImage(document, undefined, limits)
  }
)

/** @internal */
export const diffSnapshots = Effect.fn("VirtualFileSystem.diffSnapshots")(
  function*(base: Snapshot, target: Snapshot, limits: SnapshotDeltaLimits) {
    const before = yield* normalize(base, limits, "base")
    const after = yield* normalize(target, limits, "target")
    const changes = [...compare(before, after)]
    const deltaRecords = safeAdd(after.objects.length, changes.length)
    if (deltaRecords === undefined || deltaRecords > limits.maxDeltaRecords) {
      return yield* failure("LimitExceeded", "deltaRecords")
    }
    const payloadEquality = new WeakMap<ObjectView, WeakMap<ObjectView, boolean>>()
    const samePayload = (source: ObjectView, target: ObjectView) => {
      let byTarget = payloadEquality.get(source)
      if (byTarget === undefined) {
        byTarget = new WeakMap()
        payloadEquality.set(source, byTarget)
      }
      const cached = byTarget.get(target)
      if (cached !== undefined) return cached
      const value = sameBytes(source.payload, target.payload)
      byTarget.set(target, value)
      return value
    }
    const records: Array<Record> = after.objects.map((object) => {
      const paths = object.paths.map(Image.base64)
      if (object.kind === "directory") return { kind: object.kind, paths, metadata: object.metadata }
      const inherited = object.paths.find((path) => {
        const source = before.byPath.get(key(path))
        return source?.object.kind === object.kind && samePayload(source.object, object)
      })
      return {
        kind: object.kind,
        paths,
        metadata: object.metadata,
        payload: inherited === undefined
          ? { _tag: "Inline", bytes: Image.base64(object.payload ?? new Uint8Array()) }
          : { _tag: "Base", path: Image.base64(inherited) }
      }
    })
    const document: Document = {
      format: "effect-vfs-delta",
      version: 1,
      base: { algorithm: "effect-vfs-semantic-sha256-v1", digest: Image.base64(yield* digest(before, limits)) },
      records,
      changes
    }
    yield* validate(document, limits)
    return makeSnapshotDelta(document)
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
  if (!sameBytes(yield* digest(before, limits), Image.bytes(document.base.digest))) {
    return yield* new SnapshotDeltaError({ code: "BaseMismatch" })
  }
  const target = yield* buildImage(document, before, limits)
  const changes = compare(before, yield* normalize(target, limits, "target"))
  const actualChanges = yield* Schema.encodeEffect(Json)(changes).pipe(
    Effect.mapError(() => failure("InvalidStructure", "changes"))
  )
  const expectedChanges = yield* Schema.encodeEffect(Json)(document.changes).pipe(
    Effect.mapError(() => failure("InvalidStructure", "changes"))
  )
  if (actualChanges !== expectedChanges) return yield* failure("InvalidStructure", "changes")
  return { changes, target }
})

/** @internal */
export const inspectSnapshotDelta = Effect.fn("VirtualFileSystem.inspectSnapshotDelta")(
  function*(base: Snapshot, delta: SnapshotDelta, options: SnapshotChangesOptions, limits: SnapshotDeltaLimits) {
    const output: Array<SnapshotChange> = []
    const { changes } = yield* verify(base, yield* getDocument(delta), limits)
    for (const change of changes) {
      const path = makeBytePath(new Uint8Array(yield* decode64(change.path, "changePath")))
      if (change._tag !== "Updated") output.push(Object.freeze({ ...change, path }))
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
  const text = yield* Schema.encodeEffect(Json)(document).pipe(Effect.mapError(() => failure("InvalidStructure")))
  const bytes = encoder.encode(text)
  if (BigInt(bytes.length) > ByteSize.toBigInt(limits.maxEncodedBytes)) {
    return yield* failure("LimitExceeded", "encodedBytes")
  }
  return bytes
})
/** @internal */
export const decodeSnapshotDelta = Effect.fnUntraced(function*(input: Uint8Array, limits: SnapshotDeltaLimits) {
  if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer)) return yield* failure("InvalidEncoding")
  if (BigInt(input.byteLength) > ByteSize.toBigInt(limits.maxEncodedBytes)) {
    return yield* failure("LimitExceeded", "encodedBytes")
  }
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(input)),
    catch: () => failure("InvalidEncoding")
  })
  const value = yield* Schema.decodeEffect(Json)(text).pipe(Effect.mapError(() => failure("InvalidEncoding")))
  if (
    typeof value === "object" && value !== null && "format" in value && value.format === "effect-vfs-delta" &&
    "version" in value && value.version !== 1
  ) return yield* failure("UnsupportedVersion")
  const parsed = Schema.decodeUnknownResult(Document, { onExcessProperty: "error" })(value)
  if (Result.isFailure(parsed)) return yield* failure("InvalidStructure")
  yield* validate(parsed.success, limits)
  return makeSnapshotDelta(parsed.success)
})
/** @internal */
export const applySnapshotDelta = Effect.fn("VirtualFileSystem.applySnapshotDelta")(
  function*(base: Snapshot, delta: SnapshotDelta, limits: SnapshotDeltaLimits) {
    return (yield* verify(base, yield* getDocument(delta), limits)).target
  }
)
