// Runtime definitions and cohesive live virtual filesystem engine.
import * as ByteSize from "effect/ByteSize"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import { BytePath } from "../BytePath.js"
import { ImageError, type Snapshot } from "../Snapshot.js"
import type {
  Caller,
  Change,
  DirectoryHandle,
  FileHandle,
  MetadataOptions,
  ObjectReference,
  OverlayVolume,
  PathInput,
  RelativeOptions,
  Volume
} from "../VirtualFileSystem.js"
import { getBytes as getBytePathBytes } from "./bytePath.js"
import * as Image from "./image.js"
import { ConfigurationError, FsCode as FsCodeSchema, FsError } from "./virtualFileSystem/errors.js"
import * as Content from "./virtualFileSystem/overlayContent.js"
import { compareOverlay, type ObservationEntry, type RawOverlayChange } from "./virtualFileSystem/overlayDiff.js"
import {
  attachedBuffer,
  decodeConfiguration,
  failure,
  type LookupOptions,
  nameBytes,
  ownedPath,
  type PreparedPath,
  preparePath,
  strictString,
  wellFormed
} from "./virtualFileSystem/path.js"
import * as TestHooks from "./virtualFileSystem/testHooks.js"
import * as WatchHub from "./virtualFileSystem/watchHub.js"

/** @internal */
export const VolumeId = Symbol("@effect-vfs/core/Volume")

/** @internal */
export const CallerId = Symbol("@effect-vfs/core/Caller")

/** @internal */
export const FileHandleId = Symbol("@effect-vfs/core/FileHandle")

/** @internal */
export const DirectoryHandleId = Symbol("@effect-vfs/core/DirectoryHandle")

/** @internal */
export const ObjectReferenceId = Symbol("@effect-vfs/core/ObjectReference")

/** @internal */
export { ConfigurationError, FsCodeSchema as FsCode, FsError }

/** @internal */
export const Mode = Schema.Natural.check(Schema.isLessThanOrEqualTo(0o7777))

/** @internal */
export const Identity = Schema.Struct({
  uid: Schema.Natural,
  gid: Schema.Natural,
  groups: Schema.Array(Schema.Natural),
  privileged: Schema.Boolean
})

/** @internal */
export type Identity = typeof Identity.Type

/** @internal */
export const RootCallerOptions = Schema.Struct({
  identity: Schema.optionalKey(Identity),
  umask: Schema.optionalKey(Schema.Natural.check(Schema.isLessThanOrEqualTo(0o777)))
})

/** @internal */
export type RootCallerOptions = typeof RootCallerOptions.Type

/** @internal */
export const VolumeOptions = Schema.Struct({
  maxEntries: Schema.optionalKey(Schema.Natural),
  maxBytes: Schema.optionalKey(Schema.ByteSize),
  maxFileBytes: Schema.optionalKey(
    Schema.ByteSize.check(
      Schema.makeFilter((size) =>
        ByteSize.isLessThanOrEqualTo(size, ByteSize.bytes(0xffffffff)) ? undefined : "must be at most 4294967295 bytes"
      )
    )
  ),
  maxPathBytes: Schema.optionalKey(
    Schema.ByteSize.check(
      Schema.makeFilter((size) =>
        ByteSize.isGreaterThanOrEqualTo(size, ByteSize.bytes(1)) ? undefined : "must be at least 1 byte"
      )
    )
  )
})

/** @internal */
export type VolumeOptions = typeof VolumeOptions.Type

// Match snapshot v1's canonical signed decimal timestamp domain.
const timestampLimit = 10n ** 128n - 1n

/** @internal */
export const Timestamp = Schema.BigInt.check(
  Schema.isGreaterThanOrEqualToBigInt(-timestampLimit),
  Schema.isLessThanOrEqualToBigInt(timestampLimit)
)

/** @internal */
export const Metadata = Schema.Struct({
  kind: Schema.Literals(["directory", "file", "symlink"]),
  ino: Schema.BigInt,
  nlink: Schema.Natural,
  size: Schema.BigInt,
  uid: Schema.Natural,
  gid: Schema.Natural,
  mode: Mode,
  atimeNs: Timestamp,
  mtimeNs: Timestamp,
  ctimeNs: Timestamp,
  birthtimeNs: Timestamp
})

/** @internal */
export type Metadata = typeof Metadata.Type

/** @internal */
export const OwnerUpdate = Schema.Struct({
  uid: Schema.optionalKey(Schema.Natural),
  gid: Schema.optionalKey(Schema.Natural)
})

/** @internal */
export type OwnerUpdate = typeof OwnerUpdate.Type

/** @internal */
export const TimeUpdate = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("now") }),
  Schema.Struct({ kind: Schema.Literal("omit") }),
  Schema.Struct({ kind: Schema.Literal("value"), nanoseconds: Timestamp })
])

/** @internal */
export const Times = Schema.Struct({ access: TimeUpdate, modification: TimeUpdate })

/** @internal */
export type Times = typeof Times.Type

/** @internal */
export const SeekMode = Schema.Literals(["start", "current", "end", "data", "hole"])

/** @internal */
export type SeekMode = typeof SeekMode.Type

/** @internal */
export const OpenSettings = Schema.Struct({
  access: Schema.Literals(["read", "write", "readWrite"]),
  create: Schema.optionalKey(Schema.Literals(["never", "ifMissing", "exclusive"])),
  mode: Schema.optionalKey(Mode),
  append: Schema.optionalKey(Schema.Boolean),
  truncate: Schema.optionalKey(Schema.Boolean),
  followFinalSymlink: Schema.optionalKey(Schema.Boolean)
})

/** @internal */
export type OpenOptions = typeof OpenSettings.Type & RelativeOptions

/** @internal */
export const WriteFileSettings = Schema.Struct({
  ...OpenSettings.fields,
  replaceFinalSymlink: Schema.optionalKey(Schema.Boolean),
  finalMode: Schema.optionalKey(Mode)
})

/** @internal */
export type WriteFileOptions = typeof WriteFileSettings.Type & RelativeOptions

/** @internal */
export const OverlayNodeKind = Schema.Literals(["directory", "file", "symlink"])

/** @internal */
export type OverlayNodeKind = typeof OverlayNodeKind.Type

/** @internal */
export const OverlayDifference = Schema.Literals([
  "content",
  "mode",
  "uid",
  "gid",
  "atimeNs",
  "mtimeNs",
  "ctimeNs",
  "birthtimeNs"
])

/** @internal */
export type OverlayDifference = typeof OverlayDifference.Type

const OverlayDifferences = Schema.Array(OverlayDifference)

const NonEmptyOverlayDifferences = OverlayDifferences.check(Schema.isMinLength(1))

/** @internal */
export const OverlayChange = Schema.Union([
  Schema.TaggedStruct("Added", { path: BytePath, kind: OverlayNodeKind }),
  Schema.TaggedStruct("Removed", { path: BytePath, kind: OverlayNodeKind }),
  Schema.TaggedStruct("Replaced", {
    path: BytePath,
    beforeKind: OverlayNodeKind,
    afterKind: OverlayNodeKind,
    differences: OverlayDifferences
  }),
  Schema.TaggedStruct("Renamed", {
    from: BytePath,
    to: BytePath,
    kind: OverlayNodeKind,
    differences: OverlayDifferences
  }),
  Schema.TaggedStruct("Updated", { path: BytePath, kind: OverlayNodeKind, differences: NonEmptyOverlayDifferences })
])

/** @internal */
export type OverlayChange = typeof OverlayChange.Type

/** @internal */
export const OverlayChangesOptions = Schema.Struct({
  includeTimestamps: Schema.optionalKey(Schema.Boolean)
})

/** @internal */
export type OverlayChangesOptions = typeof OverlayChangesOptions.Type

/** @internal */
export class CurrentFileSystem
  extends Context.Service<CurrentFileSystem, Caller>()("@effect-vfs/core/CurrentFileSystem")
{}

/** @internal */
export const FixtureMetadata = Schema.Struct({
  uid: Schema.optionalKey(Schema.Natural),
  gid: Schema.optionalKey(Schema.Natural),
  mode: Schema.optionalKey(Mode),
  atimeNs: Schema.optionalKey(Timestamp),
  mtimeNs: Schema.optionalKey(Timestamp),
  ctimeNs: Schema.optionalKey(Timestamp),
  birthtimeNs: Schema.optionalKey(Timestamp)
})

const FixturePath = Schema.Union([
  Schema.String,
  BytePath
])

/** @internal */
export const Fixture = Schema.Struct({
  rootMetadata: Schema.optionalKey(FixtureMetadata),
  entries: Schema.Array(Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("directory"),
      path: FixturePath,
      metadata: Schema.optionalKey(FixtureMetadata)
    }),
    Schema.Struct({
      kind: Schema.Literal("file"),
      path: FixturePath,
      bytes: Schema.Uint8Array,
      metadata: Schema.optionalKey(FixtureMetadata)
    }),
    Schema.Struct({
      kind: Schema.Literal("symlink"),
      path: FixturePath,
      target: FixturePath,
      metadata: Schema.optionalKey(FixtureMetadata)
    }),
    Schema.Struct({ kind: Schema.Literal("hardLink"), path: FixturePath, target: FixturePath })
  ]))
})

/** @internal */
export type Fixture = typeof Fixture.Type

interface Directory {
  readonly kind: "directory"
  readonly lineage: string | undefined
  parent: Directory | undefined
  readonly entries: Map<string, Node>
  metadata: Metadata
  revision: bigint
  objectReference: ObjectReference | undefined
}

interface RegularFile {
  readonly kind: "file"
  readonly lineage: string | undefined
  data: Content.Content
  openCount: number
  metadata: Metadata
  revision: bigint
  objectReference: ObjectReference | undefined
}

interface SymbolicLink {
  readonly kind: "symlink"
  readonly lineage: string | undefined
  readonly target: Uint8Array
  metadata: Metadata
  revision: bigint
  objectReference: ObjectReference | undefined
}

type Node = Directory | RegularFile | SymbolicLink

interface ObjectReferenceState {
  readonly volume: symbol
  node: Node | undefined
}

const objectReferences = new WeakMap<ObjectReference, ObjectReferenceState>()

const isFileHandle = (value: PathInput | FileHandle | DirectoryHandle): value is FileHandle =>
  Predicate.hasProperty(FileHandleId)(value)

const isDirectoryHandle = (value: PathInput | FileHandle | DirectoryHandle): value is DirectoryHandle =>
  Predicate.hasProperty(DirectoryHandleId)(value)

interface FileReference {
  readonly volume: symbol
  file: RegularFile | undefined
  closed: boolean
  offset: bigint
  readonly access: "read" | "write" | "readWrite"
  readonly append: boolean
}

const files = new WeakMap<FileHandle, FileReference>()

interface DirectoryReference {
  readonly volume: symbol
  directory: Directory | undefined
  closed: boolean
}

const handles = new WeakMap<DirectoryHandle, DirectoryReference>()

const directoryMetadata = (ino: bigint, uid: number, gid: number, mode: number, now: bigint): Metadata => ({
  kind: "directory",
  ino,
  uid,
  gid,
  mode,
  nlink: 2,
  size: 0n,
  atimeNs: now,
  mtimeNs: now,
  ctimeNs: now,
  birthtimeNs: now
})

const storedMetadata = (metadata: Metadata): Image.StoredMetadata => ({
  uid: metadata.uid,
  gid: metadata.gid,
  mode: metadata.mode,
  atimeNs: String(metadata.atimeNs),
  mtimeNs: String(metadata.mtimeNs),
  ctimeNs: String(metadata.ctimeNs),
  birthtimeNs: String(metadata.birthtimeNs)
})

type VolumeSource =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Snapshot"; readonly image: Image.Document }
  | {
    readonly _tag: "Overlay"
    readonly base: Snapshot
    readonly image: Image.Document
  }

/** @internal */
export const VolumeSource = Data.taggedEnum<VolumeSource>()

type VolumeResult =
  | { readonly _tag: "Volume"; readonly volume: Volume }
  | { readonly _tag: "Overlay"; readonly volume: OverlayVolume }

const VolumeResult = Data.taggedEnum<VolumeResult>()

const UpdateChange = Schema.TaggedStruct("Update", { path: BytePath })

// Each execution constructs a fresh volume and captures its Clock.

/** @internal */
export const makeVolume = Effect.fnUntraced(
  function*(source: VolumeSource, options?: VolumeOptions) {
    const image = "image" in source ? source.image : undefined
    const decoded = decodeConfiguration(VolumeOptions, options === undefined ? {} : options)

    if (Result.isFailure(decoded)) return yield* decoded.failure
    const settings = { ...decoded.success }
    const clock = yield* Clock.clockWith(Effect.succeed)
    const initialTime = clock.currentTimeNanosUnsafe()

    if (!Schema.is(Timestamp)(initialTime)) {
      return yield* new ConfigurationError({ field: "clock.currentTimeNanos" })
    }

    const timestamp = (operation: string) =>
      Effect.suspend(() => {
        const now = clock.currentTimeNanosUnsafe()

        return Schema.is(Timestamp)(now) ? Effect.succeed(now) : Effect.fail(failure("InvalidArgument", operation))
      })

    const volumeIdentity = Symbol()
    const gate = Semaphore.makeUnsafe(1)
    let revisionCounter = 0n
    const nextRevision = () => ++revisionCounter

    const root: Directory = {
      kind: "directory",
      lineage: image?.root,
      parent: undefined,
      entries: new Map(),
      metadata: directoryMetadata(1n, 0, 0, 0o755, initialTime),
      revision: nextRevision(),
      objectReference: undefined
    }

    let nextInode = 2n
    let entries = 0
    let usedBytes = 0n
    // The schema caps this value at uint32, so this boundary conversion is exact.
    const maxFileBytes = Number(ByteSize.toBigInt(settings.maxFileBytes ?? ByteSize.bytes(0xffffffff)))
    // Permit waits stay interruptible. State transitions and resource registration do not.
    const coordinated = <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermit(Effect.uninterruptible(effect))

    if (image !== undefined) {
      const incoming = new Map<string, Node>()
      let content = 0n
      let count = 0

      for (const record of image.records) {
        if (record.kind === "directory") count += record.entries.length
        else {
          const length = Image.decodedLength(record.kind === "file" ? record.data : record.target)

          if (record.kind === "file" && length > maxFileBytes) {
            return yield* new ImageError({ code: "LimitExceeded", field: "maxFileBytes" })
          }

          content += BigInt(length)
        }
      }

      if (
        (settings.maxEntries !== undefined && count > settings.maxEntries) ||
        (settings.maxBytes !== undefined && content > ByteSize.toBigInt(settings.maxBytes))
      ) {
        return yield* new ImageError({ code: "LimitExceeded", field: "volume" })
      }

      const baseContents = Predicate.isTagged("Overlay")(source) ? Content.forOverlay(source.base, image) : undefined

      for (const record of image.records) {
        const metadata: Metadata = {
          ...record.metadata,
          kind: record.kind,
          ino: record.id === image.root ? 1n : nextInode++,
          nlink: record.kind === "directory" ? 2 : 0,
          size: 0n,
          atimeNs: BigInt(record.metadata.atimeNs),
          mtimeNs: BigInt(record.metadata.mtimeNs),
          ctimeNs: BigInt(record.metadata.ctimeNs),
          birthtimeNs: BigInt(record.metadata.birthtimeNs)
        }

        if (record.kind === "directory") {
          const node: Directory = record.id === image.root
            ? root
            : {
              kind: "directory",
              lineage: record.id,
              parent: undefined,
              entries: new Map(),
              metadata,
              revision: nextRevision(),
              objectReference: undefined
            }

          node.metadata = metadata
          incoming.set(record.id, node)
        } else if (record.kind === "file") {
          const data = baseContents?.get(record.id) ?? Content.make(Image.bytes(record.data))
          incoming.set(record.id, {
            kind: "file",
            lineage: record.id,
            data,
            openCount: 0,
            metadata: { ...metadata, size: BigInt(data.bytes.length) },
            revision: nextRevision(),
            objectReference: undefined
          })
        } else {
          const target = Image.bytes(record.target)
          incoming.set(record.id, {
            kind: "symlink",
            lineage: record.id,
            target,
            metadata: { ...metadata, size: BigInt(target.length) },
            revision: nextRevision(),
            objectReference: undefined
          })
        }
      }

      for (const record of image.records) {
        if (record.kind !== "directory") continue
        const parent = incoming.get(record.id)

        if (parent?.kind !== "directory") return yield* new ImageError({ code: "InvalidStructure" })

        for (const entry of record.entries) {
          const node = incoming.get(entry.target)

          if (node === undefined) return yield* new ImageError({ code: "InvalidStructure" })
          parent.entries.set(Encoding.encodeHex(Image.bytes(entry.name)), node)

          if (node.kind === "directory") {
            node.parent = parent
            parent.metadata = { ...parent.metadata, nlink: parent.metadata.nlink + 1 }
          } else node.metadata = { ...node.metadata, nlink: node.metadata.nlink + 1 }
        }
      }

      entries = count
      usedBytes = content
    }

    const watchHub = yield* WatchHub.make<Change>(coordinated)

    const directoryHex = (directory: Directory): string => {
      const names: Array<string> = []
      let current = directory

      while (current.parent !== undefined) {
        const parent = current.parent
        const found = [...parent.entries].find(([, node]) => node === current)

        if (found === undefined) break
        names.push(found[0])
        current = parent
      }

      return "2f" + names.reverse().join("2f")
    }

    const publishEntry = (_tag: Change["_tag"], parent: Directory, name: string) => {
      watchHub.publishUnsafe(() => {
        const prefix = directoryHex(parent)

        return { _tag, path: ownedPath(nameBytes(prefix + (prefix === "2f" ? "" : "2f") + name)) }
      })
    }

    const publishNode = (target: Node) => {
      watchHub.publishManyUnsafe(() => {
        const changes: Array<Change> = []

        if (target === root) {
          changes.push(UpdateChange.make({ path: ownedPath(new Uint8Array([47])) }))
        }

        const pending: Array<readonly [Directory, string]> = [[root, "2f"]]

        while (pending.length > 0) {
          const next = pending.pop()

          if (next === undefined) break
          const [directory, prefix] = next

          for (const [name, node] of directory.entries) {
            const path = prefix + name

            if (node === target) {
              changes.push(UpdateChange.make({ path: ownedPath(nameBytes(path)) }))
            }

            if (node.kind === "directory") pending.push([node, path + "2f"])
          }
        }

        return changes
      })
    }

    const captureSnapshot = Effect.fnUntraced(function*() {
      const ids = new Map<Node, string>([[root, "0"]])
      const pending: Array<Node> = [root]
      const records: Array<Image.Record> = []

      for (let index = 0; index < pending.length; index++) {
        const node = pending[index]

        if (node === undefined) continue
        const id = ids.get(node)

        if (id === undefined) return yield* new ImageError({ code: "InvalidStructure" })
        const metadata = storedMetadata(node.metadata)

        if (node.kind === "directory") {
          const children: Array<{ name: string; target: string }> = []

          for (const [name, child] of node.entries) {
            let target = ids.get(child)

            if (target === undefined) {
              target = String(ids.size)
              ids.set(child, target)
              pending.push(child)
            }

            children.push({ name: Image.base64(nameBytes(name)), target })
          }

          records.push({ id, kind: "directory", metadata, entries: children })
        } else if (node.kind === "file") {
          records.push({ id, kind: "file", metadata, data: Image.base64(node.data.bytes) })
        } else records.push({ id, kind: "symlink", metadata, target: Image.base64(node.target) })
      }

      return yield* Image.capture({ format: "effect-vfs", version: 1, root: "0", records })
    })

    const observeChanges = () => {
      const observation: Array<ObservationEntry> = []
      const paths: Array<readonly [Node, Uint8Array]> = [[root, new Uint8Array([47])]]

      for (let index = 0; index < paths.length; index++) {
        const current = paths[index]

        if (current === undefined) continue
        const [node, path] = current
        observation.push({
          path: new Uint8Array(path),
          lineage: node.lineage,
          kind: node.kind,
          content: node.kind === "file" ? node.data.bytes : node.kind === "symlink" ? node.target : undefined,
          metadata: storedMetadata(node.metadata)
        })

        if (node.kind !== "directory") continue

        for (const [name, child] of node.entries) {
          const bytes = nameBytes(name)
          const childPath = new Uint8Array(path.length + (path.length === 1 ? 0 : 1) + bytes.length)
          childPath.set(path)
          let offset = path.length

          if (path.length !== 1) childPath[offset++] = 47
          childPath.set(bytes, offset)
          paths.push([child, childPath])
        }
      }

      return observation
    }

    const captureState = Effect.fnUntraced(function*(hook?: TestHooks.ObservationHook) {
      const snapshot = yield* captureSnapshot()

      if (hook !== undefined) yield* hook.betweenSnapshotAndSummary

      return { snapshot, observation: observeChanges() }
    })

    const advanceRevision = (node: Node) => {
      node.revision = nextRevision()
    }

    const referenceFor = (node: Node): ObjectReference => {
      if (node.objectReference !== undefined) return node.objectReference
      const reference = Object.freeze({ [ObjectReferenceId]: true as const })
      objectReferences.set(reference, { volume: volumeIdentity, node })
      node.objectReference = reference

      return reference
    }

    const invalidateReference = (node: Node) => {
      const reference = node.objectReference

      if (reference === undefined) return
      const state = objectReferences.get(reference)

      if (state !== undefined) state.node = undefined
      node.objectReference = undefined
    }

    const release = (reference: DirectoryReference) =>
      coordinated(Effect.sync(() => {
        reference.directory = undefined
        reference.closed = true
      }))

    const authorize = (directory: Node, identity: Identity, bits: number, operation: string, path: PathInput) => {
      if (identity.privileged) return Effect.void
      const metadata = directory.metadata

      const shift = metadata.uid === identity.uid ?
        6
        : metadata.gid === identity.gid || identity.groups.includes(metadata.gid)
        ? 3
        : 0

      return ((metadata.mode >> shift) & bits) === bits
        ? Effect.void
        : Effect.fail(failure("AccessDenied", operation, path))
    }

    const reclaim = (file: RegularFile) => {
      if (file.metadata.nlink === 0 && file.openCount === 0) {
        usedBytes -= BigInt(file.data.bytes.length)
        file.data = Content.empty()
        invalidateReference(file)
      }
    }

    const detach = (node: Node, now: bigint) => {
      if (node.kind === "directory") {
        node.parent = undefined
        node.metadata = { ...node.metadata, nlink: 0, ctimeNs: now }
        advanceRevision(node)
        invalidateReference(node)
      } else {
        node.metadata = { ...node.metadata, nlink: node.metadata.nlink - 1, ctimeNs: now }
        advanceRevision(node)

        if (node.kind === "file") reclaim(node)
        else if (node.metadata.nlink === 0) {
          usedBytes -= BigInt(node.target.length)
          invalidateReference(node)
        }
      }
    }

    const releaseFile = (ref: FileReference) => {
      if (ref.file !== undefined) {
        ref.file.openCount -= 1
        reclaim(ref.file)
        ref.file = undefined
      }

      ref.closed = true
    }

    const resize = Effect.fnUntraced(function*(file: RegularFile, length: bigint, operation: string) {
      if (!Schema.is(Schema.BigInt)(length) || length < 0n) return yield* failure("InvalidArgument", operation)

      if (length > BigInt(maxFileBytes)) return yield* failure("FileTooLarge", operation)
      const size = Number(length)

      if (
        settings.maxBytes !== undefined &&
        BigInt(size - file.data.bytes.length) > ByteSize.toBigInt(settings.maxBytes) - usedBytes
      ) {
        return yield* failure("NoSpace", operation)
      }

      const data = new Uint8Array(size)
      data.set(file.data.bytes.subarray(0, size))
      const now = yield* timestamp(operation)
      usedBytes += BigInt(size - file.data.bytes.length)
      file.data = Content.make(data)
      file.metadata = {
        ...file.metadata,
        size: length,
        mode: file.metadata.mode & ~0o6000,
        mtimeNs: now,
        ctimeNs: now
      }
      advanceRevision(file)
      publishNode(file)
    })

    const fileHandle = (ref: FileReference): FileHandle => {
      const get = (operation: string, access?: "read" | "write") =>
        ref.file === undefined || (access === "read" && ref.access === "write") ||
          (access === "write" && ref.access === "read")
          ? Effect.fail(failure("InvalidHandle", operation))
          : Effect.succeed(ref.file)

      const read = Effect.fnUntraced(function*(maximum: number, position?: bigint) {
        const file = yield* get(position === undefined ? "read" : "pread", "read")

        if (!Schema.is(Schema.Natural)(maximum)) return yield* failure("InvalidArgument", "read")
        const offset = position ?? ref.offset

        if (!Schema.is(Schema.BigInt)(offset) || offset < 0n || offset > 0x7fffffffffffffffn) {
          return yield* failure("InvalidArgument", "read")
        }

        const start = Number(offset > file.metadata.size ? file.metadata.size : offset)
        const data = file.data.bytes.slice(start, start + Math.min(maximum, file.data.bytes.length - start))

        if (maximum > 0) {
          file.metadata = { ...file.metadata, atimeNs: (yield* timestamp("read")) }
        }

        if (position === undefined) ref.offset += BigInt(data.length)

        return data
      }, coordinated)

      const write = Effect.fnUntraced(function*(input: Uint8Array, position?: bigint) {
        if (!(input instanceof Uint8Array) || !(input.buffer instanceof ArrayBuffer) || !attachedBuffer(input)) {
          return yield* failure("InvalidArgument", "write")
        }

        const bytes = new Uint8Array(input)

        return yield* coordinated(Effect.gen(function*() {
          const file = yield* get(position === undefined ? "write" : "pwrite", "write")
          const offset = position ?? (ref.append ? file.metadata.size : ref.offset)

          if (!Schema.is(Schema.BigInt)(offset) || offset < 0n || offset > 0x7fffffffffffffffn) {
            return yield* failure("InvalidArgument", "write")
          }

          if (bytes.length === 0) {
            return 0
          }

          if (offset >= BigInt(maxFileBytes)) return yield* failure("FileTooLarge", "write")
          const start = Number(offset)

          const free = settings.maxBytes === undefined
            ? BigInt(maxFileBytes)
            : ByteSize.toBigInt(settings.maxBytes) - usedBytes

          const maximumEnd = BigInt(file.data.bytes.length) + free
          const end = Number(BigInt(maxFileBytes) < maximumEnd ? BigInt(maxFileBytes) : maximumEnd)
          const count = Math.min(bytes.length, Math.max(0, end - start))

          if (count === 0) return yield* failure("NoSpace", "write")
          const size = Math.max(file.data.bytes.length, start + count)
          // Always detach before mutation. A same-sized write is the critical
          // case: the current payload may belong to the base or a prior capture.
          const data = new Uint8Array(size)
          data.set(file.data.bytes)
          const now = yield* timestamp("write")
          data.set(bytes.subarray(0, count), start)
          usedBytes += BigInt(size - file.data.bytes.length)
          file.data = Content.make(data)
          file.metadata = {
            ...file.metadata,
            size: BigInt(size),
            mode: file.metadata.mode & ~0o6000,
            mtimeNs: now,
            ctimeNs: now
          }
          advanceRevision(file)
          publishNode(file)

          if (position === undefined) ref.offset = offset + BigInt(count)

          return count
        }))
      })

      const handle: FileHandle = Object.freeze({
        [FileHandleId]: true as const,
        read: Effect.fn("FileHandle.read")(function*(maximum: number) {
          return yield* read(maximum)
        }),
        pread: Effect.fn("FileHandle.pread")(function*(maximum: number, offset: bigint) {
          return yield* read(maximum, offset)
        }),
        write: Effect.fn("FileHandle.write")(function*(bytes: Uint8Array) {
          return yield* write(bytes)
        }),
        pwrite: Effect.fn("FileHandle.pwrite")(function*(bytes: Uint8Array, offset: bigint) {
          return yield* write(bytes, offset)
        }),
        seek: Effect.fn("FileHandle.seek")(function*(offset: bigint, mode: SeekMode) {
          return yield* coordinated(Effect.gen(function*() {
            const file = yield* get("seek")

            if (!Schema.is(Schema.BigInt)(offset) || !Schema.is(SeekMode)(mode)) {
              return yield* failure("InvalidArgument", "seek")
            }

            let next = mode === "current" ? ref.offset + offset : mode === "end" ? file.metadata.size + offset : offset

            if (next < 0n || next > 0x7fffffffffffffffn) return yield* failure("InvalidArgument", "seek")

            if (mode === "data" || mode === "hole") {
              if (offset >= file.metadata.size) return yield* failure("NoData", "seek")

              if (mode === "hole") next = file.metadata.size
            }

            ref.offset = next

            return next
          }))
        }),
        truncate: Effect.fn("FileHandle.truncate")(function*(length: bigint) {
          return yield* coordinated(Effect.gen(function*() {
            yield* resize(yield* get("truncate", "write"), length, "truncate")
          }))
        }),
        stat: coordinated(Effect.gen(function*() {
          return { ...(yield* get("stat")).metadata }
        })).pipe(Effect.withSpan("FileHandle.stat")),
        sync: coordinated(Effect.suspend(() => Effect.asVoid(get("sync")))).pipe(Effect.withSpan("FileHandle.sync")),
        close: coordinated(Effect.gen(function*() {
          yield* get("close")
          releaseFile(ref)
        })).pipe(Effect.withSpan("FileHandle.close"))
      })

      files.set(handle, ref)

      return handle
    }

    const createCaller = (reference: DirectoryReference, identity: Identity, umask: number): Caller => {
      const referencedNode = Effect.fnUntraced(function*(target: ObjectReference, operation: string) {
        if (reference.directory === undefined) return yield* failure("ClosedCaller", operation)

        if (!Predicate.isObject(target)) return yield* failure("InvalidReference", operation)
        const state = objectReferences.get(target)

        if (state === undefined) return yield* failure("InvalidReference", operation)

        if (state.volume !== volumeIdentity) return yield* failure("ForeignReference", operation)

        if (state.node === undefined) return yield* failure("StaleReference", operation)

        return state.node
      })

      const lookup = Effect.fnUntraced(function*(
        path: PreparedPath,
        base: DirectoryHandle | undefined,
        operation: string,
        options: LookupOptions = {}
      ) {
        const { followFinalSymlink = true, allowMissing = false, parentOnly = false } = options

        if (reference.directory === undefined) return yield* failure("ClosedCaller", operation, path.input)
        let current: Node = path.absolute ? root : reference.directory

        if (!path.absolute && base !== undefined) {
          const target = handles.get(base)

          if (target === undefined) return yield* failure("InvalidHandle", operation, path.input)

          if (target.volume !== volumeIdentity) return yield* failure("ForeignHandle", operation, path.input)

          if (target.directory === undefined) return yield* failure("InvalidHandle", operation, path.input)
          current = target.directory
          yield* authorize(current, identity, 1, operation, path.input)
        }

        if (current.metadata.nlink === 0) return yield* failure("NotFound", operation, path.input)
        let work = path
        let parent: Directory | undefined
        let name: string | undefined
        let traversals = 0

        for (let index = 0; index < work.components.length - (parentOnly ? 1 : 0); index++) {
          if (current.kind !== "directory") return yield* failure("NotDirectory", operation, path.input)
          yield* authorize(current, identity, 1, operation, path.input)
          const component = work.components[index]

          if (component === undefined) break

          if (component === "2e") continue

          if (component === "2e2e") {
            current = current.parent ?? current
            parent = undefined
            name = undefined
            continue
          }

          parent = current
          name = component
          const child = current.entries.get(component)

          if (child === undefined) {
            if (allowMissing && index === work.components.length - 1 && !work.trailingSlash) {
              return { node: undefined, parent, name }
            }

            return yield* failure("NotFound", operation, path.input)
          }

          if (
            child.kind === "symlink" && (followFinalSymlink || index < work.components.length - 1 || work.trailingSlash)
          ) {
            if (child.target.length === 0) return yield* failure("NotFound", operation, path.input)

            if (++traversals > 40) return yield* failure("SymlinkLoop", operation, path.input)
            const suffix = work.suffixes[index] ?? new Uint8Array(0)

            if (
              settings.maxPathBytes !== undefined &&
              ByteSize.isGreaterThan(ByteSize.bytes(child.target.length + suffix.length), settings.maxPathBytes)
            ) {
              return yield* failure("PathTooLong", operation, path.input)
            }

            const expansion = new Uint8Array(child.target.length + suffix.length)
            expansion.set(child.target)
            expansion.set(suffix, child.target.length)
            work = yield* Effect.fromResult(preparePath(ownedPath(expansion), operation, settings.maxPathBytes))

            if (work.absolute) current = root
            index = -1
          } else current = child
        }

        if (!parentOnly && work.trailingSlash && current.kind !== "directory") {
          return yield* failure("NotDirectory", operation, path.input)
        }

        return { node: current, parent, name }
      })

      const resolveNode = Effect.fnUntraced(
        function*(
          path: PreparedPath,
          base: DirectoryHandle | undefined,
          operation: string,
          options?: Pick<LookupOptions, "followFinalSymlink">
        ) {
          const result = yield* lookup(path, base, operation, options)

          if (result.node === undefined) return yield* failure("NotFound", operation, path.input)

          return result.node
        }
      )

      const locate = Effect.fnUntraced(
        function*(
          path: PreparedPath,
          base: DirectoryHandle | undefined,
          operation: string,
          options?: Pick<LookupOptions, "parentOnly">
        ) {
          const result = yield* lookup(path, base, operation, options)
          const node = result.node

          if (node === undefined) return yield* failure("NotFound", operation, path.input)

          if (node.kind !== "directory") return yield* failure("NotDirectory", operation, path.input)

          return node
        }
      )

      const acquireDirectory = Effect.fnUntraced(
        function*(input: PathInput, options: RelativeOptions | undefined, operation: string) {
          const prepared = preparePath(input, operation, settings.maxPathBytes)
          const base = options?.relativeTo
          const acquired: DirectoryReference = { volume: volumeIdentity, directory: undefined, closed: false }
          // Register before retaining a directory. Closed scopes can run this immediately,
          // so registration must not happen while holding the volume permit.
          yield* Effect.addFinalizer(() => release(acquired))

          return yield* coordinated(Effect.gen(function*() {
            if (acquired.closed) return yield* Effect.interrupt
            const path = yield* Effect.fromResult(prepared)
            const directory = yield* locate(path, base, operation)
            yield* authorize(directory, identity, 1, operation, input)
            acquired.directory = directory

            return acquired
          }))
        }
      )

      const list = Effect.fnUntraced(function*(input: PathInput, options?: RelativeOptions) {
        const prepared = preparePath(input, "readDirectory", settings.maxPathBytes)
        const base = options?.relativeTo

        return yield* coordinated(Effect.gen(function*() {
          const directory = yield* locate(yield* Effect.fromResult(prepared), base, "readDirectory")
          yield* authorize(directory, identity, 4, "readDirectory", input)
          const result = [...directory.entries.keys()].map(nameBytes)
          directory.metadata = { ...directory.metadata, atimeNs: (yield* timestamp("readDirectory")) }

          return result
        }))
      })

      const readTarget = Effect.fnUntraced(function*(input: PathInput, options?: RelativeOptions) {
        const prepared = preparePath(input, "readLink", settings.maxPathBytes)
        const base = options?.relativeTo

        return yield* coordinated(Effect.gen(function*() {
          const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "readLink", {
            followFinalSymlink: false
          })

          if (node.kind !== "symlink") return yield* failure("InvalidArgument", "readLink", input)

          return new Uint8Array(node.target)
        }))
      })

      const canonical = Effect.fnUntraced(function*(input: PathInput, options?: RelativeOptions) {
        const prepared = preparePath(input, "realPath", settings.maxPathBytes)
        const base = options?.relativeTo

        return yield* coordinated(Effect.gen(function*() {
          const result = yield* lookup(yield* Effect.fromResult(prepared), base, "realPath")
          const components: Array<string> = []

          if (result.node?.kind !== "directory" && result.name !== undefined) components.push(result.name)
          let directory = result.node?.kind === "directory" ? result.node : result.parent

          while (directory !== undefined && directory.parent !== undefined) {
            const parent: Directory = directory.parent
            const entry = [...parent.entries].find(([, child]) => child === directory)

            if (entry === undefined) return yield* failure("NotFound", "realPath", input)
            components.push(entry[0])
            directory = parent
          }

          return nameBytes("2f" + components.reverse().join("2f"))
        }))
      })

      const metadataNode = Effect.fnUntraced(
        function*(
          target: PathInput | FileHandle | DirectoryHandle,
          options: MetadataOptions | undefined,
          operation: string
        ) {
          if (reference.directory === undefined) return yield* failure("ClosedCaller", operation)

          if (isFileHandle(target) || isDirectoryHandle(target)) {
            const ref = isFileHandle(target) ? files.get(target) : handles.get(target)

            if (ref === undefined) return yield* failure("InvalidHandle", operation)

            if (ref.volume !== volumeIdentity) return yield* failure("ForeignHandle", operation)
            const node = "file" in ref ? ref.file : ref.directory

            if (node === undefined) return yield* failure("InvalidHandle", operation)

            return node
          }

          const path = yield* Effect.fromResult(preparePath(target, operation, settings.maxPathBytes))

          return yield* resolveNode(path, options?.relativeTo, operation, {
            followFinalSymlink: options?.followFinalSymlink !== false
          })
        }
      )

      const permittedMode = (
        metadata: Pick<Metadata, "kind" | "uid" | "gid">,
        mode: number,
        operation: string,
        path?: PathInput
      ) => {
        if (!identity.privileged && identity.uid !== metadata.uid) {
          return Effect.fail(failure("AccessDenied", operation, path))
        }

        const group = identity.gid === metadata.gid || identity.groups.includes(metadata.gid)

        return Effect.succeed(!identity.privileged && metadata.kind === "file" && !group ? mode & ~0o2000 : mode)
      }

      const changeMode = Effect.fnUntraced(
        function*(target: PathInput | FileHandle | DirectoryHandle, mode: number, options?: MetadataOptions) {
          if (!Schema.is(Mode)(mode)) return yield* failure("InvalidArgument", "chmod")
          const chosen = options === undefined ? undefined : { ...options }

          return yield* coordinated(Effect.gen(function*() {
            const node = yield* metadataNode(target, chosen, "chmod")
            const permitted = yield* permittedMode(node.metadata, mode, "chmod")
            node.metadata = {
              ...node.metadata,
              mode: permitted,
              ctimeNs: (yield* timestamp("chmod"))
            }
            advanceRevision(node)
            publishNode(node)
          }))
        }
      )

      const changeOwner = Effect.fnUntraced(
        function*(target: PathInput | FileHandle | DirectoryHandle, owner: OwnerUpdate, options?: MetadataOptions) {
          const decoded = Schema.decodeResult(OwnerUpdate, { onExcessProperty: "error" })(owner)

          if (Result.isFailure(decoded)) return yield* failure("InvalidArgument", "chown")
          const update = { ...decoded.success }
          const chosen = options === undefined ? undefined : { ...options }

          return yield* coordinated(Effect.gen(function*() {
            const node = yield* metadataNode(target, chosen, "chown")

            if (
              !identity.privileged && (identity.uid !== node.metadata.uid ||
                (update.uid !== undefined && update.uid !== node.metadata.uid) ||
                (update.gid !== undefined && update.gid !== identity.gid && !identity.groups.includes(update.gid)))
            ) {
              return yield* failure("AccessDenied", "chown")
            }

            if (update.uid === undefined && update.gid === undefined) return
            node.metadata = {
              ...node.metadata,
              uid: update.uid ?? node.metadata.uid,
              gid: update.gid ?? node.metadata.gid,
              mode: node.kind === "file" ? node.metadata.mode & ~0o6000 : node.metadata.mode,
              ctimeNs: (yield* timestamp("chown"))
            }
            advanceRevision(node)
            publishNode(node)
          }))
        }
      )

      const changeTimes = Effect.fnUntraced(
        function*(target: PathInput | FileHandle | DirectoryHandle, times: Times, options?: MetadataOptions) {
          const decoded = Schema.decodeResult(Times, { onExcessProperty: "error" })(times)

          if (Result.isFailure(decoded)) return yield* failure("InvalidArgument", "utimes")
          const access = { ...decoded.success.access }
          const modification = { ...decoded.success.modification }
          const chosen = options === undefined ? undefined : { ...options }

          return yield* coordinated(Effect.gen(function*() {
            const node = yield* metadataNode(target, chosen, "utimes")

            if (access.kind === "omit" && modification.kind === "omit") return

            if (!identity.privileged && identity.uid !== node.metadata.uid) {
              if (access.kind !== "now" || modification.kind !== "now") return yield* failure("AccessDenied", "utimes")
              yield* authorize(node, identity, 2, "utimes", "/")
            }

            const now = yield* timestamp("utimes")
            node.metadata = {
              ...node.metadata,
              atimeNs: access.kind === "omit"
                ? node.metadata.atimeNs
                : access.kind === "now"
                ? now
                : access.nanoseconds,
              mtimeNs: modification.kind === "omit"
                ? node.metadata.mtimeNs
                : modification.kind === "now"
                ? now
                : modification.nanoseconds,
              ctimeNs: now
            }
            advanceRevision(node)
            publishNode(node)
          }))
        }
      )

      const authorizeRemoval = (parent: Directory, child: Node, operation: string, input: PathInput) =>
        (parent.metadata.mode & 0o1000) !== 0 && !identity.privileged &&
          identity.uid !== parent.metadata.uid && identity.uid !== child.metadata.uid
          ? Effect.fail(failure("AccessDenied", operation, input))
          : Effect.void

      return Object.freeze({
        [CallerId]: true as const,
        rootReference: coordinated(Effect.gen(function*() {
          if (reference.directory === undefined) return yield* failure("ClosedCaller", "rootReference")

          return referenceFor(root)
        })).pipe(Effect.withSpan("Caller.rootReference")),
        lookupReference: Effect.fn("Caller.lookupReference")(function*(directoryReference, name) {
          if (
            !(name instanceof Uint8Array) || !(name.buffer instanceof ArrayBuffer) || !attachedBuffer(name) ||
            name.length === 0 || name.length > 255 || name.includes(0) || name.includes(47)
          ) return yield* failure("InvalidArgument", "lookupReference")
          const key = Encoding.encodeHex(new Uint8Array(name))

          if (key === "2e" || key === "2e2e") return yield* failure("InvalidArgument", "lookupReference")

          return yield* coordinated(Effect.gen(function*() {
            const directory = yield* referencedNode(directoryReference, "lookupReference")

            if (directory.kind !== "directory") return yield* failure("NotDirectory", "lookupReference")
            yield* authorize(directory, identity, 1, "lookupReference", "/")
            const child = directory.entries.get(key)

            if (child === undefined) return yield* failure("NotFound", "lookupReference")

            return referenceFor(child)
          }))
        }),
        parentReference: Effect.fn("Caller.parentReference")(function*(directoryReference) {
          return yield* coordinated(Effect.gen(function*() {
            const directory = yield* referencedNode(directoryReference, "parentReference")

            if (directory.kind !== "directory") return yield* failure("NotDirectory", "parentReference")
            yield* authorize(directory, identity, 1, "parentReference", "/")

            return referenceFor(directory.parent ?? directory)
          }))
        }),
        observeMetadata: Effect.fn("Caller.observeMetadata")(function*(objectReference) {
          return yield* coordinated(Effect.gen(function*() {
            const node = yield* referencedNode(objectReference, "observeMetadata")

            return Object.freeze({ value: Object.freeze({ ...node.metadata }), revision: node.revision })
          }))
        }),
        observeDirectory: Effect.fn("Caller.observeDirectory")(function*(directoryReference) {
          return yield* coordinated(Effect.gen(function*() {
            const directory = yield* referencedNode(directoryReference, "observeDirectory")

            if (directory.kind !== "directory") return yield* failure("NotDirectory", "observeDirectory")
            yield* authorize(directory, identity, 4, "observeDirectory", "/")

            const value = Object.freeze(
              [...directory.entries].map(([name, node]) =>
                Object.freeze({ name: nameBytes(name), reference: referenceFor(node) })
              )
            )

            return Object.freeze({ value, revision: directory.revision })
          }))
        }),
        readLinkReference: Effect.fn("Caller.readLinkReference")(function*(objectReference) {
          return yield* coordinated(Effect.gen(function*() {
            const node = yield* referencedNode(objectReference, "readLinkReference")

            if (node.kind !== "symlink") return yield* failure("InvalidArgument", "readLinkReference")

            return new Uint8Array(node.target)
          }))
        }),
        openReference: Effect.fn("Caller.openReference")(function*(objectReference) {
          const acquired: FileReference = {
            volume: volumeIdentity,
            file: undefined,
            closed: false,
            offset: 0n,
            access: "read",
            append: false
          }

          yield* Effect.addFinalizer(() => coordinated(Effect.sync(() => releaseFile(acquired))))

          return yield* coordinated(Effect.gen(function*() {
            if (acquired.closed) return yield* Effect.interrupt
            const node = yield* referencedNode(objectReference, "openReference")

            if (node.kind !== "file") return yield* failure("IsDirectory", "openReference")

            if (node.metadata.nlink === 0) return yield* failure("StaleReference", "openReference")
            yield* authorize(node, identity, 4, "openReference", "/")
            node.openCount += 1
            acquired.file = node

            return fileHandle(acquired)
          }))
        }),
        readFile: Effect.fn("Caller.readFile")(function*(input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "readFile", settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(Effect.gen(function*() {
            const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "readFile")

            if (node.kind !== "file") return yield* failure("IsDirectory", "readFile", input)
            yield* authorize(node, identity, 4, "readFile", input)
            const data = new Uint8Array(node.data.bytes)
            node.metadata = { ...node.metadata, atimeNs: (yield* timestamp("readFile")) }

            return data
          }))
        }),
        writeFile: Effect.fn("Caller.writeFile")(
          function*(input: PathInput, bytes: Uint8Array, options: WriteFileOptions) {
            const prepared = preparePath(input, "writeFile", settings.maxPathBytes)

            if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || !attachedBuffer(bytes)) {
              return yield* failure("InvalidArgument", "writeFile", input)
            }

            const captured = new Uint8Array(bytes)
            const { relativeTo: base, ...raw } = options
            const decoded = Schema.decodeResult(WriteFileSettings, { onExcessProperty: "error" })(raw)

            if (Result.isFailure(decoded)) return yield* failure("InvalidArgument", "writeFile", input)
            const chosen = decoded.success

            return yield* coordinated(Effect.gen(function*() {
              const path = yield* Effect.fromResult(prepared)

              if (chosen.create === "exclusive") {
                const exists = yield* Effect.result(lookup(path, base, "writeFile", { followFinalSymlink: false }))

                if (Result.isSuccess(exists)) return yield* failure("AlreadyExists", "writeFile", input)

                if (exists.failure.code !== "NotFound") return yield* exists.failure
              }

              const resolved = yield* lookup(
                path,
                base,
                "writeFile",
                {
                  followFinalSymlink: chosen.replaceFinalSymlink !== true && chosen.followFinalSymlink !== false,
                  allowMissing: chosen.create === "ifMissing" || chosen.create === "exclusive"
                }
              )

              const { name, parent } = resolved

              if (parent === undefined || name === undefined || resolved.node?.kind === "directory") {
                return yield* failure("IsDirectory", "writeFile", input)
              }

              const replaced = resolved.node?.kind === "symlink" ? resolved.node : undefined

              if (replaced !== undefined && !chosen.replaceFinalSymlink) {
                return yield* failure("SymlinkLoop", "writeFile", input)
              }

              if (chosen.access === "read") return yield* failure("InvalidHandle", "writeFile", input)
              const file = resolved.node?.kind === "file" ? resolved.node : undefined

              if (file === undefined) {
                yield* authorize(parent, identity, 3, "writeFile", input)

                if (replaced !== undefined) yield* authorizeRemoval(parent, replaced, "writeFile", input)

                if (replaced === undefined && settings.maxEntries !== undefined && entries >= settings.maxEntries) {
                  return yield* failure("NoSpace", "writeFile", input)
                }
              } else yield* authorize(file, identity, chosen.access === "readWrite" ? 6 : 2, "writeFile", input)

              const finalMode = chosen.finalMode === undefined ? undefined : yield* permittedMode(
                file?.metadata ?? { kind: "file", uid: identity.uid, gid: parent.metadata.gid },
                chosen.finalMode,
                "writeFile",
                input
              )

              const previous = file?.data.bytes.length ?? 0
              const initial = chosen.truncate ? 0 : previous
              const position = chosen.append ? initial : 0
              const size = Math.max(initial, position + captured.length)

              if (size > maxFileBytes) return yield* failure("FileTooLarge", "writeFile", input)
              const reclaimed = replaced !== undefined && replaced.metadata.nlink === 1 ? replaced.target.length : 0

              if (
                settings.maxBytes !== undefined &&
                BigInt(size - previous) > ByteSize.toBigInt(settings.maxBytes) - usedBytes + BigInt(reclaimed)
              ) {
                return yield* failure("NoSpace", "writeFile", input)
              }

              if (file !== undefined && !chosen.truncate && captured.length === 0 && chosen.finalMode === undefined) {
                return
              }

              let data = captured

              if (position !== 0 || size !== captured.length) {
                data = new Uint8Array(size)

                if (file !== undefined && !chosen.truncate) data.set(file.data.bytes)
                data.set(captured, position)
              }

              const now = yield* timestamp("writeFile")

              const node: RegularFile = file ??
                {
                  kind: "file",
                  lineage: undefined,
                  data: Content.make(data),
                  openCount: 0,
                  metadata: {
                    ...directoryMetadata(
                      nextInode++,
                      identity.uid,
                      parent.metadata.gid,
                      (chosen.mode ?? 0o666) & 0o777 & ~umask,
                      now
                    ),
                    kind: "file",
                    nlink: 1
                  },
                  revision: nextRevision(),
                  objectReference: undefined
                }

              node.data = Content.make(data)
              node.metadata = {
                ...node.metadata,
                mode: finalMode ?? node.metadata.mode & ~0o6000,
                size: BigInt(size),
                mtimeNs: now,
                ctimeNs: now
              }
              advanceRevision(node)
              usedBytes += BigInt(size - previous)

              if (file === undefined) {
                if (replaced !== undefined) detach(replaced, now)
                parent.entries.set(name, node)
                parent.metadata = { ...parent.metadata, mtimeNs: now, ctimeNs: now }
                advanceRevision(parent)

                if (replaced === undefined) entries += 1
                publishEntry(replaced === undefined ? "Create" : "Update", parent, name)
              } else publishNode(node)
            }))
          }
        ),
        chmod: Effect.fn("Caller.chmod")(function*(path: PathInput, mode: number, options?: MetadataOptions) {
          yield* changeMode(path, mode, options)
        }),
        chmodHandle: Effect.fn("Caller.chmodHandle")(function*(handle: FileHandle | DirectoryHandle, mode: number) {
          yield* changeMode(handle, mode)
        }),
        chown: Effect.fn("Caller.chown")(function*(path: PathInput, owner: OwnerUpdate, options?: MetadataOptions) {
          yield* changeOwner(path, owner, options)
        }),
        chownHandle: Effect.fn("Caller.chownHandle")(
          function*(handle: FileHandle | DirectoryHandle, owner: OwnerUpdate) {
            yield* changeOwner(handle, owner)
          }
        ),
        utimes: Effect.fn("Caller.utimes")(function*(path: PathInput, times: Times, options?: MetadataOptions) {
          yield* changeTimes(path, times, options)
        }),
        utimesHandle: Effect.fn("Caller.utimesHandle")(function*(handle: FileHandle | DirectoryHandle, times: Times) {
          yield* changeTimes(handle, times)
        }),
        access: Effect.fn("Caller.access")(function*(input: PathInput, bits = 0, options?: RelativeOptions) {
          const prepared = preparePath(input, "access", settings.maxPathBytes)
          const base = options?.relativeTo

          if (!Number.isInteger(bits) || bits < 0 || bits > 7) return yield* failure("InvalidArgument", "access", input)

          return yield* coordinated(Effect.gen(function*() {
            const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "access")

            if (node.kind === "file" && (bits & 1) !== 0 && (node.metadata.mode & 0o111) === 0) {
              return yield* failure("AccessDenied", "access", input)
            }

            yield* authorize(node, identity, bits, "access", input)
          }))
        }),
        truncate: Effect.fn("Caller.truncate")(function*(input: PathInput, length: bigint, options?: RelativeOptions) {
          const prepared = preparePath(input, "truncate", settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(Effect.gen(function*() {
            const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "truncate")

            if (node.kind !== "file") return yield* failure("IsDirectory", "truncate", input)
            yield* authorize(node, identity, 2, "truncate", input)
            yield* resize(node, length, "truncate")
          }))
        }),
        lstat: Effect.fn("Caller.lstat")(function*(input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "lstat", settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(Effect.gen(function*() {
            const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "lstat", {
              followFinalSymlink: false
            })

            return { ...node.metadata }
          }))
        }),
        link: Effect.fn("Caller.link")(
          function*(
            source: PathInput,
            destination: PathInput,
            options?: {
              readonly sourceRelativeTo?: DirectoryHandle
              readonly destinationRelativeTo?: DirectoryHandle
              readonly followSourceSymlink?: boolean
            }
          ) {
            const a = preparePath(source, "link", settings.maxPathBytes)
            const b = preparePath(destination, "link", settings.maxPathBytes)
            const sourceBase = options?.sourceRelativeTo
            const destinationBase = options?.destinationRelativeTo
            const follow = options?.followSourceSymlink ?? false

            return yield* coordinated(Effect.gen(function*() {
              const node = yield* resolveNode(yield* Effect.fromResult(a), sourceBase, "link", {
                followFinalSymlink: follow
              })

              if (node.kind === "directory") return yield* failure("IsDirectory", "link", source)
              const path = yield* Effect.fromResult(b)
              const parent = yield* locate(path, destinationBase, "link", { parentOnly: true })
              yield* authorize(parent, identity, 3, "link", destination)
              const name = path.components.at(-1)

              if (name === undefined || name === "2e" || name === "2e2e" || parent.entries.has(name)) {
                return yield* failure("AlreadyExists", "link", destination)
              }

              if (path.trailingSlash) return yield* failure("NotDirectory", "link", destination)

              if (settings.maxEntries !== undefined && entries >= settings.maxEntries) {
                return yield* failure("NoSpace", "link", destination)
              }

              const now = yield* timestamp("link")
              parent.entries.set(name, node)
              parent.metadata = { ...parent.metadata, mtimeNs: now, ctimeNs: now }
              node.metadata = { ...node.metadata, nlink: node.metadata.nlink + 1, ctimeNs: now }
              advanceRevision(parent)
              advanceRevision(node)
              entries += 1
              publishEntry("Create", parent, name)
            }))
          }
        ),
        symlink: Effect.fn("Caller.symlink")(function*(target: PathInput, input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "symlink", settings.maxPathBytes)

          if (Schema.is(Schema.String)(target) && !wellFormed(target)) {
            return yield* failure("InvalidPathEncoding", "symlink", target)
          }

          const rawTarget = Schema.is(Schema.String)(target)
            ? new TextEncoder().encode(target)
            : getBytePathBytes(target)

          if (rawTarget === undefined || rawTarget.includes(0)) {
            return yield* failure("InvalidArgument", "symlink", target)
          }

          const targetBytes = new Uint8Array(rawTarget)
          const base = options?.relativeTo

          return yield* coordinated(Effect.gen(function*() {
            const path = yield* Effect.fromResult(prepared)
            const bytes = targetBytes
            const parent = yield* locate(path, base, "symlink", { parentOnly: true })
            yield* authorize(parent, identity, 3, "symlink", input)
            const name = path.components.at(-1)

            if (name === undefined || name === "2e" || name === "2e2e" || parent.entries.has(name)) {
              return yield* failure("AlreadyExists", "symlink", input)
            }

            if (path.trailingSlash) return yield* failure("NotDirectory", "symlink", input)

            if (
              (settings.maxEntries !== undefined && entries >= settings.maxEntries) ||
              (settings.maxBytes !== undefined &&
                BigInt(bytes.length) > ByteSize.toBigInt(settings.maxBytes) - usedBytes)
            ) return yield* failure("NoSpace", "symlink", input)
            const now = yield* timestamp("symlink")

            const node: SymbolicLink = {
              kind: "symlink",
              lineage: undefined,
              target: new Uint8Array(bytes),
              metadata: {
                ...directoryMetadata(nextInode, identity.uid, parent.metadata.gid, 0o777, now),
                kind: "symlink",
                nlink: 1,
                size: BigInt(bytes.length)
              },
              revision: nextRevision(),
              objectReference: undefined
            }

            parent.entries.set(name, node)
            parent.metadata = { ...parent.metadata, mtimeNs: now, ctimeNs: now }
            advanceRevision(parent)
            nextInode += 1n
            entries += 1
            usedBytes += BigInt(bytes.length)
            publishEntry("Create", parent, name)
          }))
        }),
        readDirectoryBytes: Effect.fn("Caller.readDirectoryBytes")(
          function*(input: PathInput, options?: RelativeOptions) {
            return yield* list(input, options)
          }
        ),
        readDirectory: Effect.fn("Caller.readDirectory")(function*(input: PathInput, options?: RelativeOptions) {
          return yield* Effect.forEach(yield* list(input, options), (bytes) => strictString(bytes, "readDirectory"))
        }),
        readLinkBytes: Effect.fn("Caller.readLinkBytes")(function*(input: PathInput, options?: RelativeOptions) {
          return yield* readTarget(input, options)
        }),
        readLink: Effect.fn("Caller.readLink")(function*(input: PathInput, options?: RelativeOptions) {
          return yield* strictString(yield* readTarget(input, options), "readLink")
        }),
        realPathBytes: Effect.fn("Caller.realPathBytes")(function*(input: PathInput, options?: RelativeOptions) {
          return ownedPath(yield* canonical(input, options))
        }),
        realPath: Effect.fn("Caller.realPath")(function*(input: PathInput, options?: RelativeOptions) {
          return yield* strictString(yield* canonical(input, options), "realPath")
        }),
        open: Effect.fn("Caller.open")(function*(input: PathInput, options: OpenOptions) {
          const prepared = preparePath(input, "open", settings.maxPathBytes)
          const { relativeTo: base, ...raw } = options
          const decoded = Schema.decodeResult(OpenSettings, { onExcessProperty: "error" })(raw)

          if (Result.isFailure(decoded)) return yield* failure("InvalidArgument", "open", input)
          const chosen = { ...decoded.success }

          if (chosen.access === "read" && (chosen.append || chosen.truncate)) {
            return yield* failure("InvalidArgument", "open", input)
          }

          if (chosen.mode !== undefined && (chosen.create === undefined || chosen.create === "never")) {
            return yield* failure("InvalidArgument", "open", input)
          }

          const acquired: FileReference = {
            volume: volumeIdentity,
            file: undefined,
            closed: false,
            offset: 0n,
            access: chosen.access,
            append: chosen.append ?? false
          }

          yield* Effect.addFinalizer(() => coordinated(Effect.sync(() => releaseFile(acquired))))

          return yield* coordinated(Effect.gen(function*() {
            if (acquired.closed) return yield* Effect.interrupt
            const path = yield* Effect.fromResult(prepared)

            if (chosen.create === "exclusive") {
              const existing = yield* Effect.result(lookup(path, base, "open", { followFinalSymlink: false }))

              if (Result.isSuccess(existing)) return yield* failure("AlreadyExists", "open", input)

              if (existing.failure.code !== "NotFound") return yield* existing.failure
            }

            const resolved = yield* lookup(
              path,
              base,
              "open",
              {
                followFinalSymlink: chosen.followFinalSymlink !== false,
                allowMissing: chosen.create === "ifMissing" || chosen.create === "exclusive"
              }
            )

            const parent = resolved.parent

            if (parent === undefined) return yield* failure("IsDirectory", "open", input)
            const name = resolved.name

            if (name === undefined || name === "2e" || name === "2e2e") {
              return yield* failure("IsDirectory", "open", input)
            }

            yield* authorize(parent, identity, 1, "open", input)
            let file = resolved.node

            if (file !== undefined && chosen.create === "exclusive") {
              return yield* failure("AlreadyExists", "open", input)
            }

            if (file === undefined) {
              if (chosen.create === undefined || chosen.create === "never" || path.trailingSlash) {
                return yield* failure("NotFound", "open", input)
              }

              yield* authorize(parent, identity, 3, "open", input)

              if (settings.maxEntries !== undefined && entries >= settings.maxEntries) {
                return yield* failure("NoSpace", "open", input)
              }

              const now = yield* timestamp("open")
              file = {
                kind: "file",
                lineage: undefined,
                data: Content.empty(),
                openCount: 0,
                metadata: {
                  ...directoryMetadata(
                    nextInode,
                    identity.uid,
                    parent.metadata.gid,
                    (chosen.mode ?? 0o666) & 0o777 & ~umask,
                    now
                  ),
                  kind: "file",
                  nlink: 1
                },
                revision: nextRevision(),
                objectReference: undefined
              }
              parent.entries.set(name, file)
              parent.metadata = { ...parent.metadata, mtimeNs: now, ctimeNs: now }
              advanceRevision(parent)
              entries += 1
              nextInode += 1n
              publishEntry("Create", parent, name)
            } else {
              if (file.kind === "symlink") return yield* failure("SymlinkLoop", "open", input)

              if (file.kind !== "file") return yield* failure("IsDirectory", "open", input)

              if (path.trailingSlash) return yield* failure("NotDirectory", "open", input)
              yield* authorize(
                file,
                identity,
                chosen.access === "read" ? 4 : chosen.access === "write" ? 2 : 6,
                "open",
                input
              )

              if (chosen.truncate) yield* resize(file, 0n, "open")
            }

            file.openCount += 1
            acquired.file = file

            return fileHandle(acquired)
          }))
        }),
        unlink: Effect.fn("Caller.unlink")(function*(input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "unlink", settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(Effect.gen(function*() {
            const path = yield* Effect.fromResult(prepared)
            const parent = yield* locate(path, base, "unlink", { parentOnly: true })
            yield* authorize(parent, identity, 3, "unlink", input)
            const name = path.components.at(-1)

            if (name === undefined || name === "2e" || name === "2e2e") {
              return yield* failure("IsDirectory", "unlink", input)
            }

            const child = parent.entries.get(name)

            if (child === undefined) return yield* failure("NotFound", "unlink", input)

            if (child.kind === "directory") return yield* failure("IsDirectory", "unlink", input)

            if (path.trailingSlash) return yield* failure("NotDirectory", "unlink", input)
            yield* authorizeRemoval(parent, child, "unlink", input)
            const now = yield* timestamp("unlink")
            parent.entries.delete(name)
            parent.metadata = { ...parent.metadata, mtimeNs: now, ctimeNs: now }
            advanceRevision(parent)
            detach(child, now)
            entries -= 1
            publishEntry("Remove", parent, name)
          }))
        }),
        rename: Effect.fn("Caller.rename")(function*(
          source: PathInput,
          destination: PathInput,
          options?: { readonly sourceRelativeTo?: DirectoryHandle; readonly destinationRelativeTo?: DirectoryHandle }
        ) {
          const oldPrepared = preparePath(source, "rename", settings.maxPathBytes)
          const newPrepared = preparePath(destination, "rename", settings.maxPathBytes)
          const oldBase = options?.sourceRelativeTo
          const newBase = options?.destinationRelativeTo

          return yield* coordinated(Effect.gen(function*() {
            const oldPath = yield* Effect.fromResult(oldPrepared)
            const newPath = yield* Effect.fromResult(newPrepared)
            const oldParent = yield* locate(oldPath, oldBase, "rename", { parentOnly: true })
            const newParent = yield* locate(newPath, newBase, "rename", { parentOnly: true })
            yield* authorize(oldParent, identity, 3, "rename", source)
            yield* authorize(newParent, identity, 3, "rename", destination)
            const oldName = oldPath.components.at(-1)
            const newName = newPath.components.at(-1)

            if (
              oldName === undefined || newName === undefined || oldName === "2e" || oldName === "2e2e" ||
              newName === "2e" || newName === "2e2e"
            ) {
              return yield* failure("InvalidArgument", "rename", source)
            }

            const child = oldParent.entries.get(oldName)

            if (child === undefined) return yield* failure("NotFound", "rename", source)
            const replaced = newParent.entries.get(newName)

            if (newPath.trailingSlash && replaced === undefined) {
              return yield* failure("NotFound", "rename", destination)
            }

            if (oldPath.trailingSlash && child.kind !== "directory") {
              return yield* failure("NotDirectory", "rename", source)
            }

            if (newPath.trailingSlash && replaced?.kind !== "directory") {
              return yield* failure("NotDirectory", "rename", destination)
            }

            if (child === replaced) return
            yield* authorizeRemoval(oldParent, child, "rename", source)

            if (replaced !== undefined) {
              yield* authorizeRemoval(newParent, replaced, "rename", destination)

              if (child.kind === "directory" && replaced.kind !== "directory") {
                return yield* failure("NotDirectory", "rename", destination)
              }

              if (child.kind !== "directory" && replaced.kind === "directory") {
                return yield* failure("IsDirectory", "rename", destination)
              }

              if (replaced.kind === "directory" && replaced.entries.size > 0) {
                return yield* failure("NotEmpty", "rename", destination)
              }
            }

            for (let ancestor: Directory | undefined = newParent; ancestor !== undefined; ancestor = ancestor.parent) {
              if (ancestor === child) return yield* failure("InvalidArgument", "rename", destination)
            }

            const now = yield* timestamp("rename")

            // All rejection checks precede namespace, ancestry, quota, and metadata publication.
            const oldEvent = () =>
              ownedPath(nameBytes(directoryHex(oldParent) + (oldParent === root ? "" : "2f") + oldName))

            oldParent.entries.delete(oldName)
            newParent.entries.set(newName, child)

            if (child.kind === "directory") child.parent = newParent
            oldParent.metadata = {
              ...oldParent.metadata,
              nlink: oldParent.metadata.nlink - (child.kind === "directory" ? 1 : 0),
              mtimeNs: now,
              ctimeNs: now
            }
            newParent.metadata = {
              ...newParent.metadata,
              nlink: newParent.metadata.nlink + (child.kind === "directory" && replaced === undefined ? 1 : 0),
              mtimeNs: now,
              ctimeNs: now
            }
            child.metadata = { ...child.metadata, ctimeNs: now }
            advanceRevision(oldParent)

            if (newParent !== oldParent) advanceRevision(newParent)
            advanceRevision(child)

            if (replaced !== undefined) {
              detach(replaced, now)
              entries -= 1
            }

            watchHub.publishUnsafe(() => ({ _tag: "Remove" as const, path: oldEvent() }))
            publishEntry("Create", newParent, newName)
          }))
        }),
        rmdir: Effect.fn("Caller.rmdir")(function*(input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "rmdir", settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(Effect.gen(function*() {
            const path = yield* Effect.fromResult(prepared)
            const parent = yield* locate(path, base, "rmdir", { parentOnly: true })
            yield* authorize(parent, identity, 3, "rmdir", input)
            const name = path.components.at(-1)

            if (name === undefined || name === "2e" || name === "2e2e") {
              return yield* failure("InvalidArgument", "rmdir", input)
            }

            const child = parent.entries.get(name)

            if (child === undefined) return yield* failure("NotFound", "rmdir", input)
            yield* authorizeRemoval(parent, child, "rmdir", input)

            if (child.kind !== "directory") return yield* failure("NotDirectory", "rmdir", input)

            if (child.entries.size > 0) return yield* failure("NotEmpty", "rmdir", input)
            const now = yield* timestamp("rmdir")
            parent.entries.delete(name)
            parent.metadata = { ...parent.metadata, nlink: parent.metadata.nlink - 1, mtimeNs: now, ctimeNs: now }
            child.parent = undefined
            child.metadata = { ...child.metadata, nlink: 0, ctimeNs: now }
            advanceRevision(parent)
            advanceRevision(child)
            invalidateReference(child)
            entries -= 1
            publishEntry("Remove", parent, name)
          }))
        }),
        stat: Effect.fn("Caller.stat")(function*(input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "stat", settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(Effect.gen(function*() {
            const path = yield* Effect.fromResult(prepared)
            const directory = yield* resolveNode(path, base, "stat")

            return { ...directory.metadata }
          }))
        }),
        mkdir: Effect.fn("Caller.mkdir")(
          function*(input: PathInput, options?: RelativeOptions & { readonly mode?: number }) {
            const prepared = preparePath(input, "mkdir", settings.maxPathBytes)
            const base = options?.relativeTo
            const mode = options?.mode === undefined ? 0o777 : options.mode

            if (!Schema.is(Mode)(mode)) return yield* failure("InvalidArgument", "mkdir", input)

            return yield* coordinated(Effect.gen(function*() {
              const path = yield* Effect.fromResult(prepared)
              const parent = yield* locate(path, base, "mkdir", { parentOnly: true })
              yield* authorize(parent, identity, 3, "mkdir", input)
              const name = path.components.at(-1)

              if (name === undefined || name === "2e" || name === "2e2e" || parent.entries.has(name)) {
                return yield* failure("AlreadyExists", "mkdir", input)
              }

              if (settings.maxEntries !== undefined && entries >= settings.maxEntries) {
                return yield* failure("NoSpace", "mkdir", input)
              }

              const now = yield* timestamp("mkdir")

              const child: Directory = {
                kind: "directory",
                lineage: undefined,
                parent,
                entries: new Map(),
                metadata: directoryMetadata(
                  nextInode,
                  identity.uid,
                  parent.metadata.gid,
                  (mode & 0o777 & ~umask) | (mode & 0o1000),
                  now
                ),
                revision: nextRevision(),
                objectReference: undefined
              }

              const parentMetadata = {
                ...parent.metadata,
                nlink: parent.metadata.nlink + 1,
                mtimeNs: now,
                ctimeNs: now
              }

              // No Effect yield or expected failure between these publication writes.
              parent.entries.set(name, child)
              parent.metadata = parentMetadata
              advanceRevision(parent)
              nextInode += 1n
              entries += 1
              publishEntry("Create", parent, name)
            }))
          }
        ),
        withDirectory: Effect.fn("Caller.withDirectory")(function*(input: PathInput, options?: RelativeOptions) {
          const acquired = yield* acquireDirectory(input, options, "withDirectory")

          return createCaller(acquired, identity, umask)
        }),
        openDirectory: Effect.fn("Caller.openDirectory")(function*(input: PathInput, options?: RelativeOptions) {
          const acquired = yield* acquireDirectory(input, options, "openDirectory")

          const handle: DirectoryHandle = Object.freeze({
            [DirectoryHandleId]: true as const,
            stat: coordinated(Effect.suspend(() =>
              acquired.directory === undefined
                ? Effect.fail(failure("InvalidHandle", "stat"))
                : Effect.succeed({ ...acquired.directory.metadata })
            )).pipe(Effect.withSpan("DirectoryHandle.stat")),
            close: coordinated(Effect.suspend(() => {
              if (acquired.directory === undefined) return Effect.fail(failure("InvalidHandle", "close"))
              acquired.directory = undefined
              acquired.closed = true

              return Effect.void
            })).pipe(Effect.withSpan("DirectoryHandle.close"))
          })

          handles.set(handle, acquired)

          return handle
        })
      })
    }

    const baseObservation = Predicate.isTagged("Overlay")(source) ? observeChanges() : undefined

    const publicChange = (change: RawOverlayChange): OverlayChange =>
      Predicate.isTagged("Renamed")(change)
        ? OverlayChange.make({
          ...change,
          from: ownedPath(new Uint8Array(change.from)),
          to: ownedPath(new Uint8Array(change.to))
        })
        : OverlayChange.make({ ...change, path: ownedPath(new Uint8Array(change.path)) })

    const publicChanges = (changes: ReadonlyArray<RawOverlayChange>): ReadonlyArray<OverlayChange> =>
      Object.freeze(changes.map(publicChange))

    const changeOptions = (options?: OverlayChangesOptions) => {
      const decoded = decodeConfiguration(OverlayChangesOptions, options === undefined ? {} : options)

      return Result.isFailure(decoded) ? Effect.fail(decoded.failure) : Effect.succeed(decoded.success)
    }

    const volume: Volume = Object.freeze({
      [VolumeId]: true as const,
      watch: Effect.gen(function*() {
        const hook = TestHooks.getRegistrationHook(volume)

        return yield* watchHub.subscribe(hook?.afterSubscribe)
      }).pipe(Effect.withSpan("Volume.watch")),
      snapshot: coordinated(captureSnapshot()).pipe(Effect.withSpan("Volume.snapshot")),

      caller: Effect.fn("Volume.caller")(function*(options?: RootCallerOptions) {
        const decoded = decodeConfiguration(RootCallerOptions, options === undefined ? {} : options)

        if (Result.isFailure(decoded)) return yield* decoded.failure
        const chosen = decoded.success.identity ?? { uid: 0, gid: 0, groups: [], privileged: true }
        const identity = Object.freeze({ ...chosen, groups: Object.freeze([...chosen.groups]) })

        return createCaller(
          { volume: volumeIdentity, directory: root, closed: false },
          identity,
          decoded.success.umask ?? 0o022
        )
      })
    })

    if (!Predicate.isTagged("Overlay")(source) || baseObservation === undefined) {
      return VolumeResult.Volume({ volume })
    }

    const hook = TestHooks.getObservationHook(source.base)

    const overlay: OverlayVolume = Object.freeze({
      ...volume,
      changes: Effect.fn("OverlayVolume.changes")(function*(options?: OverlayChangesOptions) {
        const selected = yield* changeOptions(options)
        const current = yield* coordinated(Effect.sync(observeChanges))

        return publicChanges(compareOverlay(baseObservation, current, selected.includeTimestamps ?? false))
      }),
      capture: Effect.fn("OverlayVolume.capture")(function*(options?: OverlayChangesOptions) {
        const selected = yield* changeOptions(options)
        const current = yield* coordinated(captureState(hook))

        return Object.freeze({
          snapshot: current.snapshot,
          changes: publicChanges(
            compareOverlay(baseObservation, current.observation, selected.includeTimestamps ?? false)
          )
        })
      })
    })

    return VolumeResult.Overlay({ volume: overlay })
  }
)

/** @internal */
export const make = Effect.fn("VirtualFileSystem.make")(function*(options?: VolumeOptions) {
  const result = yield* makeVolume(VolumeSource.Empty(), options).pipe(Effect.catchTag("ImageError", Effect.die))

  if (Predicate.isTagged("Overlay")(result)) return yield* Effect.die(new Error("empty volume constructed as overlay"))

  return result.volume
})

/** @internal */
export const fromSnapshot = Effect.fn("VirtualFileSystem.fromSnapshot")(
  function*(snapshot: Snapshot, options?: VolumeOptions) {
    const image = yield* Image.inspect(snapshot)
    const result = yield* makeVolume(VolumeSource.Snapshot({ image }), options)

    if (Predicate.isTagged("Overlay")(result)) return yield* new ImageError({ code: "InvalidStructure" })

    return result.volume
  }
)

/** @internal */
export const makeOverlay = Effect.fn("VirtualFileSystem.makeOverlay")(
  function*(base: Snapshot, options?: VolumeOptions): Effect.fn.Return<OverlayVolume, ConfigurationError | ImageError> {
    const image = yield* Image.inspect(base)

    const result = yield* makeVolume(
      VolumeSource.Overlay({ base, image }),
      options
    )

    if (Predicate.isTagged("Volume")(result)) return yield* new ImageError({ code: "InvalidStructure" })

    return result.volume
  }
)
