// Runtime definitions and cohesive live virtual filesystem engine.
import * as ByteSize from "effect/ByteSize"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Exit from "effect/Exit"
import * as Order from "effect/Order"
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
  Volume,
  VolumeLimits,
  VolumeUsage
} from "../VirtualFileSystem.js"
import { CanonicalBase64 } from "./canonicalBase64.js"
import { ConfigurationError, decodeConfiguration, FsCode as FsCodeSchema, FsError } from "./errors.js"
import * as Image from "./image.js"
import * as LiveImage from "./liveImage.js"
import * as MetadataDomain from "./metadata.js"
import * as Content from "./overlayContent.js"
import { compareOverlay, type ObservationEntry, type RawOverlayChange } from "./overlayDiff.js"
import {
  DOT_DOT_HEX,
  DOT_HEX,
  inputBytes,
  isAttachedBytes,
  isDotComponent,
  MAX_NAME_BYTES,
  nameBytes,
  ownedPath,
  type PreparedPath,
  preparePath,
  SLASH_BYTE,
  SLASH_HEX,
  strictString
} from "./path.js"
import { type CommitProvider, makeStagedState } from "./stagedState.js"
import * as TestHooks from "./testHooks.js"
import * as WatchHub from "./watchHub.js"

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

// POSIX permission bits, masked against mode once it is shifted to the caller's class.
const EXECUTE = 0o1

const WRITE = 0o2

const READ = 0o4

// Execute for every class; a file with none is not executable by anyone.
const ANY_EXECUTE = 0o111

// setuid and setgid, cleared whenever a file's contents or ownership change.
const SET_ID_BITS = 0o6000

// Sticky: only the owner of an entry or of its directory may remove it.
const STICKY_BIT = 0o1000

// Nodes walked between yields. Whole-tree reads are one synchronous tick otherwise, which
// starves the event loop and leaves nothing for interruption to act on.
// Options for a single path walk; `lookup` is defined per volume, so this lives at module level.
interface LookupOptions {
  readonly followFinalSymlink?: boolean
  readonly allowMissing?: boolean
  readonly parentOnly?: boolean
}

const WALK_YIELD_INTERVAL = 128

// Largest signed 64-bit file offset, as POSIX off_t.
const MAX_FILE_OFFSET = 0x7fffffffffffffffn

const Mode = Schema.Natural.check(Schema.isLessThanOrEqualTo(0o7777))

const isMode = Schema.is(Mode)

const isNatural = Schema.is(Schema.Natural)

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

const Hex128 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))

/** @internal */
export const VolumeDurability = Schema.Literals([
  "memory-only",
  "survives-process-crash",
  "survives-operating-system-crash",
  "survives-power-loss"
])

/** @internal */
export type VolumeDurability = typeof VolumeDurability.Type

const durabilityRank: Readonly<Record<VolumeDurability, number>> = {
  "memory-only": 0,
  "survives-process-crash": 1,
  "survives-operating-system-crash": 2,
  "survives-power-loss": 3
}

/** @internal */
export const VolumeDurabilityOrder: Order.Order<VolumeDurability> = Order.mapInput(
  Order.Number,
  (durability: VolumeDurability) => durabilityRank[durability]
)

/** @internal */
export const isVolumeDurabilityAtLeast = (actual: VolumeDurability, required: VolumeDurability): boolean =>
  VolumeDurabilityOrder(actual, required) >= 0

/** @internal */
export const VolumeIdentity = Hex128.pipe(Schema.brand("@effect-vfs/core/VolumeIdentity"))

/** @internal */
export type VolumeIdentity = typeof VolumeIdentity.Type

/** @internal */
export const VolumeIncarnation = Hex128.pipe(Schema.brand("@effect-vfs/core/VolumeIncarnation"))

/** @internal */
export type VolumeIncarnation = typeof VolumeIncarnation.Type

/** @internal */
export const VolumeOptions = Schema.Struct({
  identity: Schema.optionalKey(VolumeIdentity),
  maxEntries: Schema.optionalKey(Schema.Natural),
  maxPendingOperations: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  maxWatchEvents: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(2))),
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

const isTimestamp = Schema.is(MetadataDomain.Timestamp)

/** @internal */
export const Metadata = Schema.Struct({
  kind: Schema.Literals(["directory", "file", "symlink"]),
  ino: Schema.BigInt,
  nlink: Schema.Natural,
  size: Schema.BigInt,
  uid: Schema.Natural,
  gid: Schema.Natural,
  mode: Mode,
  atimeNs: MetadataDomain.Timestamp,
  mtimeNs: MetadataDomain.Timestamp,
  ctimeNs: MetadataDomain.Timestamp,
  birthtimeNs: MetadataDomain.Timestamp
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
  Schema.Struct({ kind: Schema.Literal("value"), nanoseconds: MetadataDomain.Timestamp })
])

/** @internal */
export const Times = Schema.Struct({ access: TimeUpdate, modification: TimeUpdate })

/** @internal */
export type Times = typeof Times.Type

/** @internal */
export const SeekMode = Schema.Literals(["start", "current", "end", "data", "hole"])

/** @internal */
export type SeekMode = typeof SeekMode.Type

const isSeekMode = Schema.is(SeekMode)

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
export const DirectoryChange = Schema.Struct({
  before: Schema.BigInt,
  after: Schema.BigInt
})

/** @internal */
export const RenameReferenceResult = Schema.TaggedUnion({
  SameDirectory: { directory: DirectoryChange },
  DifferentDirectories: {
    sourceDirectory: DirectoryChange,
    destinationDirectory: DirectoryChange
  }
})

/** @internal */
export const MkdirReferenceSettings = Schema.Struct({
  mode: Schema.optionalKey(Mode),
  exactMode: Schema.optionalKey(Schema.Boolean),
  times: Schema.optionalKey(Times)
})

/** @internal */
export const SymlinkReferenceSettings = Schema.Struct({
  times: Schema.optionalKey(Times)
})

/** @internal */
export const OpenReferenceSettings = Schema.Struct({
  access: Schema.Literals(["read", "write", "readWrite"]),
  append: Schema.optionalKey(Schema.Boolean),
  truncate: Schema.optionalKey(Schema.Boolean)
})

/** @internal */
export const OpenChildReferenceSettings = Schema.Struct({
  ...OpenSettings.fields,
  times: Schema.optionalKey(Times),
  initialSize: Schema.optionalKey(Schema.BigInt),
  exactMode: Schema.optionalKey(Schema.Boolean),
  owner: Schema.optionalKey(OwnerUpdate),
  expectedChild: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    reference: Schema.declare<ObjectReference>((input): input is ObjectReference =>
      Predicate.hasProperty(ObjectReferenceId)(input) && input[ObjectReferenceId] === true
    ),
    revision: Schema.BigInt,
    atimeNs: MetadataDomain.Timestamp,
    mtimeNs: MetadataDomain.Timestamp
  })))
})

const WriteFileSettings = Schema.Struct({
  ...OpenSettings.fields,
  replaceFinalSymlink: Schema.optionalKey(Schema.Boolean),
  finalMode: Schema.optionalKey(Mode)
})

/** @internal */
export type WriteFileOptions = typeof WriteFileSettings.Type & RelativeOptions

const decodeOwnerUpdate = Schema.decodeResult(OwnerUpdate, { onExcessProperty: "error" })

const decodeTimes = Schema.decodeResult(Times, { onExcessProperty: "error" })

const decodeWriteFileSettings = Schema.decodeResult(WriteFileSettings, { onExcessProperty: "error" })

const decodeOpenSettings = Schema.decodeResult(OpenSettings, { onExcessProperty: "error" })

const decodeMkdirReferenceSettings = Schema.decodeResult(MkdirReferenceSettings, { onExcessProperty: "error" })

const decodeSymlinkReferenceSettings = Schema.decodeResult(SymlinkReferenceSettings, { onExcessProperty: "error" })

const decodeOpenReferenceSettings = Schema.decodeResult(OpenReferenceSettings, { onExcessProperty: "error" })

const decodeOpenChildReferenceSettings = Schema.decodeResult(OpenChildReferenceSettings, { onExcessProperty: "error" })

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
export const FixtureMetadata = Schema.Struct({
  uid: Schema.optionalKey(Schema.Natural),
  gid: Schema.optionalKey(Schema.Natural),
  mode: Schema.optionalKey(Mode),
  atimeNs: Schema.optionalKey(MetadataDomain.Timestamp),
  mtimeNs: Schema.optionalKey(MetadataDomain.Timestamp),
  ctimeNs: Schema.optionalKey(MetadataDomain.Timestamp),
  birthtimeNs: Schema.optionalKey(MetadataDomain.Timestamp)
})

const FixturePath = Schema.Union([
  Schema.String,
  BytePath
])

/** @internal */
export const FixtureEntry = Schema.Union([
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
]).pipe(Schema.toTaggedUnion("kind"))

/** @internal */
export const Fixture = Schema.Struct({
  rootMetadata: Schema.optionalKey(FixtureMetadata),
  entries: Schema.Array(FixtureEntry)
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

interface EngineState {
  root: Directory
  retainedFiles: Map<bigint, RegularFile>
  revisionCounter: bigint
  nextInode: bigint
  entries: number
  usedBytes: bigint
}

interface LiveImageCommon {
  ino: bigint
  revision: bigint
  lineage?: string
  metadata: LiveImage.Record["metadata"]
}

interface MutableLiveImageLimits {
  maxEntries?: number
  maxBytes?: bigint
  maxFileBytes?: bigint
  maxPathBytes?: bigint
}

interface RestoredVolumeOptions {
  identity: VolumeIdentity
  maxEntries?: number
  maxBytes?: ByteSize.ByteSize
  maxFileBytes?: ByteSize.ByteSize
  maxPathBytes?: ByteSize.ByteSize
}

/** @internal */
export const captureLiveImage = Effect.fnUntraced(function*(
  state: EngineState,
  identity: VolumeIdentity,
  limits: VolumeLimits
) {
  const records: Array<LiveImage.Record> = []
  const visited = new Set<bigint>()
  const pending: Array<Node> = [state.root, ...state.retainedFiles.values()]

  for (let index = 0; index < pending.length; index++) {
    if (index % WALK_YIELD_INTERVAL === 0) yield* Effect.yieldNow
    const node = pending[index]

    if (node === undefined || visited.has(node.metadata.ino)) continue
    visited.add(node.metadata.ino)

    const common: LiveImageCommon = {
      ino: node.metadata.ino,
      revision: node.revision,
      metadata: {
        ...storedMetadata(node.metadata),
        nlink: node.metadata.nlink,
        size: node.metadata.size
      }
    }

    if (node.lineage !== undefined) common.lineage = node.lineage

    if (node.kind === "directory") {
      const entries: Array<{ name: typeof CanonicalBase64.Encoded.Type; target: bigint }> = []

      for (const [name, child] of node.entries) {
        entries.push({ name: CanonicalBase64.encode(nameBytes(name)), target: child.metadata.ino })
        pending.push(child)
      }

      records.push(LiveImage.Record.cases.directory.make({ ...common, entries }))
    } else if (node.kind === "file") {
      records.push(LiveImage.Record.cases.file.make({ ...common, data: CanonicalBase64.encode(node.data.bytes) }))
    } else {
      records.push(LiveImage.Record.cases.symlink.make({ ...common, target: CanonicalBase64.encode(node.target) }))
    }
  }

  const storedLimits: MutableLiveImageLimits = {}

  if (limits.maxEntries !== undefined) storedLimits.maxEntries = limits.maxEntries

  if (limits.maxBytes !== undefined) storedLimits.maxBytes = ByteSize.toBigInt(limits.maxBytes)

  if (limits.maxFileBytes !== undefined) storedLimits.maxFileBytes = ByteSize.toBigInt(limits.maxFileBytes)

  if (limits.maxPathBytes !== undefined) storedLimits.maxPathBytes = ByteSize.toBigInt(limits.maxPathBytes)

  const document: LiveImage.Document = {
    format: "effect-vfs-live",
    version: 1,
    identity,
    root: state.root.metadata.ino,
    nextInode: state.nextInode,
    revisionCounter: state.revisionCounter,
    entries: state.entries,
    usedBytes: state.usedBytes,
    limits: storedLimits,
    retainedFiles: [...state.retainedFiles.keys()],
    records
  }

  return yield* LiveImage.encode(document)
})

interface ObjectReferenceState {
  readonly volume: symbol
  cell: NodeCell | undefined
  active: boolean
}

interface NodeCell {
  node: Node
}

interface FileReferenceRecord {
  cell: NodeCell | undefined
  closed: boolean
  offset: bigint
}

interface DirectoryReferenceRecord {
  cell: NodeCell | undefined
  closed: boolean
}

interface CandidateContext {
  readonly nodes: Map<Node, Node>
  readonly previous: Map<Node, Node>
  readonly files: Map<FileReference, FileReferenceRecord>
  readonly directories: Map<DirectoryReference, DirectoryReferenceRecord>
  readonly invalidated: Set<ObjectReferenceState>
  readonly events: Array<() => void>
  readonly apply: Array<() => void>
}

const objectReferences = new WeakMap<ObjectReference, ObjectReferenceState>()

const isFileHandle = (value: PathInput | FileHandle | DirectoryHandle): value is FileHandle =>
  Predicate.hasProperty(FileHandleId)(value)

// Only a PathInput target names a path; a handle-based call has none to report in its error.
const pathOf = (target: PathInput | FileHandle | DirectoryHandle): PathInput | undefined =>
  isFileHandle(target) || isDirectoryHandle(target) ? undefined : target

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
  atimeNs: metadata.atimeNs,
  mtimeNs: metadata.mtimeNs,
  ctimeNs: metadata.ctimeNs,
  birthtimeNs: metadata.birthtimeNs
})

type VolumeSource =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Snapshot"; readonly image: Image.Document }
  | { readonly _tag: "Live"; readonly document: LiveImage.Document }
  | {
    readonly _tag: "Overlay"
    readonly base: Snapshot
    readonly image: Image.Document
  }

/** @internal */
export const VolumeSource = Data.taggedEnum<VolumeSource>()

type VolumeFor<S extends VolumeSource> = S extends { readonly _tag: "Overlay" } ? OverlayVolume : Volume

const UpdateChange = Schema.TaggedStruct("Update", { path: BytePath })

const RescanChange = Schema.TaggedStruct("Rescan", { path: BytePath })

// Each execution constructs a fresh volume and captures its Clock.

/** @internal */
export const makeVolume = Effect.fnUntraced(
  function*<S extends VolumeSource>(
    source: S,
    options?: VolumeOptions,
    commitProvider?: CommitProvider<EngineState>,
    captureInitial?: (
      state: EngineState,
      identity: VolumeIdentity,
      limits: VolumeLimits
    ) => Effect.Effect<void, ImageError>
  ) {
    const image = "image" in source ? source.image : undefined
    const live = Predicate.isTagged("Live")(source) ? source.document : undefined
    let restoredOptions = options

    if (live !== undefined) {
      const recovered: RestoredVolumeOptions = { identity: VolumeIdentity.make(live.identity) }

      if (live.limits.maxEntries !== undefined) recovered.maxEntries = live.limits.maxEntries

      if (live.limits.maxBytes !== undefined) recovered.maxBytes = ByteSize.bytes(live.limits.maxBytes)

      if (live.limits.maxFileBytes !== undefined) recovered.maxFileBytes = ByteSize.bytes(live.limits.maxFileBytes)

      if (live.limits.maxPathBytes !== undefined) recovered.maxPathBytes = ByteSize.bytes(live.limits.maxPathBytes)
      restoredOptions = recovered
    }

    const decoded = decodeConfiguration(VolumeOptions, restoredOptions === undefined ? {} : restoredOptions)

    if (Result.isFailure(decoded)) return yield* decoded.failure
    const settings = { ...decoded.success }
    const crypto = yield* Crypto.Crypto

    const identity = settings.identity === undefined
      ? VolumeIdentity.make(Encoding.encodeHex(yield* crypto.randomBytes(16)))
      : VolumeIdentity.make(settings.identity)

    const incarnation = VolumeIncarnation.make(Encoding.encodeHex(yield* crypto.randomBytes(16)))
    const clock = yield* Clock.clockWith(Effect.succeed)
    const initialTime = clock.currentTimeNanosUnsafe()

    if (!isTimestamp(initialTime)) {
      return yield* new ConfigurationError({ field: "clock.currentTimeNanos" })
    }

    const timestamp = (operation: string) =>
      Effect.suspend(() => {
        const now = clock.currentTimeNanosUnsafe()

        return isTimestamp(now)
          ? Effect.succeed(now)
          : Effect.fail(new FsError({ code: "InvalidArgument", operation: operation }))
      })

    const volumeIdentity = Symbol()
    let activeStage: CandidateContext | undefined
    const fileReferences = new Set<FileReference>()
    const directoryReferences = new Set<DirectoryReference>()
    // A capability holds a cell instead of a particular node object. Publication can replace
    // the node behind the cell without replacing the capability held by a caller.
    const cells = new WeakMap<Node, NodeCell>()

    const cellFor = (node: Node): NodeCell => {
      const existing = cells.get(node)

      if (existing !== undefined) return existing
      const previous = activeStage?.previous.get(node)
      const retained = previous === undefined ? undefined : cells.get(previous)

      if (retained !== undefined) {
        cells.set(node, retained)

        return retained
      }

      let current = node

      const cell: NodeCell = {
        get node() {
          return activeStage?.nodes.get(current) ?? current
        },
        set node(next) {
          current = next
        }
      }

      cells.set(node, cell)

      return cell
    }

    const makeFileReference = (access: FileReference["access"], append: boolean): FileReference => {
      const live: FileReferenceRecord = { cell: undefined, closed: false, offset: 0n }
      let reference: FileReference

      const record = () => {
        if (activeStage === undefined) return live
        let staged = activeStage.files.get(reference)

        if (staged === undefined) {
          staged = { ...live }
          activeStage.files.set(reference, staged)
          const pending = staged
          activeStage.apply.push(() => {
            Object.assign(live, pending)

            if (live.cell === undefined) fileReferences.delete(reference)
            else fileReferences.add(reference)
          })
        }

        return staged
      }

      reference = {
        volume: volumeIdentity,
        get file() {
          const node = record().cell?.node

          return node?.kind === "file" ? node : undefined
        },
        set file(file) {
          record().cell = file === undefined ? undefined : cellFor(file)

          if (activeStage === undefined) {
            if (file === undefined) fileReferences.delete(reference)
            else fileReferences.add(reference)
          }
        },
        get closed() {
          return record().closed
        },
        set closed(value) {
          record().closed = value
        },
        get offset() {
          return record().offset
        },
        set offset(value) {
          record().offset = value
        },
        access,
        append
      }

      return reference
    }

    const makeDirectoryReference = (directory?: Directory): DirectoryReference => {
      const live: DirectoryReferenceRecord = {
        cell: directory === undefined ? undefined : cellFor(directory),
        closed: false
      }

      let reference: DirectoryReference

      const record = () => {
        if (activeStage === undefined) return live
        let staged = activeStage.directories.get(reference)

        if (staged === undefined) {
          staged = { ...live }
          activeStage.directories.set(reference, staged)
          const pending = staged
          activeStage.apply.push(() => {
            Object.assign(live, pending)

            if (live.cell === undefined || live.cell.node === state.root) directoryReferences.delete(reference)
            else directoryReferences.add(reference)
          })
        }

        return staged
      }

      reference = {
        volume: volumeIdentity,
        get directory() {
          const node = record().cell?.node

          return node?.kind === "directory" ? node : undefined
        },
        set directory(directory) {
          record().cell = directory === undefined ? undefined : cellFor(directory)

          if (activeStage === undefined) {
            if (directory === undefined || directory === state.root) directoryReferences.delete(reference)
            else directoryReferences.add(reference)
          }
        },
        get closed() {
          return record().closed
        },
        set closed(value) {
          record().closed = value
        }
      }

      if (directory !== undefined && directory !== state.root && activeStage === undefined) {
        directoryReferences.add(reference)
      }

      return reference
    }

    const gate = Semaphore.makeUnsafe(1)
    const maxPendingOperations = settings.maxPendingOperations ?? 64
    let admitted = 0

    const admit = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | FsError, R> =>
      Effect.suspend((): Effect.Effect<A, E | FsError, R> => {
        if (admitted >= maxPendingOperations + 1) {
          return Effect.fail(new FsError({ code: "VolumeBusy", operation }))
        }

        admitted += 1

        return effect.pipe(Effect.ensuring(Effect.sync(() => {
          admitted -= 1
        })))
      })

    let state: EngineState = {
      root: {
        kind: "directory",
        lineage: image?.root,
        parent: undefined,
        entries: new Map(),
        metadata: directoryMetadata(1n, 0, 0, 0o755, initialTime),
        revision: 1n,
        objectReference: undefined
      },
      retainedFiles: new Map(),
      revisionCounter: 1n,
      nextInode: 2n,
      entries: 0,
      usedBytes: 0n
    }

    const nextRevision = () => ++state.revisionCounter

    // The schema caps this value at uint32, so this boundary conversion is exact.
    const maxFileBytes = Number(ByteSize.toBigInt(settings.maxFileBytes ?? ByteSize.bytes(0xffffffff)))

    const limits: VolumeLimits = Object.freeze({
      maxBytes: settings.maxBytes,
      maxFileBytes: ByteSize.bytes(maxFileBytes),
      maxEntries: settings.maxEntries,
      maxPathBytes: settings.maxPathBytes,
      maxPendingOperations: settings.maxPendingOperations ?? 64,
      maxWatchEvents: settings.maxWatchEvents ?? 256
    })

    if (image !== undefined) {
      const incoming = new Map<string, Node>()
      let content = 0n
      let count = 0

      for (const record of image.records) {
        if (Image.Record.guards.directory(record)) count += record.entries.length
        else {
          const length = CanonicalBase64.decodedLength(
            Image.Record.guards.file(record) ? record.data : record.target
          )

          if (Image.Record.guards.file(record) && length > maxFileBytes) {
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
          kind: record._tag,
          ino: record.id === image.root ? 1n : state.nextInode++,
          nlink: Image.Record.guards.directory(record) ? 2 : 0,
          size: 0n,
          atimeNs: record.metadata.atimeNs,
          mtimeNs: record.metadata.mtimeNs,
          ctimeNs: record.metadata.ctimeNs,
          birthtimeNs: record.metadata.birthtimeNs
        }

        if (Image.Record.guards.directory(record)) {
          const node: Directory = record.id === image.root
            ? state.root
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
        } else if (Image.Record.guards.file(record)) {
          const data = baseContents?.get(record.id) ?? Content.make(yield* CanonicalBase64.decode(record.data))
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
          const target = yield* CanonicalBase64.decode(record.target)
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
        if (!Image.Record.guards.directory(record)) continue
        const parent = incoming.get(record.id)

        if (parent?.kind !== "directory") return yield* new ImageError({ code: "InvalidStructure" })

        for (const entry of record.entries) {
          const node = incoming.get(entry.target)

          if (node === undefined) return yield* new ImageError({ code: "InvalidStructure" })
          parent.entries.set(Encoding.encodeHex(yield* CanonicalBase64.decode(entry.name)), node)

          if (node.kind === "directory") {
            node.parent = parent
            parent.metadata = { ...parent.metadata, nlink: parent.metadata.nlink + 1 }
          } else node.metadata = { ...node.metadata, nlink: node.metadata.nlink + 1 }
        }
      }

      state.entries = count
      state.usedBytes = content
    }

    if (live !== undefined) {
      const incoming = new Map<bigint, Node>()

      for (const record of live.records) {
        const metadata: Metadata = {
          ...record.metadata,
          kind: record._tag,
          ino: record.ino
        }

        if (LiveImage.Record.guards.directory(record)) {
          incoming.set(record.ino, {
            kind: "directory",
            lineage: record.lineage,
            parent: undefined,
            entries: new Map(),
            metadata,
            revision: record.revision,
            objectReference: undefined
          })
        } else if (LiveImage.Record.guards.file(record)) {
          incoming.set(record.ino, {
            kind: "file",
            lineage: record.lineage,
            data: Content.make(yield* CanonicalBase64.decode(record.data)),
            openCount: 0,
            metadata,
            revision: record.revision,
            objectReference: undefined
          })
        } else {
          incoming.set(record.ino, {
            kind: "symlink",
            lineage: record.lineage,
            target: yield* CanonicalBase64.decode(record.target),
            metadata,
            revision: record.revision,
            objectReference: undefined
          })
        }
      }

      for (const record of live.records) {
        if (!LiveImage.Record.guards.directory(record)) continue
        const parent = incoming.get(record.ino)

        if (parent?.kind !== "directory") return yield* new ImageError({ code: "InvalidStructure" })

        for (const entry of record.entries) {
          const child = incoming.get(entry.target)

          if (child === undefined) return yield* new ImageError({ code: "InvalidStructure" })
          parent.entries.set(Encoding.encodeHex(yield* CanonicalBase64.decode(entry.name)), child)

          if (child.kind === "directory") child.parent = parent
        }
      }

      const root = incoming.get(live.root)

      if (root?.kind !== "directory") return yield* new ImageError({ code: "InvalidStructure" })
      state.root = root
      state.nextInode = live.nextInode
      state.revisionCounter = live.revisionCounter
      state.entries = live.entries
      state.usedBytes = live.usedBytes

      // A previous process's handles no longer exist. Their zero-link files
      // remain in the stored image but are reclaimed from this runtime state.
      for (const ino of live.retainedFiles) {
        const orphan = incoming.get(ino)

        if (orphan?.kind !== "file") return yield* new ImageError({ code: "InvalidStructure" })
        state.usedBytes -= BigInt(orphan.data.bytes.length)
      }
    }

    if (captureInitial !== undefined) yield* captureInitial(state, identity, limits)

    const contexts = new WeakMap<EngineState, CandidateContext>()

    const copyState = (current: EngineState) =>
      Effect.sync(() => {
        const nodes = new Map<Node, Node>()

        const copyDirectory = (node: Directory): Directory => {
          const existing = nodes.get(node)

          if (existing?.kind === "directory") return existing
          const copy: Directory = { ...node, entries: new Map(), metadata: { ...node.metadata }, parent: undefined }
          nodes.set(node, copy)
          copy.parent = node.parent === undefined ? undefined : copyDirectory(node.parent)

          for (const [name, child] of node.entries) copy.entries.set(name, copyNode(child))

          return copy
        }

        const copyNode = (node: Node): Node => {
          if (node.kind === "directory") return copyDirectory(node)
          const existing = nodes.get(node)

          if (existing !== undefined) return existing
          const copy = { ...node, metadata: { ...node.metadata } }
          nodes.set(node, copy)

          return copy
        }

        const candidate: EngineState = { ...current, root: copyDirectory(current.root), retainedFiles: new Map() }

        for (const [ino, file] of current.retainedFiles) {
          const copy = copyNode(file)

          if (copy.kind === "file") candidate.retainedFiles.set(ino, copy)
        }

        // Open resources keep zero-link objects alive after the namespace stops reaching them.
        for (const reference of fileReferences) {
          const file = reference.file

          if (file !== undefined) copyNode(file)
        }

        for (const reference of directoryReferences) {
          const directory = reference.directory

          if (directory !== undefined) copyDirectory(directory)
        }

        contexts.set(candidate, {
          nodes,
          previous: new Map([...nodes].map(([prior, next]) => [next, prior])),
          files: new Map(),
          directories: new Map(),
          invalidated: new Set(),
          events: [],
          apply: []
        })

        return candidate
      })

    const staged = commitProvider === undefined ? undefined : makeStagedState<EngineState, () => void>(
      state,
      copyState,
      commitProvider,
      (candidate, events) => {
        const context = contexts.get(candidate)

        if (context === undefined) throw new Error("Missing staged engine state")
        state = candidate

        for (const [previous, next] of context.nodes) {
          const cell = cells.get(previous)

          if (cell !== undefined) {
            cell.node = next
            cells.set(next, cell)
          }
        }

        for (const apply of context.apply) apply()

        for (const reference of context.invalidated) {
          reference.active = false
          reference.cell = undefined
        }

        for (const event of events) event()
      }
    )

    if (staged !== undefined) commitProvider?.onReady?.(staged.shutdown)

    // Permit waits stay interruptible. Changes and their publication run under one permit.
    const coordinated = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>, onStorageFailure?: () => void) =>
      admit(
        operation,
        staged === undefined
          ? gate.withPermit(Effect.uninterruptible(effect))
          : staged.mutate(operation, (candidate, emit) =>
            Effect.gen(function*() {
              const previous = state
              const context = contexts.get(candidate)

              if (context === undefined) return yield* Effect.die("Missing staged engine state")
              state = candidate
              activeStage = context
              const result = yield* Effect.exit(effect)
              state = previous
              activeStage = undefined

              if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)

              for (const event of context.events) emit(event)

              return result.value
            }), onStorageFailure)
      )

    // Pure observations share the permit without making a candidate or calling the provider.
    const coordinatedRead = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
      admit(operation, staged === undefined ? gate.withPermit(effect) : staged.read(operation, () => effect))

    const coordinatedCleanup = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      staged === undefined
        ? gate.withPermit(Effect.uninterruptible(effect))
        : staged.coordinate(Effect.uninterruptible(effect))

    const watchCoordinate: WatchHub.Coordinator = (effect) =>
      staged === undefined ? gate.withPermit(effect) : staged.coordinate(effect)

    const watchHub = yield* WatchHub.make<Change, FsError>(
      watchCoordinate,
      settings.maxWatchEvents ?? 256,
      () => RescanChange.make({ path: ownedPath(new Uint8Array([47])) }),
      staged?.checkAvailable("watch")
    )

    const queuePublish = (publish: () => void) => {
      if (activeStage === undefined) publish()
      else activeStage.events.push(publish)
    }

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

      return SLASH_HEX + names.reverse().join(SLASH_HEX)
    }

    const publishEntry = (_tag: Change["_tag"], parent: Directory, name: string) => {
      queuePublish(() =>
        watchHub.publishUnsafe(() => {
          const prefix = directoryHex(parent)

          return { _tag, path: ownedPath(nameBytes(prefix + (prefix === SLASH_HEX ? "" : SLASH_HEX) + name)) }
        })
      )
    }

    const publishNode = (target: Node) => {
      // Directories are never hard linked, so one name reaches them and the parent chain resolves it.
      if (target.kind === "directory") {
        // Removal and rename displacement drop the link count while open handles keep reaching the node.
        // No name resolves it any more, so its empty parent chain would otherwise read as the root path.
        // The file scan below stops on the same signal, and `lookup` already reads it as NotFound.
        if (target.metadata.nlink === 0) return
        queuePublish(() =>
          watchHub.publishUnsafe(() => UpdateChange.make({ path: ownedPath(nameBytes(directoryHex(target))) }))
        )

        return
      }

      queuePublish(() =>
        watchHub.publishManyUnsafe(() => {
          const changes: Array<Change> = []
          const pending: Array<readonly [Directory, string]> = [[state.root, SLASH_HEX]]

          // nlink counts the names bound to this node, so the scan stops once it has found them all.
          while (pending.length > 0 && changes.length < target.metadata.nlink) {
            const next = pending.pop()

            if (next === undefined) break
            const [directory, prefix] = next

            for (const [name, node] of directory.entries) {
              const path = prefix + name

              if (node === target) {
                changes.push(UpdateChange.make({ path: ownedPath(nameBytes(path)) }))
              }

              if (node.kind === "directory") pending.push([node, path + SLASH_HEX])
            }
          }

          return changes
        })
      )
    }

    const captureSnapshot = Effect.fnUntraced(function*() {
      const ids = new Map<Node, string>([[state.root, "0"]])
      const pending: Array<Node> = [state.root]
      const records: Array<Image.Record> = []

      for (let index = 0; index < pending.length; index++) {
        if (index % WALK_YIELD_INTERVAL === 0) yield* Effect.yieldNow
        const node = pending[index]

        if (node === undefined) continue
        const id = ids.get(node)

        if (id === undefined) return yield* new ImageError({ code: "InvalidStructure" })
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

          records.push(Image.Record.cases.directory.make({ id, metadata, entries: children }))
        } else if (node.kind === "file") {
          records.push(Image.Record.cases.file.make({ id, metadata, data: CanonicalBase64.encode(node.data.bytes) }))
        } else {records.push(
            Image.Record.cases.symlink.make({ id, metadata, target: CanonicalBase64.encode(node.target) })
          )}
      }

      return yield* Image.capture({ format: "effect-vfs", version: 1, root: "0", records }, undefined, true)
    })

    const observeChanges = Effect.fnUntraced(function*() {
      const observation: Array<ObservationEntry> = []
      const paths: Array<readonly [Node, Uint8Array]> = [[state.root, new Uint8Array([SLASH_BYTE])]]

      for (let index = 0; index < paths.length; index++) {
        if (index % WALK_YIELD_INTERVAL === 0) yield* Effect.yieldNow
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

          if (path.length !== 1) childPath[offset++] = SLASH_BYTE
          childPath.set(bytes, offset)
          paths.push([child, childPath])
        }
      }

      return observation
    })

    const captureState = Effect.fnUntraced(function*(hook?: TestHooks.ObservationHook) {
      const snapshot = yield* captureSnapshot()

      if (hook !== undefined) yield* hook.betweenSnapshotAndSummary

      return { snapshot, observation: yield* observeChanges() }
    })

    const advanceRevision = (node: Node) => {
      node.revision = nextRevision()
    }

    const referenceFor = (node: Node): ObjectReference => {
      if (node.objectReference !== undefined) return node.objectReference
      const reference = Object.freeze({ [ObjectReferenceId]: true as const })
      objectReferences.set(reference, { volume: volumeIdentity, cell: cellFor(node), active: true })
      node.objectReference = reference

      return reference
    }

    const invalidateReference = (node: Node) => {
      const reference = node.objectReference

      if (reference === undefined) return
      const state = objectReferences.get(reference)

      if (state !== undefined) {
        if (activeStage === undefined) {
          state.active = false
          state.cell = undefined
        } else activeStage.invalidated.add(state)
      }

      node.objectReference = undefined
    }

    const release = (reference: DirectoryReference) =>
      coordinatedCleanup(Effect.sync(() => {
        reference.directory = undefined
        reference.closed = true
      }))

    const authorize = (node: Node, identity: Identity, bits: number, operation: string, path?: PathInput) => {
      if (identity.privileged) return Effect.void
      const metadata = node.metadata

      const shift = metadata.uid === identity.uid ?
        6
        : metadata.gid === identity.gid || identity.groups.includes(metadata.gid)
        ? 3
        : 0

      return ((metadata.mode >> shift) & bits) === bits
        ? Effect.void
        : Effect.fail(
          path === undefined
            ? new FsError({ code: "AccessDenied", operation })
            : new FsError({ code: "AccessDenied", operation, path })
        )
    }

    const reclaim = (file: RegularFile) => {
      if (file.metadata.nlink === 0 && file.openCount === 0) {
        state.usedBytes -= BigInt(file.data.bytes.length)
        file.data = Content.empty()
        state.retainedFiles.delete(file.metadata.ino)
        invalidateReference(file)
      }
    }

    // Whether the volume's entry quota leaves room for one more name.
    const atEntryLimit = () => settings.maxEntries !== undefined && state.entries >= settings.maxEntries

    // A new subdirectory's ".." entry is a second link to the parent; other node kinds add none.
    const attach = (parent: Directory, name: string, node: Node, now: bigint) => {
      parent.entries.set(name, node)
      parent.metadata = {
        ...parent.metadata,
        nlink: parent.metadata.nlink + (node.kind === "directory" ? 1 : 0),
        mtimeNs: now,
        ctimeNs: now
      }
      advanceRevision(parent)
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

        if (node.kind === "file") {
          if (node.metadata.nlink === 0 && node.openCount > 0) state.retainedFiles.set(node.metadata.ino, node)
          reclaim(node)
        } else if (node.metadata.nlink === 0) {
          state.usedBytes -= BigInt(node.target.length)
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

    const finalizeFile = (ref: FileReference) =>
      Effect.suspend(() =>
        ref.closed
          ? Effect.void
          : ref.file === undefined
          ? Effect.sync(() => {
            ref.closed = true
          })
          : coordinated("close", Effect.sync(() => releaseFile(ref)), () => releaseFile(ref)).pipe(
            Effect.catch(() =>
              coordinatedCleanup(Effect.sync(() => {
                if (!ref.closed) releaseFile(ref)
              }))
            )
          )
      )

    // Replacing a payload clears setuid and setgid, and charges the volume for the size delta.
    const replaceContent = (file: RegularFile, data: Uint8Array, now: bigint, publish = true) => {
      state.usedBytes += BigInt(data.length - file.data.bytes.length)
      file.data = Content.make(data)
      file.metadata = {
        ...file.metadata,
        size: BigInt(data.length),
        mode: file.metadata.mode & ~SET_ID_BITS,
        mtimeNs: now,
        ctimeNs: now
      }
      advanceRevision(file)

      if (publish) publishNode(file)
    }

    const resize = Effect.fnUntraced(function*(file: RegularFile, length: bigint, operation: string, publish = true) {
      if (!Predicate.isBigInt(length) || length < 0n) {
        return yield* new FsError({ code: "InvalidArgument", operation: operation })
      }

      if (length > BigInt(maxFileBytes)) return yield* new FsError({ code: "FileTooLarge", operation: operation })
      const size = Number(length)

      if (
        settings.maxBytes !== undefined &&
        BigInt(size - file.data.bytes.length) > ByteSize.toBigInt(settings.maxBytes) - state.usedBytes
      ) {
        return yield* new FsError({ code: "NoSpace", operation: operation })
      }

      const data = new Uint8Array(size)
      data.set(file.data.bytes.subarray(0, size))
      replaceContent(file, data, yield* timestamp(operation), publish)
    })

    const fileHandle = (ref: FileReference): FileHandle => {
      const get = (operation: string, access?: "read" | "write") =>
        ref.file === undefined || (access === "read" && ref.access === "write") ||
          (access === "write" && ref.access === "read")
          ? Effect.fail(new FsError({ code: "InvalidHandle", operation: operation }))
          : Effect.succeed(ref.file)

      const read = (maximum: number, position?: bigint) =>
        coordinated(
          position === undefined ? "read" : "pread",
          Effect.gen(function*() {
            const file = yield* get(position === undefined ? "read" : "pread", "read")

            if (!isNatural(maximum)) return yield* new FsError({ code: "InvalidArgument", operation: "read" })
            const offset = position ?? ref.offset

            if (!Predicate.isBigInt(offset) || offset < 0n || offset > MAX_FILE_OFFSET) {
              return yield* new FsError({ code: "InvalidArgument", operation: "read" })
            }

            const start = Number(offset > file.metadata.size ? file.metadata.size : offset)
            const data = file.data.bytes.slice(start, start + Math.min(maximum, file.data.bytes.length - start))

            if (maximum > 0) {
              file.metadata = { ...file.metadata, atimeNs: (yield* timestamp("read")) }
            }

            if (position === undefined) ref.offset += BigInt(data.length)

            return data
          })
        )

      const write = Effect.fnUntraced(function*(input: Uint8Array, position?: bigint) {
        if (!isAttachedBytes(input)) return yield* new FsError({ code: "InvalidArgument", operation: "write" })

        const bytes = new Uint8Array(input)

        return yield* coordinated(
          position === undefined ? "write" : "pwrite",
          Effect.gen(function*() {
            const file = yield* get(position === undefined ? "write" : "pwrite", "write")
            const offset = position ?? (ref.append ? file.metadata.size : ref.offset)

            if (!Predicate.isBigInt(offset) || offset < 0n || offset > MAX_FILE_OFFSET) {
              return yield* new FsError({ code: "InvalidArgument", operation: "write" })
            }

            if (bytes.length === 0) {
              return 0
            }

            if (offset >= BigInt(maxFileBytes)) return yield* new FsError({ code: "FileTooLarge", operation: "write" })
            const start = Number(offset)

            const free = settings.maxBytes === undefined
              ? BigInt(maxFileBytes)
              : ByteSize.toBigInt(settings.maxBytes) - state.usedBytes

            const maximumEnd = BigInt(file.data.bytes.length) + free
            const end = Number(BigInt(maxFileBytes) < maximumEnd ? BigInt(maxFileBytes) : maximumEnd)
            const count = Math.min(bytes.length, Math.max(0, end - start))

            if (count === 0) return yield* new FsError({ code: "NoSpace", operation: "write" })
            const size = Math.max(file.data.bytes.length, start + count)
            // Always detach before mutation. A same-sized write is the critical
            // case: the current payload may belong to the base or a prior capture.
            const data = new Uint8Array(size)
            data.set(file.data.bytes)
            const now = yield* timestamp("write")
            data.set(bytes.subarray(0, count), start)
            replaceContent(file, data, now)

            if (position === undefined) ref.offset = offset + BigInt(count)

            return count
          })
        )
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
          return yield* coordinatedRead(
            "seek",
            Effect.uninterruptible(Effect.gen(function*() {
              const file = yield* get("seek")

              if (!Predicate.isBigInt(offset) || !isSeekMode(mode)) {
                return yield* new FsError({ code: "InvalidArgument", operation: "seek" })
              }

              let next = mode === "current"
                ? ref.offset + offset
                : mode === "end"
                ? file.metadata.size + offset
                : offset

              if (next < 0n || next > MAX_FILE_OFFSET) {
                return yield* new FsError({ code: "InvalidArgument", operation: "seek" })
              }

              if (mode === "data" || mode === "hole") {
                if (offset >= file.metadata.size) return yield* new FsError({ code: "NoData", operation: "seek" })

                if (mode === "hole") next = file.metadata.size
              }

              ref.offset = next

              return next
            }))
          )
        }),
        truncate: Effect.fn("FileHandle.truncate")(function*(length: bigint) {
          return yield* coordinated(
            "truncate",
            Effect.gen(function*() {
              yield* resize(yield* get("truncate", "write"), length, "truncate")
            })
          )
        }),
        stat: coordinatedRead(
          "stat",
          Effect.gen(function*() {
            return { ...(yield* get("stat")).metadata }
          })
        ).pipe(Effect.withSpan("FileHandle.stat")),
        sync: coordinatedRead("sync", Effect.suspend(() => Effect.asVoid(get("sync")))).pipe(
          Effect.withSpan("FileHandle.sync")
        ),
        close: coordinated(
          "close",
          Effect.gen(function*() {
            yield* get("close")
            releaseFile(ref)
          }),
          () => releaseFile(ref)
        ).pipe(
          Effect.catch((error) =>
            coordinatedCleanup(Effect.sync(() => {
              if (!ref.closed) releaseFile(ref)
            })).pipe(Effect.andThen(Effect.fail(error)))
          ),
          Effect.withSpan("FileHandle.close")
        )
      })

      files.set(handle, ref)

      return handle
    }

    const createCaller = (reference: DirectoryReference, identity: Identity, umask: number): Caller => {
      const referencedNode = Effect.fnUntraced(function*(target: ObjectReference, operation: string) {
        if (reference.directory === undefined) return yield* new FsError({ code: "ClosedCaller", operation: operation })

        if (!Predicate.isObject(target)) return yield* new FsError({ code: "InvalidReference", operation: operation })
        const state = objectReferences.get(target)

        if (state === undefined) return yield* new FsError({ code: "InvalidReference", operation: operation })

        if (state.volume !== volumeIdentity) {
          return yield* new FsError({ code: "ForeignReference", operation: operation })
        }

        if (!state.active || activeStage?.invalidated.has(state)) {
          return yield* new FsError({ code: "StaleReference", operation: operation })
        }

        const node = state.cell?.node

        if (node === undefined) return yield* new FsError({ code: "StaleReference", operation })

        return node
      })

      const referencedName = Effect.fnUntraced(function*(input: Uint8Array, operation: string) {
        if (
          !isAttachedBytes(input) || input.length === 0 || input.length > MAX_NAME_BYTES || input.includes(0) ||
          input.includes(SLASH_BYTE)
        ) return yield* new FsError({ code: "InvalidArgument", operation })
        const name = Encoding.encodeHex(new Uint8Array(input))

        if (isDotComponent(name)) return yield* new FsError({ code: "InvalidArgument", operation })

        return name
      })

      const referencedDirectory = Effect.fnUntraced(function*(target: ObjectReference, operation: string) {
        const node = yield* referencedNode(target, operation)

        if (node.kind !== "directory") return yield* new FsError({ code: "NotDirectory", operation })

        return node
      })

      const creationTimes = (times: Times | undefined, now: bigint) => ({
        atimeNs: times?.access.kind === "value" ? times.access.nanoseconds : now,
        mtimeNs: times?.modification.kind === "value" ? times.modification.nanoseconds : now
      })

      const lookup = Effect.fnUntraced(function*(
        path: PreparedPath,
        base: DirectoryHandle | undefined,
        operation: string,
        options: LookupOptions = {},
        referencedBase?: Directory
      ) {
        const { followFinalSymlink = true, allowMissing = false, parentOnly = false } = options

        if (reference.directory === undefined) {
          return yield* new FsError({ code: "ClosedCaller", operation: operation, path: path.input })
        }

        let current: Node = path.absolute ? state.root : reference.directory

        if (!path.absolute && referencedBase !== undefined) {
          current = referencedBase
          yield* authorize(current, identity, EXECUTE, operation)
        } else if (!path.absolute && base !== undefined) {
          const target = handles.get(base)

          if (target === undefined) {
            return yield* new FsError({ code: "InvalidHandle", operation: operation, path: path.input })
          }

          if (target.volume !== volumeIdentity) {
            return yield* new FsError({ code: "ForeignHandle", operation: operation, path: path.input })
          }

          if (target.directory === undefined) {
            return yield* new FsError({ code: "InvalidHandle", operation: operation, path: path.input })
          }

          current = target.directory
          yield* authorize(current, identity, EXECUTE, operation, path.input)
        }

        if (current.metadata.nlink === 0) {
          return yield* new FsError({ code: "NotFound", operation: operation, path: path.input })
        }

        let work = path
        let parent: Directory | undefined
        let name: string | undefined
        let traversals = 0

        for (let index = 0; index < work.components.length - (parentOnly ? 1 : 0); index++) {
          if (current.kind !== "directory") {
            return yield* new FsError({ code: "NotDirectory", operation: operation, path: path.input })
          }

          yield* authorize(current, identity, EXECUTE, operation, path.input)
          const component = work.components[index]

          if (component === undefined) break

          if (component === DOT_HEX) continue

          if (component === DOT_DOT_HEX) {
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

            return yield* new FsError({ code: "NotFound", operation: operation, path: path.input })
          }

          if (
            child.kind === "symlink" && (followFinalSymlink || index < work.components.length - 1 || work.trailingSlash)
          ) {
            if (child.target.length === 0) {
              return yield* new FsError({ code: "NotFound", operation: operation, path: path.input })
            }

            if (++traversals > 40) {
              return yield* new FsError({ code: "SymlinkLoop", operation: operation, path: path.input })
            }

            const suffix = work.suffixes[index] ?? new Uint8Array(0)

            if (
              settings.maxPathBytes !== undefined &&
              ByteSize.isGreaterThan(ByteSize.bytes(child.target.length + suffix.length), settings.maxPathBytes)
            ) {
              return yield* new FsError({ code: "PathTooLong", operation: operation, path: path.input })
            }

            const expansion = new Uint8Array(child.target.length + suffix.length)
            expansion.set(child.target)
            expansion.set(suffix, child.target.length)
            const expanded = preparePath(ownedPath(expansion), operation, settings.maxPathBytes)

            // The expansion is synthetic: its per-component limits are the caller's to hear about,
            // but the path in the error has to be the one the caller passed in.
            if (Result.isFailure(expanded)) {
              return yield* new FsError({ code: expanded.failure.code, operation: operation, path: path.input })
            }

            work = expanded.success

            if (work.absolute) current = state.root
            index = -1
          } else current = child
        }

        if (!parentOnly && work.trailingSlash && current.kind !== "directory") {
          return yield* new FsError({ code: "NotDirectory", operation: operation, path: path.input })
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

          if (result.node === undefined) {
            return yield* new FsError({ code: "NotFound", operation: operation, path: path.input })
          }

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

          if (node === undefined) {
            return yield* new FsError({ code: "NotFound", operation: operation, path: path.input })
          }

          if (node.kind !== "directory") {
            return yield* new FsError({ code: "NotDirectory", operation: operation, path: path.input })
          }

          return node
        }
      )

      const acquireDirectory = Effect.fnUntraced(
        function*(input: PathInput, options: RelativeOptions | undefined, operation: string) {
          const prepared = preparePath(input, operation, settings.maxPathBytes)
          const base = options?.relativeTo
          const acquired = makeDirectoryReference()
          // Register before retaining a directory. Closed scopes can run this immediately,
          // so registration must not happen while holding the volume permit.
          yield* Effect.addFinalizer(() => release(acquired))

          return yield* coordinatedRead(
            operation,
            Effect.uninterruptible(Effect.gen(function*() {
              if (acquired.closed) return yield* Effect.interrupt
              const path = yield* Effect.fromResult(prepared)
              const directory = yield* locate(path, base, operation)
              yield* authorize(directory, identity, EXECUTE, operation, input)
              acquired.directory = directory

              return acquired
            }))
          )
        }
      )

      const list = Effect.fnUntraced(function*(input: PathInput, options?: RelativeOptions) {
        const prepared = preparePath(input, "readDirectory", settings.maxPathBytes)
        const base = options?.relativeTo

        return yield* coordinated(
          "readDirectory",
          Effect.gen(function*() {
            const directory = yield* locate(yield* Effect.fromResult(prepared), base, "readDirectory")
            yield* authorize(directory, identity, READ, "readDirectory", input)
            const result = [...directory.entries.keys()].map(nameBytes)
            directory.metadata = { ...directory.metadata, atimeNs: (yield* timestamp("readDirectory")) }

            return result
          })
        )
      })

      const readTarget = Effect.fnUntraced(function*(input: PathInput, options?: RelativeOptions) {
        const prepared = preparePath(input, "readLink", settings.maxPathBytes)
        const base = options?.relativeTo

        return yield* coordinatedRead(
          "readLink",
          Effect.gen(function*() {
            const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "readLink", {
              followFinalSymlink: false
            })

            if (node.kind !== "symlink") {
              return yield* new FsError({ code: "InvalidArgument", operation: "readLink", path: input })
            }

            return new Uint8Array(node.target)
          })
        )
      })

      const canonical = Effect.fnUntraced(function*(input: PathInput, options?: RelativeOptions) {
        const prepared = preparePath(input, "realPath", settings.maxPathBytes)
        const base = options?.relativeTo

        return yield* coordinatedRead(
          "realPath",
          Effect.gen(function*() {
            const result = yield* lookup(yield* Effect.fromResult(prepared), base, "realPath")
            const components: Array<string> = []

            if (result.node?.kind !== "directory" && result.name !== undefined) components.push(result.name)
            let directory = result.node?.kind === "directory" ? result.node : result.parent

            while (directory !== undefined && directory.parent !== undefined) {
              const parent: Directory = directory.parent
              const entry = [...parent.entries].find(([, child]) => child === directory)

              if (entry === undefined) {
                return yield* new FsError({ code: "NotFound", operation: "realPath", path: input })
              }

              components.push(entry[0])
              directory = parent
            }

            return nameBytes(SLASH_HEX + components.reverse().join(SLASH_HEX))
          })
        )
      })

      const metadataNode = Effect.fnUntraced(
        function*(
          target: PathInput | FileHandle | DirectoryHandle,
          options: MetadataOptions | undefined,
          operation: string
        ) {
          if (reference.directory === undefined) {
            return yield* new FsError({ code: "ClosedCaller", operation: operation })
          }

          if (isFileHandle(target) || isDirectoryHandle(target)) {
            const ref = isFileHandle(target) ? files.get(target) : handles.get(target)

            if (ref === undefined) return yield* new FsError({ code: "InvalidHandle", operation: operation })

            if (ref.volume !== volumeIdentity) {
              return yield* new FsError({ code: "ForeignHandle", operation: operation })
            }

            const node = "file" in ref ? ref.file : ref.directory

            if (node === undefined) return yield* new FsError({ code: "InvalidHandle", operation: operation })

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
          return Effect.fail(
            path === undefined
              ? new FsError({ code: "AccessDenied", operation })
              : new FsError({ code: "AccessDenied", operation, path })
          )
        }

        const group = identity.gid === metadata.gid || identity.groups.includes(metadata.gid)

        return Effect.succeed(!identity.privileged && metadata.kind === "file" && !group ? mode & ~0o2000 : mode)
      }

      const changeMode = Effect.fnUntraced(
        function*(target: PathInput | FileHandle | DirectoryHandle, mode: number, options?: MetadataOptions) {
          if (!isMode(mode)) return yield* new FsError({ code: "InvalidArgument", operation: "chmod" })
          const chosen = options === undefined ? undefined : { ...options }

          return yield* coordinated(
            "chmod",
            Effect.gen(function*() {
              const node = yield* metadataNode(target, chosen, "chmod")
              const permitted = yield* permittedMode(node.metadata, mode, "chmod")
              node.metadata = {
                ...node.metadata,
                mode: permitted,
                ctimeNs: (yield* timestamp("chmod"))
              }
              advanceRevision(node)
              publishNode(node)
            })
          )
        }
      )

      const changeOwner = Effect.fnUntraced(
        function*(target: PathInput | FileHandle | DirectoryHandle, owner: OwnerUpdate, options?: MetadataOptions) {
          const decoded = decodeOwnerUpdate(owner)

          if (Result.isFailure(decoded)) return yield* new FsError({ code: "InvalidArgument", operation: "chown" })
          const update = { ...decoded.success }
          const chosen = options === undefined ? undefined : { ...options }

          return yield* coordinated(
            "chown",
            Effect.gen(function*() {
              const node = yield* metadataNode(target, chosen, "chown")

              if (
                !identity.privileged && (identity.uid !== node.metadata.uid ||
                  (update.uid !== undefined && update.uid !== node.metadata.uid) ||
                  (update.gid !== undefined && update.gid !== identity.gid && !identity.groups.includes(update.gid)))
              ) {
                return yield* new FsError({ code: "AccessDenied", operation: "chown" })
              }

              if (update.uid === undefined && update.gid === undefined) return
              node.metadata = {
                ...node.metadata,
                uid: update.uid ?? node.metadata.uid,
                gid: update.gid ?? node.metadata.gid,
                mode: node.kind === "file" ? node.metadata.mode & ~SET_ID_BITS : node.metadata.mode,
                ctimeNs: (yield* timestamp("chown"))
              }
              advanceRevision(node)
              publishNode(node)
            })
          )
        }
      )

      const changeTimes = Effect.fnUntraced(
        function*(target: PathInput | FileHandle | DirectoryHandle, times: Times, options?: MetadataOptions) {
          const decoded = decodeTimes(times)

          if (Result.isFailure(decoded)) return yield* new FsError({ code: "InvalidArgument", operation: "utimes" })
          const access = { ...decoded.success.access }
          const modification = { ...decoded.success.modification }
          const chosen = options === undefined ? undefined : { ...options }

          return yield* coordinated(
            "utimes",
            Effect.gen(function*() {
              const node = yield* metadataNode(target, chosen, "utimes")

              if (access.kind === "omit" && modification.kind === "omit") return

              // POSIX grants write access only when both times are UTIME_NOW; both UTIME_OMIT
              // returned above. Every other combination, mixed ones included, needs ownership.
              if (!identity.privileged && identity.uid !== node.metadata.uid) {
                if (access.kind !== "now" || modification.kind !== "now") {
                  const path = pathOf(target)

                  return yield* path === undefined
                    ? new FsError({ code: "AccessDenied", operation: "utimes" })
                    : new FsError({ code: "AccessDenied", operation: "utimes", path })
                }

                yield* authorize(node, identity, WRITE, "utimes", pathOf(target))
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
            })
          )
        }
      )

      const authorizeRemoval = (parent: Directory, child: Node, operation: string, input?: PathInput) =>
        (parent.metadata.mode & STICKY_BIT) !== 0 && !identity.privileged &&
          identity.uid !== parent.metadata.uid && identity.uid !== child.metadata.uid
          ? Effect.fail(
            input === undefined
              ? new FsError({ code: "AccessDenied", operation })
              : new FsError({ code: "AccessDenied", operation, path: input })
          )
          : Effect.void

      return Object.freeze({
        [CallerId]: true as const,
        rootReference: coordinatedRead(
          "rootReference",
          Effect.gen(function*() {
            if (reference.directory === undefined) {
              return yield* new FsError({ code: "ClosedCaller", operation: "rootReference" })
            }

            return referenceFor(state.root)
          })
        ).pipe(Effect.withSpan("Caller.rootReference")),
        lookupReference: Effect.fn("Caller.lookupReference")(function*(directoryReference, name) {
          if (
            !isAttachedBytes(name) || name.length === 0 || name.length > MAX_NAME_BYTES || name.includes(0) ||
            name.includes(SLASH_BYTE)
          ) return yield* new FsError({ code: "InvalidArgument", operation: "lookupReference" })
          const key = Encoding.encodeHex(new Uint8Array(name))

          if (isDotComponent(key)) return yield* new FsError({ code: "InvalidArgument", operation: "lookupReference" })

          return yield* coordinatedRead(
            "lookupReference",
            Effect.gen(function*() {
              const directory = yield* referencedNode(directoryReference, "lookupReference")

              if (directory.kind !== "directory") {
                return yield* new FsError({ code: "NotDirectory", operation: "lookupReference" })
              }

              yield* authorize(directory, identity, EXECUTE, "lookupReference", "/")
              const child = directory.entries.get(key)

              if (child === undefined) return yield* new FsError({ code: "NotFound", operation: "lookupReference" })

              return referenceFor(child)
            })
          )
        }),
        parentReference: Effect.fn("Caller.parentReference")(function*(directoryReference) {
          return yield* coordinatedRead(
            "parentReference",
            Effect.gen(function*() {
              const directory = yield* referencedNode(directoryReference, "parentReference")

              if (directory.kind !== "directory") {
                return yield* new FsError({ code: "NotDirectory", operation: "parentReference" })
              }

              yield* authorize(directory, identity, EXECUTE, "parentReference", "/")

              return referenceFor(directory.parent ?? directory)
            })
          )
        }),
        observeMetadata: Effect.fn("Caller.observeMetadata")(function*(objectReference) {
          return yield* coordinatedRead(
            "observeMetadata",
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, "observeMetadata")

              return Object.freeze({ value: Object.freeze({ ...node.metadata }), revision: node.revision })
            })
          )
        }),
        accessReference: Effect.fn("Caller.accessReference")(function*(objectReference, bits = 0) {
          if (!Number.isInteger(bits) || bits < 0 || bits > (READ | WRITE | EXECUTE)) {
            return yield* new FsError({ code: "InvalidArgument", operation: "accessReference" })
          }

          return yield* coordinatedRead(
            "accessReference",
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, "accessReference")

              if (node.kind === "file" && (bits & EXECUTE) !== 0 && (node.metadata.mode & ANY_EXECUTE) === 0) {
                return yield* new FsError({ code: "AccessDenied", operation: "accessReference" })
              }

              yield* authorize(node, identity, bits, "accessReference")
            })
          )
        }),
        observeDirectory: Effect.fn("Caller.observeDirectory")(function*(directoryReference) {
          return yield* coordinatedRead(
            "observeDirectory",
            Effect.gen(function*() {
              const directory = yield* referencedNode(directoryReference, "observeDirectory")

              if (directory.kind !== "directory") {
                return yield* new FsError({ code: "NotDirectory", operation: "observeDirectory" })
              }

              yield* authorize(directory, identity, READ, "observeDirectory", "/")

              const value = Object.freeze(
                [...directory.entries].map(([name, node]) =>
                  Object.freeze({ name: nameBytes(name), reference: referenceFor(node) })
                )
              )

              return Object.freeze({ value, revision: directory.revision })
            })
          )
        }),
        readLinkReference: Effect.fn("Caller.readLinkReference")(function*(objectReference) {
          return yield* coordinatedRead(
            "readLinkReference",
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, "readLinkReference")

              if (node.kind !== "symlink") {
                return yield* new FsError({ code: "InvalidArgument", operation: "readLinkReference" })
              }

              return new Uint8Array(node.target)
            })
          )
        }),
        mkdirReference: Effect.fn("Caller.mkdirReference")(function*(directoryReference, input, raw = {}) {
          const name = yield* referencedName(input, "mkdirReference")
          const decoded = decodeMkdirReferenceSettings(raw)

          if (Result.isFailure(decoded)) {
            return yield* new FsError({ code: "InvalidArgument", operation: "mkdirReference" })
          }

          const chosen = { ...decoded.success }

          if (chosen.exactMode && chosen.mode === undefined) {
            return yield* new FsError({ code: "InvalidArgument", operation: "mkdirReference" })
          }

          const mode = chosen.mode ?? 0o777

          return yield* coordinated(
            "mkdirReference",
            Effect.gen(function*() {
              const parent = yield* referencedDirectory(directoryReference, "mkdirReference")
              yield* authorize(parent, identity, WRITE | EXECUTE, "mkdirReference")

              if (parent.entries.has(name)) {
                return yield* new FsError({ code: "AlreadyExists", operation: "mkdirReference" })
              }

              if (atEntryLimit()) return yield* new FsError({ code: "NoSpace", operation: "mkdirReference" })
              const before = parent.revision
              const now = yield* timestamp("mkdirReference")
              const initial = creationTimes(chosen.times, now)

              const creationMode = chosen.exactMode
                ? yield* permittedMode(
                  { kind: "directory", uid: identity.uid, gid: parent.metadata.gid },
                  mode,
                  "mkdirReference"
                )
                : (mode & 0o777 & ~umask) | (mode & STICKY_BIT)

              const child: Directory = {
                kind: "directory",
                lineage: undefined,
                parent,
                entries: new Map(),
                metadata: {
                  ...directoryMetadata(
                    state.nextInode,
                    identity.uid,
                    parent.metadata.gid,
                    creationMode,
                    now
                  ),
                  ...initial
                },
                revision: nextRevision(),
                objectReference: undefined
              }

              attach(parent, name, child, now)
              state.nextInode += 1n
              state.entries += 1
              publishEntry("Create", parent, name)

              return { reference: referenceFor(child), directory: { before, after: parent.revision } }
            })
          )
        }),
        symlinkReference: Effect.fn("Caller.symlinkReference")(
          function*(target, directoryReference, input, raw = {}) {
            const name = yield* referencedName(input, "symlinkReference")
            const decoded = decodeSymlinkReferenceSettings(raw)

            if (Result.isFailure(decoded)) {
              return yield* new FsError({ code: "InvalidArgument", operation: "symlinkReference" })
            }

            const rawTarget = inputBytes(target)

            if (Result.isFailure(rawTarget)) {
              return yield* new FsError({ code: rawTarget.failure, operation: "symlinkReference" })
            }

            if (rawTarget.success.includes(0)) {
              return yield* new FsError({ code: "InvalidArgument", operation: "symlinkReference" })
            }

            const targetBytes = new Uint8Array(rawTarget.success)
            const chosen = { ...decoded.success }

            return yield* coordinated(
              "symlinkReference",
              Effect.gen(function*() {
                const parent = yield* referencedDirectory(directoryReference, "symlinkReference")
                yield* authorize(parent, identity, WRITE | EXECUTE, "symlinkReference")

                if (parent.entries.has(name)) {
                  return yield* new FsError({ code: "AlreadyExists", operation: "symlinkReference" })
                }

                if (
                  atEntryLimit() ||
                  (settings.maxBytes !== undefined &&
                    BigInt(targetBytes.length) > ByteSize.toBigInt(settings.maxBytes) - state.usedBytes)
                ) return yield* new FsError({ code: "NoSpace", operation: "symlinkReference" })
                const before = parent.revision
                const now = yield* timestamp("symlinkReference")
                const initial = creationTimes(chosen.times, now)

                const node: SymbolicLink = {
                  kind: "symlink",
                  lineage: undefined,
                  target: targetBytes,
                  metadata: {
                    ...directoryMetadata(state.nextInode, identity.uid, parent.metadata.gid, 0o777, now),
                    ...initial,
                    kind: "symlink",
                    nlink: 1,
                    size: BigInt(targetBytes.length)
                  },
                  revision: nextRevision(),
                  objectReference: undefined
                }

                attach(parent, name, node, now)
                state.nextInode += 1n
                state.entries += 1
                state.usedBytes += BigInt(targetBytes.length)
                publishEntry("Create", parent, name)

                return { reference: referenceFor(node), directory: { before, after: parent.revision } }
              })
            )
          }
        ),
        linkReference: Effect.fn("Caller.linkReference")(
          function*(sourceReference, directoryReference, input) {
            const name = yield* referencedName(input, "linkReference")

            return yield* coordinated(
              "linkReference",
              Effect.gen(function*() {
                const node = yield* referencedNode(sourceReference, "linkReference")

                if (node.kind === "directory") {
                  return yield* new FsError({ code: "IsDirectory", operation: "linkReference" })
                }

                if (node.metadata.nlink === 0) {
                  return yield* new FsError({ code: "StaleReference", operation: "linkReference" })
                }

                const parent = yield* referencedDirectory(directoryReference, "linkReference")
                yield* authorize(parent, identity, WRITE | EXECUTE, "linkReference")

                if (parent.entries.has(name)) {
                  return yield* new FsError({ code: "AlreadyExists", operation: "linkReference" })
                }

                if (atEntryLimit()) return yield* new FsError({ code: "NoSpace", operation: "linkReference" })
                const before = parent.revision
                const now = yield* timestamp("linkReference")
                attach(parent, name, node, now)
                node.metadata = { ...node.metadata, nlink: node.metadata.nlink + 1, ctimeNs: now }
                advanceRevision(node)
                state.entries += 1
                publishEntry("Create", parent, name)

                return { reference: referenceFor(node), directory: { before, after: parent.revision } }
              })
            )
          }
        ),
        unlinkReference: Effect.fn("Caller.unlinkReference")(function*(directoryReference, input) {
          const name = yield* referencedName(input, "unlinkReference")

          return yield* coordinated(
            "unlinkReference",
            Effect.gen(function*() {
              const parent = yield* referencedDirectory(directoryReference, "unlinkReference")
              yield* authorize(parent, identity, WRITE | EXECUTE, "unlinkReference")
              const child = parent.entries.get(name)

              if (child === undefined) return yield* new FsError({ code: "NotFound", operation: "unlinkReference" })

              if (child.kind === "directory") {
                return yield* new FsError({ code: "IsDirectory", operation: "unlinkReference" })
              }

              yield* authorizeRemoval(parent, child, "unlinkReference")
              const before = parent.revision
              const now = yield* timestamp("unlinkReference")
              parent.entries.delete(name)
              parent.metadata = { ...parent.metadata, mtimeNs: now, ctimeNs: now }
              advanceRevision(parent)
              detach(child, now)
              state.entries -= 1
              publishEntry("Remove", parent, name)

              return { before, after: parent.revision }
            })
          )
        }),
        rmdirReference: Effect.fn("Caller.rmdirReference")(function*(directoryReference, input) {
          const name = yield* referencedName(input, "rmdirReference")

          return yield* coordinated(
            "rmdirReference",
            Effect.gen(function*() {
              const parent = yield* referencedDirectory(directoryReference, "rmdirReference")
              yield* authorize(parent, identity, WRITE | EXECUTE, "rmdirReference")
              const child = parent.entries.get(name)

              if (child === undefined) return yield* new FsError({ code: "NotFound", operation: "rmdirReference" })
              yield* authorizeRemoval(parent, child, "rmdirReference")

              if (child.kind !== "directory") {
                return yield* new FsError({ code: "NotDirectory", operation: "rmdirReference" })
              }

              if (child.entries.size > 0) {
                return yield* new FsError({ code: "NotEmpty", operation: "rmdirReference" })
              }

              const before = parent.revision
              const now = yield* timestamp("rmdirReference")
              parent.entries.delete(name)
              parent.metadata = { ...parent.metadata, nlink: parent.metadata.nlink - 1, mtimeNs: now, ctimeNs: now }
              child.parent = undefined
              child.metadata = { ...child.metadata, nlink: 0, ctimeNs: now }
              advanceRevision(parent)
              advanceRevision(child)
              invalidateReference(child)
              state.entries -= 1
              publishEntry("Remove", parent, name)

              return { before, after: parent.revision }
            })
          )
        }),
        removeReference: Effect.fn("Caller.removeReference")(function*(directoryReference, input) {
          const name = yield* referencedName(input, "removeReference")

          return yield* coordinated(
            "removeReference",
            Effect.gen(function*() {
              const parent = yield* referencedDirectory(directoryReference, "removeReference")
              yield* authorize(parent, identity, WRITE | EXECUTE, "removeReference")
              const child = parent.entries.get(name)

              if (child === undefined) return yield* new FsError({ code: "NotFound", operation: "removeReference" })
              yield* authorizeRemoval(parent, child, "removeReference")

              if (child.kind === "directory" && child.entries.size > 0) {
                return yield* new FsError({ code: "NotEmpty", operation: "removeReference" })
              }

              const before = parent.revision
              const now = yield* timestamp("removeReference")
              parent.entries.delete(name)
              parent.metadata = {
                ...parent.metadata,
                nlink: parent.metadata.nlink - (child.kind === "directory" ? 1 : 0),
                mtimeNs: now,
                ctimeNs: now
              }

              if (child.kind === "directory") {
                child.parent = undefined
                child.metadata = { ...child.metadata, nlink: 0, ctimeNs: now }
                advanceRevision(parent)
                advanceRevision(child)
                invalidateReference(child)
              } else {
                advanceRevision(parent)
                detach(child, now)
              }

              state.entries -= 1
              publishEntry("Remove", parent, name)

              return { before, after: parent.revision }
            })
          )
        }),
        renameReference: Effect.fn("Caller.renameReference")(
          function*(sourceDirectoryReference, sourceInput, destinationDirectoryReference, destinationInput) {
            const sourceName = yield* referencedName(sourceInput, "renameReference")
            const destinationName = yield* referencedName(destinationInput, "renameReference")

            return yield* coordinated(
              "renameReference",
              Effect.gen(function*() {
                const sourceDirectory = yield* referencedDirectory(sourceDirectoryReference, "renameReference")

                const destinationDirectory = yield* referencedDirectory(
                  destinationDirectoryReference,
                  "renameReference"
                )

                yield* authorize(sourceDirectory, identity, WRITE | EXECUTE, "renameReference")
                yield* authorize(destinationDirectory, identity, WRITE | EXECUTE, "renameReference")
                const sourceBefore = sourceDirectory.revision
                const destinationBefore = destinationDirectory.revision
                const child = sourceDirectory.entries.get(sourceName)

                if (child === undefined) {
                  return yield* new FsError({ code: "NotFound", operation: "renameReference" })
                }

                const replaced = destinationDirectory.entries.get(destinationName)

                if (child === replaced) {
                  return sourceDirectory === destinationDirectory
                    ? { _tag: "SameDirectory" as const, directory: { before: sourceBefore, after: sourceBefore } }
                    : {
                      _tag: "DifferentDirectories" as const,
                      sourceDirectory: { before: sourceBefore, after: sourceBefore },
                      destinationDirectory: { before: destinationBefore, after: destinationBefore }
                    }
                }

                yield* authorizeRemoval(sourceDirectory, child, "renameReference")

                if (replaced !== undefined) {
                  yield* authorizeRemoval(destinationDirectory, replaced, "renameReference")

                  if (child.kind === "directory" && replaced.kind !== "directory") {
                    return yield* new FsError({ code: "NotDirectory", operation: "renameReference" })
                  }

                  if (child.kind !== "directory" && replaced.kind === "directory") {
                    return yield* new FsError({ code: "IsDirectory", operation: "renameReference" })
                  }

                  if (replaced.kind === "directory" && replaced.entries.size > 0) {
                    return yield* new FsError({ code: "NotEmpty", operation: "renameReference" })
                  }
                }

                for (
                  let ancestor: Directory | undefined = destinationDirectory;
                  ancestor !== undefined;
                  ancestor = ancestor.parent
                ) {
                  if (ancestor === child) {
                    return yield* new FsError({ code: "InvalidArgument", operation: "renameReference" })
                  }
                }

                const now = yield* timestamp("renameReference")

                const oldEvent = () =>
                  ownedPath(
                    nameBytes(
                      directoryHex(sourceDirectory) + (sourceDirectory === state.root ? "" : SLASH_HEX) + sourceName
                    )
                  )

                sourceDirectory.entries.delete(sourceName)
                destinationDirectory.entries.set(destinationName, child)

                if (child.kind === "directory") child.parent = destinationDirectory
                sourceDirectory.metadata = {
                  ...sourceDirectory.metadata,
                  nlink: sourceDirectory.metadata.nlink - (child.kind === "directory" ? 1 : 0),
                  mtimeNs: now,
                  ctimeNs: now
                }
                destinationDirectory.metadata = {
                  ...destinationDirectory.metadata,
                  nlink: destinationDirectory.metadata.nlink +
                    (child.kind === "directory" && replaced === undefined ? 1 : 0),
                  mtimeNs: now,
                  ctimeNs: now
                }
                child.metadata = { ...child.metadata, ctimeNs: now }
                advanceRevision(sourceDirectory)

                if (destinationDirectory !== sourceDirectory) advanceRevision(destinationDirectory)
                advanceRevision(child)

                if (replaced !== undefined) {
                  detach(replaced, now)
                  state.entries -= 1
                }

                queuePublish(() => watchHub.publishUnsafe(() => ({ _tag: "Remove" as const, path: oldEvent() })))
                publishEntry("Create", destinationDirectory, destinationName)

                return sourceDirectory === destinationDirectory
                  ? {
                    _tag: "SameDirectory" as const,
                    directory: { before: sourceBefore, after: sourceDirectory.revision }
                  }
                  : {
                    _tag: "DifferentDirectories" as const,
                    sourceDirectory: { before: sourceBefore, after: sourceDirectory.revision },
                    destinationDirectory: { before: destinationBefore, after: destinationDirectory.revision }
                  }
              })
            )
          }
        ),
        chmodReference: Effect.fn("Caller.chmodReference")(function*(objectReference, mode) {
          if (!isMode(mode)) return yield* new FsError({ code: "InvalidArgument", operation: "chmodReference" })

          return yield* coordinated(
            "chmodReference",
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, "chmodReference")
              const permitted = yield* permittedMode(node.metadata, mode, "chmodReference")
              node.metadata = { ...node.metadata, mode: permitted, ctimeNs: (yield* timestamp("chmodReference")) }
              advanceRevision(node)
              publishNode(node)
            })
          )
        }),
        chownReference: Effect.fn("Caller.chownReference")(function*(objectReference, owner) {
          const decoded = decodeOwnerUpdate(owner)

          if (Result.isFailure(decoded)) {
            return yield* new FsError({ code: "InvalidArgument", operation: "chownReference" })
          }

          const update = { ...decoded.success }

          return yield* coordinated(
            "chownReference",
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, "chownReference")

              if (
                !identity.privileged && (identity.uid !== node.metadata.uid ||
                  (update.uid !== undefined && update.uid !== node.metadata.uid) ||
                  (update.gid !== undefined && update.gid !== identity.gid && !identity.groups.includes(update.gid)))
              ) return yield* new FsError({ code: "AccessDenied", operation: "chownReference" })

              if (update.uid === undefined && update.gid === undefined) return
              node.metadata = {
                ...node.metadata,
                uid: update.uid ?? node.metadata.uid,
                gid: update.gid ?? node.metadata.gid,
                mode: node.kind === "file" ? node.metadata.mode & ~SET_ID_BITS : node.metadata.mode,
                ctimeNs: (yield* timestamp("chownReference"))
              }
              advanceRevision(node)
              publishNode(node)
            })
          )
        }),
        utimesReference: Effect.fn("Caller.utimesReference")(function*(objectReference, times) {
          const decoded = decodeTimes(times)

          if (Result.isFailure(decoded)) {
            return yield* new FsError({ code: "InvalidArgument", operation: "utimesReference" })
          }

          const access = { ...decoded.success.access }
          const modification = { ...decoded.success.modification }

          return yield* coordinated(
            "utimesReference",
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, "utimesReference")

              if (access.kind === "omit" && modification.kind === "omit") return

              if (!identity.privileged && identity.uid !== node.metadata.uid) {
                if (access.kind !== "now" || modification.kind !== "now") {
                  return yield* new FsError({ code: "AccessDenied", operation: "utimesReference" })
                }

                yield* authorize(node, identity, WRITE, "utimesReference")
              }

              const now = yield* timestamp("utimesReference")
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
            })
          )
        }),
        truncateReference: Effect.fn("Caller.truncateReference")(function*(objectReference, length) {
          return yield* coordinated(
            "truncateReference",
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, "truncateReference")

              if (node.kind !== "file") {
                return yield* new FsError({ code: "IsDirectory", operation: "truncateReference" })
              }

              yield* authorize(node, identity, WRITE, "truncateReference")
              yield* resize(node, length, "truncateReference")
            })
          )
        }),
        openReference: Effect.fn("Caller.openReference")(function*(objectReference, raw = { access: "read" }) {
          const decoded = decodeOpenReferenceSettings(raw)

          if (Result.isFailure(decoded)) {
            return yield* new FsError({ code: "InvalidArgument", operation: "openReference" })
          }

          const chosen = { ...decoded.success }

          if (chosen.access === "read" && (chosen.append || chosen.truncate)) {
            return yield* new FsError({ code: "InvalidArgument", operation: "openReference" })
          }

          const acquired = makeFileReference(chosen.access, chosen.append ?? false)

          yield* Effect.addFinalizer(() => finalizeFile(acquired))

          return yield* coordinated(
            "openReference",
            Effect.gen(function*() {
              if (acquired.closed) return yield* Effect.interrupt
              const node = yield* referencedNode(objectReference, "openReference")

              if (node.kind !== "file") return yield* new FsError({ code: "IsDirectory", operation: "openReference" })

              if (node.metadata.nlink === 0) {
                return yield* new FsError({ code: "StaleReference", operation: "openReference" })
              }

              yield* authorize(
                node,
                identity,
                chosen.access === "read" ? READ : chosen.access === "write" ? WRITE : READ | WRITE,
                "openReference"
              )

              if (chosen.truncate) yield* resize(node, 0n, "openReference")
              node.openCount += 1
              acquired.file = node

              return fileHandle(acquired)
            })
          )
        }),
        openChildReference: Effect.fn("Caller.openChildReference")(
          function*(directoryReference, input, raw, expected) {
            const name = yield* referencedName(input, "openChildReference")
            const decoded = decodeOpenChildReferenceSettings(raw)

            if (Result.isFailure(decoded)) {
              return yield* new FsError({ code: "InvalidArgument", operation: "openChildReference" })
            }

            const chosen = { ...decoded.success }

            if (chosen.access === "read" && (chosen.append || chosen.truncate)) {
              return yield* new FsError({ code: "InvalidArgument", operation: "openChildReference" })
            }

            if (
              (chosen.mode !== undefined || chosen.times !== undefined || chosen.initialSize !== undefined ||
                chosen.exactMode !== undefined || chosen.owner !== undefined) &&
              (chosen.create === undefined || chosen.create === "never")
            ) {
              return yield* new FsError({ code: "InvalidArgument", operation: "openChildReference" })
            }

            if (chosen.exactMode && chosen.mode === undefined) {
              return yield* new FsError({ code: "InvalidArgument", operation: "openChildReference" })
            }

            const relativePath = preparePath(ownedPath(nameBytes(name)), "openChildReference", undefined)

            const acquired = makeFileReference(chosen.access, chosen.append ?? false)

            yield* Effect.addFinalizer(() => finalizeFile(acquired))

            return yield* coordinated(
              "openChildReference",
              Effect.gen(function*() {
                if (acquired.closed) return yield* Effect.interrupt
                const parent = yield* referencedDirectory(directoryReference, "openChildReference")
                yield* authorize(parent, identity, EXECUTE, "openChildReference")
                const direct = parent.entries.get(name)

                if (expected !== undefined) {
                  let expectedNode: Node | undefined

                  if (expected !== null) {
                    const observed = yield* Effect.result(referencedNode(expected, "openChildReference"))

                    if (Result.isFailure(observed)) {
                      return yield* new FsError({ code: "VolumeBusy", operation: "openChildReference" })
                    }

                    expectedNode = observed.success
                  }

                  if (direct !== expectedNode) {
                    return yield* new FsError({ code: "VolumeBusy", operation: "openChildReference" })
                  }
                }

                if (chosen.expectedChild === null) {
                  if (direct !== undefined) {
                    return yield* new FsError({ code: "StaleReference", operation: "openChildReference" })
                  }
                } else if (chosen.expectedChild !== undefined) {
                  const expected = chosen.expectedChild
                  const observed = yield* referencedNode(expected.reference, "openChildReference")

                  if (
                    direct !== observed || observed.revision !== expected.revision ||
                    observed.metadata.atimeNs !== expected.atimeNs || observed.metadata.mtimeNs !== expected.mtimeNs
                  ) {
                    return yield* new FsError({ code: "StaleReference", operation: "openChildReference" })
                  }
                }

                if (direct !== undefined && chosen.create === "exclusive") {
                  return yield* new FsError({ code: "AlreadyExists", operation: "openChildReference" })
                }

                let file: Node | undefined = direct
                let mutationParent = parent
                let mutationName = name

                if (file?.kind === "symlink" && chosen.followFinalSymlink !== false) {
                  const resolved = yield* lookup(
                    yield* Effect.fromResult(relativePath),
                    undefined,
                    "openChildReference",
                    {
                      followFinalSymlink: true,
                      allowMissing: chosen.create === "ifMissing" || chosen.create === "exclusive"
                    },
                    parent
                  )

                  file = resolved.node

                  if (file === undefined) {
                    if (resolved.parent === undefined || resolved.name === undefined) {
                      return yield* new FsError({ code: "IsDirectory", operation: "openChildReference" })
                    }

                    mutationParent = resolved.parent
                    mutationName = resolved.name
                  }
                }

                const before = mutationParent.revision
                let created = false

                if (file === undefined) {
                  if (chosen.create === undefined || chosen.create === "never") {
                    return yield* new FsError({ code: "NotFound", operation: "openChildReference" })
                  }

                  yield* authorize(mutationParent, identity, WRITE | EXECUTE, "openChildReference")

                  if (atEntryLimit()) {
                    return yield* new FsError({ code: "NoSpace", operation: "openChildReference" })
                  }

                  const size = chosen.initialSize ?? 0n

                  if (size < 0n) {
                    return yield* new FsError({ code: "InvalidArgument", operation: "openChildReference" })
                  }

                  if (size > BigInt(maxFileBytes)) {
                    return yield* new FsError({ code: "FileTooLarge", operation: "openChildReference" })
                  }

                  if (
                    settings.maxBytes !== undefined && size > ByteSize.toBigInt(settings.maxBytes) - state.usedBytes
                  ) {
                    return yield* new FsError({ code: "NoSpace", operation: "openChildReference" })
                  }

                  if (
                    !identity.privileged &&
                    ((chosen.owner?.uid !== undefined && chosen.owner.uid !== identity.uid) ||
                      (chosen.owner?.gid !== undefined && chosen.owner.gid !== identity.gid &&
                        !identity.groups.includes(chosen.owner.gid)))
                  ) {
                    return yield* new FsError({ code: "AccessDenied", operation: "openChildReference" })
                  }

                  const now = yield* timestamp("openChildReference")
                  const initial = creationTimes(chosen.times, now)

                  const creationMode = chosen.exactMode
                    ? yield* permittedMode(
                      {
                        kind: "file",
                        uid: chosen.owner?.uid ?? identity.uid,
                        gid: chosen.owner?.gid ?? mutationParent.metadata.gid
                      },
                      chosen.mode!,
                      "openChildReference"
                    )
                    : (chosen.mode ?? 0o666) & 0o777 & ~umask

                  const createdFile: RegularFile = {
                    kind: "file",
                    lineage: undefined,
                    data: Content.make(new Uint8Array(Number(size))),
                    openCount: 0,
                    metadata: {
                      ...directoryMetadata(
                        state.nextInode,
                        chosen.owner?.uid ?? identity.uid,
                        chosen.owner?.gid ?? mutationParent.metadata.gid,
                        creationMode,
                        now
                      ),
                      ...initial,
                      kind: "file",
                      size,
                      nlink: 1
                    },
                    revision: nextRevision(),
                    objectReference: undefined
                  }

                  file = createdFile
                  attach(mutationParent, mutationName, createdFile, now)
                  state.entries += 1
                  state.usedBytes += size
                  state.nextInode += 1n
                  created = true
                  publishEntry("Create", mutationParent, mutationName)
                } else {
                  if (file.kind === "symlink") {
                    return yield* new FsError({ code: "SymlinkLoop", operation: "openChildReference" })
                  }

                  if (file.kind !== "file") {
                    return yield* new FsError({ code: "IsDirectory", operation: "openChildReference" })
                  }

                  yield* authorize(
                    file,
                    identity,
                    chosen.access === "read" ? READ : chosen.access === "write" ? WRITE : READ | WRITE,
                    "openChildReference"
                  )

                  if (chosen.truncate) yield* resize(file, 0n, "openChildReference")
                }

                file.openCount += 1
                acquired.file = file

                return {
                  handle: fileHandle(acquired),
                  reference: referenceFor(file),
                  created,
                  directory: { before, after: mutationParent.revision }
                }
              })
            )
          }
        ),
        readFile: Effect.fn("Caller.readFile")(function*(input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "readFile", settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(
            "readFile",
            Effect.gen(function*() {
              const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "readFile")

              if (node.kind !== "file") {
                return yield* new FsError({ code: "IsDirectory", operation: "readFile", path: input })
              }

              yield* authorize(node, identity, READ, "readFile", input)
              const data = new Uint8Array(node.data.bytes)
              node.metadata = { ...node.metadata, atimeNs: (yield* timestamp("readFile")) }

              return data
            })
          )
        }),
        writeFile: Effect.fn("Caller.writeFile")(
          function*(input: PathInput, bytes: Uint8Array, options: WriteFileOptions) {
            const prepared = preparePath(input, "writeFile", settings.maxPathBytes)

            if (!isAttachedBytes(bytes)) {
              return yield* new FsError({ code: "InvalidArgument", operation: "writeFile", path: input })
            }

            const captured = new Uint8Array(bytes)
            const { relativeTo: base, ...raw } = options
            const decoded = decodeWriteFileSettings(raw)

            if (Result.isFailure(decoded)) {
              return yield* new FsError({ code: "InvalidArgument", operation: "writeFile", path: input })
            }

            const chosen = decoded.success

            return yield* coordinated(
              "writeFile",
              Effect.gen(function*() {
                const path = yield* Effect.fromResult(prepared)

                if (chosen.create === "exclusive") {
                  const exists = yield* Effect.result(lookup(path, base, "writeFile", { followFinalSymlink: false }))

                  if (Result.isSuccess(exists)) {
                    return yield* new FsError({ code: "AlreadyExists", operation: "writeFile", path: input })
                  }

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
                  return yield* new FsError({ code: "IsDirectory", operation: "writeFile", path: input })
                }

                const replaced = resolved.node?.kind === "symlink" ? resolved.node : undefined

                if (replaced !== undefined && !chosen.replaceFinalSymlink) {
                  return yield* new FsError({ code: "SymlinkLoop", operation: "writeFile", path: input })
                }

                if (chosen.access === "read") {
                  return yield* new FsError({ code: "InvalidHandle", operation: "writeFile", path: input })
                }

                const file = resolved.node?.kind === "file" ? resolved.node : undefined

                if (file === undefined) {
                  yield* authorize(parent, identity, WRITE | EXECUTE, "writeFile", input)

                  if (replaced !== undefined) yield* authorizeRemoval(parent, replaced, "writeFile", input)

                  if (replaced === undefined && atEntryLimit()) {
                    return yield* new FsError({ code: "NoSpace", operation: "writeFile", path: input })
                  }
                } else {
                  yield* authorize(
                    file,
                    identity,
                    chosen.access === "readWrite" ? READ | WRITE : WRITE,
                    "writeFile",
                    input
                  )
                }

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

                if (size > maxFileBytes) {
                  return yield* new FsError({ code: "FileTooLarge", operation: "writeFile", path: input })
                }

                const reclaimed = replaced !== undefined && replaced.metadata.nlink === 1 ? replaced.target.length : 0

                if (
                  settings.maxBytes !== undefined &&
                  BigInt(size - previous) > ByteSize.toBigInt(settings.maxBytes) - state.usedBytes + BigInt(reclaimed)
                ) {
                  return yield* new FsError({ code: "NoSpace", operation: "writeFile", path: input })
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
                    // Assigned below on the shared path that also covers an existing file.
                    data: Content.empty(),
                    openCount: 0,
                    metadata: {
                      ...directoryMetadata(
                        state.nextInode++,
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
                  mode: finalMode ?? node.metadata.mode & ~SET_ID_BITS,
                  size: BigInt(size),
                  mtimeNs: now,
                  ctimeNs: now
                }
                advanceRevision(node)
                state.usedBytes += BigInt(size - previous)

                if (file === undefined) {
                  if (replaced !== undefined) detach(replaced, now)
                  attach(parent, name, node, now)

                  if (replaced === undefined) state.entries += 1
                  publishEntry(replaced === undefined ? "Create" : "Update", parent, name)
                } else publishNode(node)
              })
            )
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

          if (!Number.isInteger(bits) || bits < 0 || bits > (READ | WRITE | EXECUTE)) {
            return yield* new FsError({ code: "InvalidArgument", operation: "access", path: input })
          }

          return yield* coordinatedRead(
            "access",
            Effect.gen(function*() {
              const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "access")

              if (node.kind === "file" && (bits & EXECUTE) !== 0 && (node.metadata.mode & ANY_EXECUTE) === 0) {
                return yield* new FsError({ code: "AccessDenied", operation: "access", path: input })
              }

              yield* authorize(node, identity, bits, "access", input)
            })
          )
        }),
        truncate: Effect.fn("Caller.truncate")(function*(input: PathInput, length: bigint, options?: RelativeOptions) {
          const prepared = preparePath(input, "truncate", settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(
            "truncate",
            Effect.gen(function*() {
              const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "truncate")

              if (node.kind !== "file") {
                return yield* new FsError({ code: "IsDirectory", operation: "truncate", path: input })
              }

              yield* authorize(node, identity, WRITE, "truncate", input)
              yield* resize(node, length, "truncate")
            })
          )
        }),
        lstat: Effect.fn("Caller.lstat")(function*(input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "lstat", settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinatedRead(
            "lstat",
            Effect.gen(function*() {
              const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, "lstat", {
                followFinalSymlink: false
              })

              return { ...node.metadata }
            })
          )
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

            return yield* coordinated(
              "link",
              Effect.gen(function*() {
                const node = yield* resolveNode(yield* Effect.fromResult(a), sourceBase, "link", {
                  followFinalSymlink: follow
                })

                if (node.kind === "directory") {
                  return yield* new FsError({ code: "IsDirectory", operation: "link", path: source })
                }

                const path = yield* Effect.fromResult(b)
                const parent = yield* locate(path, destinationBase, "link", { parentOnly: true })
                yield* authorize(parent, identity, WRITE | EXECUTE, "link", destination)
                const name = path.components.at(-1)

                if (isDotComponent(name) || parent.entries.has(name)) {
                  return yield* new FsError({ code: "AlreadyExists", operation: "link", path: destination })
                }

                if (path.trailingSlash) {
                  return yield* new FsError({ code: "NotDirectory", operation: "link", path: destination })
                }

                if (atEntryLimit()) {
                  return yield* new FsError({ code: "NoSpace", operation: "link", path: destination })
                }

                const now = yield* timestamp("link")
                attach(parent, name, node, now)
                node.metadata = { ...node.metadata, nlink: node.metadata.nlink + 1, ctimeNs: now }
                advanceRevision(node)
                state.entries += 1
                publishEntry("Create", parent, name)
              })
            )
          }
        ),
        symlink: Effect.fn("Caller.symlink")(function*(target: PathInput, input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "symlink", settings.maxPathBytes)

          const rawTarget = inputBytes(target)

          if (Result.isFailure(rawTarget)) {
            return yield* new FsError({ code: rawTarget.failure, operation: "symlink", path: target })
          }

          if (rawTarget.success.includes(0)) {
            return yield* new FsError({ code: "InvalidArgument", operation: "symlink", path: target })
          }

          const targetBytes = new Uint8Array(rawTarget.success)
          const base = options?.relativeTo

          return yield* coordinated(
            "symlink",
            Effect.gen(function*() {
              const path = yield* Effect.fromResult(prepared)
              const bytes = targetBytes
              const parent = yield* locate(path, base, "symlink", { parentOnly: true })
              yield* authorize(parent, identity, WRITE | EXECUTE, "symlink", input)
              const name = path.components.at(-1)

              if (isDotComponent(name) || parent.entries.has(name)) {
                return yield* new FsError({ code: "AlreadyExists", operation: "symlink", path: input })
              }

              if (path.trailingSlash) {
                return yield* new FsError({ code: "NotDirectory", operation: "symlink", path: input })
              }

              if (
                atEntryLimit() ||
                (settings.maxBytes !== undefined &&
                  BigInt(bytes.length) > ByteSize.toBigInt(settings.maxBytes) - state.usedBytes)
              ) return yield* new FsError({ code: "NoSpace", operation: "symlink", path: input })
              const now = yield* timestamp("symlink")

              const node: SymbolicLink = {
                kind: "symlink",
                lineage: undefined,
                target: new Uint8Array(bytes),
                metadata: {
                  ...directoryMetadata(state.nextInode, identity.uid, parent.metadata.gid, 0o777, now),
                  kind: "symlink",
                  nlink: 1,
                  size: BigInt(bytes.length)
                },
                revision: nextRevision(),
                objectReference: undefined
              }

              attach(parent, name, node, now)
              state.nextInode += 1n
              state.entries += 1
              state.usedBytes += BigInt(bytes.length)
              publishEntry("Create", parent, name)
            })
          )
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
          const decoded = decodeOpenSettings(raw)

          if (Result.isFailure(decoded)) {
            return yield* new FsError({ code: "InvalidArgument", operation: "open", path: input })
          }

          const chosen = { ...decoded.success }

          if (chosen.access === "read" && (chosen.append || chosen.truncate)) {
            return yield* new FsError({ code: "InvalidArgument", operation: "open", path: input })
          }

          if (chosen.mode !== undefined && (chosen.create === undefined || chosen.create === "never")) {
            return yield* new FsError({ code: "InvalidArgument", operation: "open", path: input })
          }

          const acquired = makeFileReference(chosen.access, chosen.append ?? false)

          yield* Effect.addFinalizer(() => finalizeFile(acquired))

          return yield* coordinated(
            "open",
            Effect.gen(function*() {
              if (acquired.closed) return yield* Effect.interrupt
              const path = yield* Effect.fromResult(prepared)

              if (chosen.create === "exclusive") {
                const existing = yield* Effect.result(lookup(path, base, "open", { followFinalSymlink: false }))

                if (Result.isSuccess(existing)) {
                  return yield* new FsError({ code: "AlreadyExists", operation: "open", path: input })
                }

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

              if (parent === undefined) {
                return yield* new FsError({ code: "IsDirectory", operation: "open", path: input })
              }

              const name = resolved.name

              if (isDotComponent(name)) {
                return yield* new FsError({ code: "IsDirectory", operation: "open", path: input })
              }

              yield* authorize(parent, identity, EXECUTE, "open", input)
              let file = resolved.node

              if (file !== undefined && chosen.create === "exclusive") {
                return yield* new FsError({ code: "AlreadyExists", operation: "open", path: input })
              }

              if (file === undefined) {
                if (chosen.create === undefined || chosen.create === "never" || path.trailingSlash) {
                  return yield* new FsError({ code: "NotFound", operation: "open", path: input })
                }

                yield* authorize(parent, identity, WRITE | EXECUTE, "open", input)

                if (atEntryLimit()) {
                  return yield* new FsError({ code: "NoSpace", operation: "open", path: input })
                }

                const now = yield* timestamp("open")
                file = {
                  kind: "file",
                  lineage: undefined,
                  data: Content.empty(),
                  openCount: 0,
                  metadata: {
                    ...directoryMetadata(
                      state.nextInode,
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
                attach(parent, name, file, now)
                state.entries += 1
                state.nextInode += 1n
                publishEntry("Create", parent, name)
              } else {
                if (file.kind === "symlink") {
                  return yield* new FsError({ code: "SymlinkLoop", operation: "open", path: input })
                }

                if (file.kind !== "file") {
                  return yield* new FsError({ code: "IsDirectory", operation: "open", path: input })
                }

                if (path.trailingSlash) {
                  return yield* new FsError({ code: "NotDirectory", operation: "open", path: input })
                }

                yield* authorize(
                  file,
                  identity,
                  chosen.access === "read" ? READ : chosen.access === "write" ? WRITE : READ | WRITE,
                  "open",
                  input
                )

                if (chosen.truncate) yield* resize(file, 0n, "open")
              }

              file.openCount += 1
              acquired.file = file

              return fileHandle(acquired)
            })
          )
        }),
        unlink: Effect.fn("Caller.unlink")(function*(input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "unlink", settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(
            "unlink",
            Effect.gen(function*() {
              const path = yield* Effect.fromResult(prepared)
              const parent = yield* locate(path, base, "unlink", { parentOnly: true })
              yield* authorize(parent, identity, WRITE | EXECUTE, "unlink", input)
              const name = path.components.at(-1)

              if (isDotComponent(name)) {
                return yield* new FsError({ code: "IsDirectory", operation: "unlink", path: input })
              }

              const child = parent.entries.get(name)

              if (child === undefined) return yield* new FsError({ code: "NotFound", operation: "unlink", path: input })

              if (child.kind === "directory") {
                return yield* new FsError({ code: "IsDirectory", operation: "unlink", path: input })
              }

              if (path.trailingSlash) {
                return yield* new FsError({ code: "NotDirectory", operation: "unlink", path: input })
              }

              yield* authorizeRemoval(parent, child, "unlink", input)
              const now = yield* timestamp("unlink")
              parent.entries.delete(name)
              parent.metadata = { ...parent.metadata, mtimeNs: now, ctimeNs: now }
              advanceRevision(parent)
              detach(child, now)
              state.entries -= 1
              publishEntry("Remove", parent, name)
            })
          )
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

          return yield* coordinated(
            "rename",
            Effect.gen(function*() {
              const oldPath = yield* Effect.fromResult(oldPrepared)
              const newPath = yield* Effect.fromResult(newPrepared)
              const oldParent = yield* locate(oldPath, oldBase, "rename", { parentOnly: true })
              const newParent = yield* locate(newPath, newBase, "rename", { parentOnly: true })
              yield* authorize(oldParent, identity, WRITE | EXECUTE, "rename", source)
              yield* authorize(newParent, identity, WRITE | EXECUTE, "rename", destination)
              const oldName = oldPath.components.at(-1)
              const newName = newPath.components.at(-1)

              if (
                isDotComponent(oldName) || isDotComponent(newName)
              ) {
                return yield* new FsError({ code: "InvalidArgument", operation: "rename", path: source })
              }

              const child = oldParent.entries.get(oldName)

              if (child === undefined) {
                return yield* new FsError({ code: "NotFound", operation: "rename", path: source })
              }

              const replaced = newParent.entries.get(newName)

              if (newPath.trailingSlash && replaced === undefined) {
                return yield* new FsError({ code: "NotFound", operation: "rename", path: destination })
              }

              if (oldPath.trailingSlash && child.kind !== "directory") {
                return yield* new FsError({ code: "NotDirectory", operation: "rename", path: source })
              }

              if (newPath.trailingSlash && replaced?.kind !== "directory") {
                return yield* new FsError({ code: "NotDirectory", operation: "rename", path: destination })
              }

              if (child === replaced) return
              yield* authorizeRemoval(oldParent, child, "rename", source)

              if (replaced !== undefined) {
                yield* authorizeRemoval(newParent, replaced, "rename", destination)

                if (child.kind === "directory" && replaced.kind !== "directory") {
                  return yield* new FsError({ code: "NotDirectory", operation: "rename", path: destination })
                }

                if (child.kind !== "directory" && replaced.kind === "directory") {
                  return yield* new FsError({ code: "IsDirectory", operation: "rename", path: destination })
                }

                if (replaced.kind === "directory" && replaced.entries.size > 0) {
                  return yield* new FsError({ code: "NotEmpty", operation: "rename", path: destination })
                }
              }

              for (
                let ancestor: Directory | undefined = newParent;
                ancestor !== undefined;
                ancestor = ancestor.parent
              ) {
                if (ancestor === child) {
                  return yield* new FsError({ code: "InvalidArgument", operation: "rename", path: destination })
                }
              }

              const now = yield* timestamp("rename")

              // All rejection checks precede namespace, ancestry, quota, and metadata publication.
              const oldEvent = () =>
                ownedPath(nameBytes(directoryHex(oldParent) + (oldParent === state.root ? "" : SLASH_HEX) + oldName))

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
                state.entries -= 1
              }

              queuePublish(() => watchHub.publishUnsafe(() => ({ _tag: "Remove" as const, path: oldEvent() })))
              publishEntry("Create", newParent, newName)
            })
          )
        }),
        rmdir: Effect.fn("Caller.rmdir")(function*(input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "rmdir", settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(
            "rmdir",
            Effect.gen(function*() {
              const path = yield* Effect.fromResult(prepared)
              const parent = yield* locate(path, base, "rmdir", { parentOnly: true })
              yield* authorize(parent, identity, WRITE | EXECUTE, "rmdir", input)
              const name = path.components.at(-1)

              if (isDotComponent(name)) {
                return yield* new FsError({ code: "InvalidArgument", operation: "rmdir", path: input })
              }

              const child = parent.entries.get(name)

              if (child === undefined) return yield* new FsError({ code: "NotFound", operation: "rmdir", path: input })
              yield* authorizeRemoval(parent, child, "rmdir", input)

              if (child.kind !== "directory") {
                return yield* new FsError({ code: "NotDirectory", operation: "rmdir", path: input })
              }

              if (child.entries.size > 0) {
                return yield* new FsError({ code: "NotEmpty", operation: "rmdir", path: input })
              }

              const now = yield* timestamp("rmdir")
              parent.entries.delete(name)
              parent.metadata = { ...parent.metadata, nlink: parent.metadata.nlink - 1, mtimeNs: now, ctimeNs: now }
              child.parent = undefined
              child.metadata = { ...child.metadata, nlink: 0, ctimeNs: now }
              advanceRevision(parent)
              advanceRevision(child)
              invalidateReference(child)
              state.entries -= 1
              publishEntry("Remove", parent, name)
            })
          )
        }),
        stat: Effect.fn("Caller.stat")(function*(input: PathInput, options?: RelativeOptions) {
          const prepared = preparePath(input, "stat", settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinatedRead(
            "stat",
            Effect.gen(function*() {
              const path = yield* Effect.fromResult(prepared)
              const directory = yield* resolveNode(path, base, "stat")

              return { ...directory.metadata }
            })
          )
        }),
        mkdir: Effect.fn("Caller.mkdir")(
          function*(input: PathInput, options?: RelativeOptions & { readonly mode?: number }) {
            const prepared = preparePath(input, "mkdir", settings.maxPathBytes)
            const base = options?.relativeTo
            const mode = options?.mode === undefined ? 0o777 : options.mode

            if (!isMode(mode)) return yield* new FsError({ code: "InvalidArgument", operation: "mkdir", path: input })

            return yield* coordinated(
              "mkdir",
              Effect.gen(function*() {
                const path = yield* Effect.fromResult(prepared)
                const parent = yield* locate(path, base, "mkdir", { parentOnly: true })
                yield* authorize(parent, identity, WRITE | EXECUTE, "mkdir", input)
                const name = path.components.at(-1)

                if (isDotComponent(name) || parent.entries.has(name)) {
                  return yield* new FsError({ code: "AlreadyExists", operation: "mkdir", path: input })
                }

                if (atEntryLimit()) {
                  return yield* new FsError({ code: "NoSpace", operation: "mkdir", path: input })
                }

                const now = yield* timestamp("mkdir")

                const child: Directory = {
                  kind: "directory",
                  lineage: undefined,
                  parent,
                  entries: new Map(),
                  metadata: directoryMetadata(
                    state.nextInode,
                    identity.uid,
                    parent.metadata.gid,
                    (mode & 0o777 & ~umask) | (mode & STICKY_BIT),
                    now
                  ),
                  revision: nextRevision(),
                  objectReference: undefined
                }

                // No Effect yield or expected failure between these publication writes.
                attach(parent, name, child, now)
                state.nextInode += 1n
                state.entries += 1
                publishEntry("Create", parent, name)
              })
            )
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
            stat: coordinatedRead(
              "stat",
              Effect.suspend(() =>
                acquired.directory === undefined
                  ? Effect.fail(new FsError({ code: "InvalidHandle", operation: "stat" }))
                  : Effect.succeed({ ...acquired.directory.metadata })
              )
            ).pipe(Effect.withSpan("DirectoryHandle.stat")),
            close: coordinatedCleanup(Effect.suspend(() => {
              if (acquired.directory === undefined) {
                return Effect.fail(new FsError({ code: "InvalidHandle", operation: "close" }))
              }

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

    const baseObservation = Predicate.isTagged("Overlay")(source) ? yield* observeChanges() : undefined

    const publicChange = (change: RawOverlayChange): OverlayChange =>
      Predicate.isTagged("Renamed")(change)
        ? OverlayChange.make({ ...change, from: ownedPath(change.from), to: ownedPath(change.to) })
        : OverlayChange.make({ ...change, path: ownedPath(change.path) })

    const publicChanges = (changes: ReadonlyArray<RawOverlayChange>): ReadonlyArray<OverlayChange> =>
      Object.freeze(changes.map(publicChange))

    const changeOptions = (options?: OverlayChangesOptions) => {
      const decoded = decodeConfiguration(OverlayChangesOptions, options === undefined ? {} : options)

      return Result.isFailure(decoded) ? Effect.fail(decoded.failure) : Effect.succeed(decoded.success)
    }

    // An overlay is a spread copy of `volume`, so the object the caller holds is not always the one
    // built here. `watch` runs lazily, so it reads whichever surface was actually handed out.
    let surface: Volume

    const volume: Volume = Object.freeze({
      [VolumeId]: true as const,
      durability: "memory-only",
      identity,
      incarnation,
      limits,
      usage: coordinatedRead(
        "usage",
        Effect.sync((): VolumeUsage => ({ usedBytes: state.usedBytes, entries: state.entries }))
      )
        .pipe(
          Effect.withSpan("Volume.usage")
        ),
      watch: Effect.gen(function*() {
        const hook = TestHooks.getRegistrationHook(surface)

        return yield* admit("watch", watchHub.subscribe(hook?.afterSubscribe))
      }).pipe(Effect.withSpan("Volume.watch")),
      snapshot: coordinatedRead("snapshot", captureSnapshot()).pipe(Effect.withSpan("Volume.snapshot")),

      caller: Effect.fn("Volume.caller")(function*(options?: RootCallerOptions) {
        const decoded = decodeConfiguration(RootCallerOptions, options === undefined ? {} : options)

        if (Result.isFailure(decoded)) return yield* decoded.failure
        const chosen = decoded.success.identity ?? { uid: 0, gid: 0, groups: [], privileged: true }
        const identity = Object.freeze({ ...chosen, groups: Object.freeze([...chosen.groups]) })

        return yield* coordinatedRead(
          "caller",
          Effect.sync(() =>
            createCaller(
              makeDirectoryReference(state.root),
              identity,
              decoded.success.umask ?? 0o022
            )
          )
        )
      })
    })

    surface = volume

    if (!Predicate.isTagged("Overlay")(source) || baseObservation === undefined) {
      // SAFETY: Overlay sources return below, so S is non-Overlay here and VolumeFor<S> is Volume.
      return volume as VolumeFor<S>
    }

    const hook = TestHooks.getObservationHook(source.base)

    const overlay: OverlayVolume = Object.freeze({
      ...volume,
      changes: Effect.fn("OverlayVolume.changes")(function*(options?: OverlayChangesOptions) {
        const selected = yield* changeOptions(options)
        const current = yield* coordinatedRead("changes", observeChanges())

        return publicChanges(compareOverlay(baseObservation, current, selected.includeTimestamps ?? false))
      }),
      capture: Effect.fn("OverlayVolume.capture")(function*(options?: OverlayChangesOptions) {
        const selected = yield* changeOptions(options)
        const current = yield* coordinatedRead("capture", captureState(hook))

        return Object.freeze({
          snapshot: current.snapshot,
          changes: publicChanges(
            compareOverlay(baseObservation, current.observation, selected.includeTimestamps ?? false)
          )
        })
      })
    })

    surface = overlay

    return overlay
  }
)

/** @internal */
export const make = Effect.fn("VirtualFileSystem.make")(function*(options?: VolumeOptions) {
  return yield* makeVolume(VolumeSource.Empty(), options).pipe(Effect.catchTag("ImageError", Effect.die))
})

/** @internal */
export const prepareEmptyLiveImage = Effect.fnUntraced(function*(options?: VolumeOptions) {
  let bytes: Uint8Array | undefined

  yield* makeVolume(
    VolumeSource.Empty(),
    options,
    undefined,
    (initial, identity, limits) =>
      captureLiveImage(initial, identity, limits).pipe(
        Effect.tap((image) =>
          Effect.sync(() => {
            bytes = image
          })
        ),
        Effect.asVoid
      )
  )

  if (bytes === undefined) return yield* new ImageError({ code: "InvalidStructure", field: "liveImage" })

  return bytes
})

/** @internal */
export const openImageVolume = Effect.fnUntraced(function*(
  image: Uint8Array,
  maxImageBytes: ByteSize.ByteSize,
  commit: (image: Uint8Array) => Effect.Effect<"committed" | "rejected" | "unknown">
) {
  const document = yield* LiveImage.decode(image, maxImageBytes)
  const prepared = new WeakMap<EngineState, Uint8Array>()
  const identity = VolumeIdentity.make(document.identity)
  let shutdown: Effect.Effect<void> | undefined

  const limits: VolumeLimits = {
    maxEntries: document.limits.maxEntries,
    maxBytes: document.limits.maxBytes === undefined ? undefined : ByteSize.bytes(document.limits.maxBytes),
    maxFileBytes: document.limits.maxFileBytes === undefined
      ? ByteSize.bytes(0xffffffff)
      : ByteSize.bytes(document.limits.maxFileBytes),
    maxPathBytes: document.limits.maxPathBytes === undefined ? undefined : ByteSize.bytes(document.limits.maxPathBytes),
    maxPendingOperations: 64,
    maxWatchEvents: 256
  }

  const volume = yield* makeVolume(VolumeSource.Live({ document }), undefined, {
    onReady: (effect) => {
      shutdown = effect
    },
    prepare: (candidate) =>
      captureLiveImage(candidate, identity, limits).pipe(
        Effect.flatMap((bytes) =>
          ByteSize.isGreaterThan(ByteSize.bytes(bytes.length), maxImageBytes)
            ? new FsError({ code: "StorageRejected", operation: "commit" })
            : Effect.sync(() => {
              prepared.set(candidate, bytes)
            })
        ),
        Effect.mapError(() => new FsError({ code: "StorageRejected", operation: "commit" }))
      ),
    commit: (candidate) =>
      Effect.suspend(() => {
        const bytes = prepared.get(candidate)

        if (bytes === undefined) return Effect.succeed("unknown" as const)
        prepared.delete(candidate)

        return commit(bytes)
      })
  })

  if (shutdown === undefined) return yield* new ImageError({ code: "InvalidStructure", field: "liveImage" })

  return Object.freeze({ volume, shutdown })
})

/** @internal */
export const fromSnapshot = Effect.fn("VirtualFileSystem.fromSnapshot")(
  function*(snapshot: Snapshot, options?: VolumeOptions) {
    const image = yield* Image.inspect(snapshot)

    return yield* makeVolume(VolumeSource.Snapshot({ image }), options)
  }
)

/** @internal */
export const makeOverlay = Effect.fn("VirtualFileSystem.makeOverlay")(
  function*(base: Snapshot, options?: VolumeOptions) {
    const image = yield* Image.inspect(base)

    return yield* makeVolume(VolumeSource.Overlay({ base, image }), options)
  }
)
