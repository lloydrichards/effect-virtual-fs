// Runtime definitions and cohesive live virtual filesystem engine.
import * as ByteSize from "effect/ByteSize"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Option from "effect/Option"
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
import { ConfigurationError, decodeConfiguration, FsCode as FsCodeSchema, FsError, OpContext } from "./errors.js"
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

const decodeOwnerUpdate = Schema.decodeEffect(OwnerUpdate, { onExcessProperty: "error" })

const decodeTimes = Schema.decodeEffect(Times, { onExcessProperty: "error" })

const decodeWriteFileSettings = Schema.decodeEffect(WriteFileSettings, { onExcessProperty: "error" })

const decodeOpenSettings = Schema.decodeEffect(OpenSettings, { onExcessProperty: "error" })

const decodeMkdirReferenceSettings = Schema.decodeEffect(MkdirReferenceSettings, { onExcessProperty: "error" })

const decodeSymlinkReferenceSettings = Schema.decodeEffect(SymlinkReferenceSettings, { onExcessProperty: "error" })

const decodeOpenReferenceSettings = Schema.decodeEffect(OpenReferenceSettings, { onExcessProperty: "error" })

const decodeOpenChildReferenceSettings = Schema.decodeEffect(OpenChildReferenceSettings, { onExcessProperty: "error" })

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

// The namespace entry a path or a directory reference plus name resolves to, so each verb has one body. A
// path's final component can be absent or a dot and can carry a trailing slash; a reference name never does,
// so a body's checks for those cases never fire on references.
interface ResolvedEntry {
  readonly parent: Directory
  readonly name: string | undefined
  readonly trailingSlash: boolean
  // Names the path on path-addressed entries; the method's own context on reference-addressed ones.
  readonly op: OpContext
}

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
    ) => Effect.Effect<Uint8Array, ImageError>,
    durability: VolumeDurability = "memory-only"
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

    const decoded = yield* Effect.fromResult(
      decodeConfiguration(VolumeOptions, restoredOptions === undefined ? {} : restoredOptions)
    )

    const settings = { ...decoded }
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

    const timestamp = (op: OpContext) =>
      Effect.suspend(() => {
        const now = clock.currentTimeNanosUnsafe()

        return isTimestamp(now)
          ? Effect.succeed(now)
          : Effect.fail(op.fail("InvalidArgument"))
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
    const admission = yield* Semaphore.make(maxPendingOperations + 1)

    const admit = <A, E, R>(op: OpContext, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | FsError, R> =>
      admission.withPermitsIfAvailable(1)(effect).pipe(
        Effect.flatMap(Option.match({
          onNone: () => op.fail("VolumeBusy"),
          onSome: Effect.succeed
        }))
      )

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

    const initialImage = captureInitial === undefined ? undefined : yield* captureInitial(state, identity, limits)

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

        // copyState registers every candidate, so a miss is a broken invariant; stagedState reports the throw
        // as OutcomeUnknown and stops the volume.
        // TODO(#184): the candidate context disappears once staging is a commit decorator over a tree value.
        if (context === undefined) throw new Error("Staged candidate was published without its engine context")
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

    // Permit waits stay interruptible. Changes and their publication run under one permit.
    const coordinated = <A, E, R>(op: OpContext, effect: Effect.Effect<A, E, R>, onStorageFailure?: () => void) =>
      admit(
        op,
        staged === undefined
          ? gate.withPermit(Effect.uninterruptible(effect))
          : staged.mutate(op.operation, (candidate, emit) =>
            Effect.gen(function*() {
              const previous = state
              const context = contexts.get(candidate)

              if (context === undefined) return yield* Effect.die("Missing staged engine state")

              // The swap and the change run to completion as they do unstaged, and the swap is
              // undone however the change ends. Swapping outside this region would let an
              // interrupt land before the restore is installed.
              const value = yield* Effect.uninterruptible(
                Effect.sync(() => {
                  state = candidate
                  activeStage = context
                }).pipe(
                  Effect.andThen(effect),
                  Effect.ensuring(Effect.sync(() => {
                    state = previous
                    activeStage = undefined
                  }))
                )
              )

              for (const event of context.events) emit(event)

              return value
            }), onStorageFailure)
      )

    // Pure observations share the permit without making a candidate or calling the provider.
    const coordinatedRead = <A, E, R>(op: OpContext, effect: Effect.Effect<A, E, R>) =>
      admit(op, staged === undefined ? gate.withPermit(effect) : staged.read(op.operation, () => effect))

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

    const authorize = (node: Node, identity: Identity, bits: number, op: OpContext) => {
      if (identity.privileged) return Effect.void
      const metadata = node.metadata

      const shift = metadata.uid === identity.uid ?
        6
        : metadata.gid === identity.gid || identity.groups.includes(metadata.gid)
        ? 3
        : 0

      return ((metadata.mode >> shift) & bits) === bits
        ? Effect.void
        : Effect.fail(op.fail("AccessDenied"))
    }

    const reclaim = (file: RegularFile) => {
      if (file.metadata.nlink === 0 && file.openCount === 0) {
        state.usedBytes -= BigInt(file.data.bytes.length)
        file.data = Content.empty()
        state.retainedFiles.delete(file.metadata.ino)
        invalidateReference(file)
      }
    }

    // Whether the volume's entry quota is already full.
    const atEntryLimit = () => settings.maxEntries !== undefined && state.entries >= settings.maxEntries

    const reserveEntry = (op: OpContext) => atEntryLimit() ? Effect.fail(op.fail("NoSpace")) : Effect.void

    const reserveBytes = (op: OpContext, bytes: bigint) =>
      settings.maxBytes !== undefined && bytes > ByteSize.toBigInt(settings.maxBytes) - state.usedBytes
        ? Effect.fail(op.fail("NoSpace"))
        : Effect.void

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

    // A scope finalizer cannot fail, so a failed close falls back to cleanup and drops its error.
    // TODO(#180): acquireRelease makes explicit close and scope cleanup one finalizer, removing this fallback.
    const finalizeFile = (ref: FileReference) =>
      Effect.suspend(() =>
        ref.closed
          ? Effect.void
          : ref.file === undefined
          ? Effect.sync(() => {
            ref.closed = true
          })
          : coordinated(OpContext.make("close"), Effect.sync(() => releaseFile(ref)), () => releaseFile(ref)).pipe(
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

    const resize = Effect.fnUntraced(function*(file: RegularFile, length: bigint, op: OpContext, publish = true) {
      if (!Predicate.isBigInt(length) || length < 0n) {
        return yield* op.fail("InvalidArgument")
      }

      if (length > BigInt(maxFileBytes)) return yield* op.fail("FileTooLarge")
      const size = Number(length)

      if (
        settings.maxBytes !== undefined &&
        BigInt(size - file.data.bytes.length) > ByteSize.toBigInt(settings.maxBytes) - state.usedBytes
      ) {
        return yield* op.fail("NoSpace")
      }

      const data = new Uint8Array(size)
      data.set(file.data.bytes.subarray(0, size))
      replaceContent(file, data, yield* timestamp(op), publish)
    })

    const fileHandle = (ref: FileReference): FileHandle => {
      const get = (op: OpContext, access?: "read" | "write") =>
        ref.file === undefined || (access === "read" && ref.access === "write") ||
          (access === "write" && ref.access === "read")
          ? Effect.fail(op.fail("InvalidHandle"))
          : Effect.succeed(ref.file)

      const read = (maximum: number, position?: bigint) => {
        const op = OpContext.make(position === undefined ? "read" : "pread")
        // Failures past admission report "read" for both entry points.
        const readOp = OpContext.make("read")

        return coordinated(
          op,
          Effect.gen(function*() {
            const file = yield* get(op, "read")

            if (!isNatural(maximum)) return yield* readOp.fail("InvalidArgument")
            const offset = position ?? ref.offset

            if (!Predicate.isBigInt(offset) || offset < 0n || offset > MAX_FILE_OFFSET) {
              return yield* readOp.fail("InvalidArgument")
            }

            const start = Number(offset > file.metadata.size ? file.metadata.size : offset)
            const data = file.data.bytes.slice(start, start + Math.min(maximum, file.data.bytes.length - start))

            if (maximum > 0) {
              file.metadata = { ...file.metadata, atimeNs: (yield* timestamp(readOp)) }
            }

            if (position === undefined) ref.offset += BigInt(data.length)

            return data
          })
        )
      }

      const write = Effect.fnUntraced(function*(input: Uint8Array, position?: bigint) {
        const op = OpContext.make(position === undefined ? "write" : "pwrite")
        // Failures outside admission and the permitted handle report "write" for both entry points.
        const writeOp = OpContext.make("write")

        if (!isAttachedBytes(input)) return yield* writeOp.fail("InvalidArgument")

        const bytes = new Uint8Array(input)

        return yield* coordinated(
          op,
          Effect.gen(function*() {
            const file = yield* get(op, "write")
            const offset = position ?? (ref.append ? file.metadata.size : ref.offset)

            if (!Predicate.isBigInt(offset) || offset < 0n || offset > MAX_FILE_OFFSET) {
              return yield* writeOp.fail("InvalidArgument")
            }

            if (bytes.length === 0) {
              return 0
            }

            if (offset >= BigInt(maxFileBytes)) return yield* writeOp.fail("FileTooLarge")
            const start = Number(offset)

            const free = settings.maxBytes === undefined
              ? BigInt(maxFileBytes)
              : ByteSize.toBigInt(settings.maxBytes) - state.usedBytes

            const maximumEnd = BigInt(file.data.bytes.length) + free
            const end = Number(BigInt(maxFileBytes) < maximumEnd ? BigInt(maxFileBytes) : maximumEnd)
            const count = Math.min(bytes.length, Math.max(0, end - start))

            if (count === 0) return yield* writeOp.fail("NoSpace")
            const size = Math.max(file.data.bytes.length, start + count)
            // Always detach before mutation. A same-sized write is the critical
            // case: the current payload may belong to the base or a prior capture.
            const data = new Uint8Array(size)
            data.set(file.data.bytes)
            const now = yield* timestamp(writeOp)
            data.set(bytes.subarray(0, count), start)
            replaceContent(file, data, now)

            if (position === undefined) ref.offset = offset + BigInt(count)

            return count
          })
        )
      })

      // Eager members share one context each between admission and their own failures.
      const statOp = OpContext.make("stat")
      const syncOp = OpContext.make("sync")
      const closeOp = OpContext.make("close")

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
          const op = OpContext.make("seek")

          return yield* coordinatedRead(
            op,
            Effect.uninterruptible(Effect.gen(function*() {
              const file = yield* get(op)

              if (!Predicate.isBigInt(offset) || !isSeekMode(mode)) {
                return yield* op.fail("InvalidArgument")
              }

              let next = mode === "current"
                ? ref.offset + offset
                : mode === "end"
                ? file.metadata.size + offset
                : offset

              if (next < 0n || next > MAX_FILE_OFFSET) {
                return yield* op.fail("InvalidArgument")
              }

              if (mode === "data" || mode === "hole") {
                if (offset >= file.metadata.size) return yield* op.fail("NoData")

                if (mode === "hole") next = file.metadata.size
              }

              ref.offset = next

              return next
            }))
          )
        }),
        truncate: Effect.fn("FileHandle.truncate")(function*(length: bigint) {
          const op = OpContext.make("truncate")

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              yield* resize(yield* get(op, "write"), length, op)
            })
          )
        }),
        stat: coordinatedRead(
          statOp,
          Effect.gen(function*() {
            return { ...(yield* get(statOp)).metadata }
          })
        ).pipe(Effect.withSpan("FileHandle.stat")),
        sync: coordinatedRead(syncOp, Effect.suspend(() => Effect.asVoid(get(syncOp)))).pipe(
          Effect.withSpan("FileHandle.sync")
        ),
        close: coordinated(
          closeOp,
          Effect.gen(function*() {
            yield* get(closeOp)
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
      const referencedNode = Effect.fnUntraced(function*(target: ObjectReference, op: OpContext) {
        if (reference.directory === undefined) return yield* op.fail("ClosedCaller")

        if (!Predicate.isObject(target)) return yield* op.fail("InvalidReference")
        const state = objectReferences.get(target)

        if (state === undefined) return yield* op.fail("InvalidReference")

        if (state.volume !== volumeIdentity) {
          return yield* op.fail("ForeignReference")
        }

        if (!state.active || activeStage?.invalidated.has(state)) {
          return yield* op.fail("StaleReference")
        }

        const node = state.cell?.node

        if (node === undefined) return yield* op.fail("StaleReference")

        return node
      })

      const referencedName = Effect.fnUntraced(function*(input: Uint8Array, op: OpContext) {
        if (
          !isAttachedBytes(input) || input.length === 0 || input.length > MAX_NAME_BYTES || input.includes(0) ||
          input.includes(SLASH_BYTE)
        ) return yield* op.fail("InvalidArgument")
        const name = Encoding.encodeHex(new Uint8Array(input))

        if (isDotComponent(name)) return yield* op.fail("InvalidArgument")

        return name
      })

      const referencedDirectory = Effect.fnUntraced(function*(target: ObjectReference, op: OpContext) {
        const node = yield* referencedNode(target, op)

        if (node.kind !== "directory") return yield* op.fail("NotDirectory")

        return node
      })

      const creationTimes = (times: Times | undefined, now: bigint) => ({
        atimeNs: times?.access.kind === "value" ? times.access.nanoseconds : now,
        mtimeNs: times?.modification.kind === "value" ? times.modification.nanoseconds : now
      })

      const newDirectory = (parent: Directory, mode: number, now: bigint, times?: Times): Directory => ({
        kind: "directory",
        lineage: undefined,
        parent,
        entries: new Map(),
        metadata: {
          ...directoryMetadata(state.nextInode, identity.uid, parent.metadata.gid, mode, now),
          ...creationTimes(times, now)
        },
        revision: nextRevision(),
        objectReference: undefined
      })

      const newSymlink = (parent: Directory, target: Uint8Array, now: bigint, times?: Times): SymbolicLink => ({
        kind: "symlink",
        lineage: undefined,
        target,
        metadata: {
          ...directoryMetadata(state.nextInode, identity.uid, parent.metadata.gid, 0o777, now),
          ...creationTimes(times, now),
          kind: "symlink",
          nlink: 1,
          size: BigInt(target.length)
        },
        revision: nextRevision(),
        objectReference: undefined
      })

      const lookup = Effect.fnUntraced(function*(
        path: PreparedPath,
        base: DirectoryHandle | undefined,
        op: OpContext,
        options: LookupOptions = {},
        referencedBase?: Directory
      ) {
        const pathOp = op.at(path.input)
        const { followFinalSymlink = true, allowMissing = false, parentOnly = false } = options

        if (reference.directory === undefined) {
          return yield* pathOp.fail("ClosedCaller")
        }

        let current: Node = path.absolute ? state.root : reference.directory

        if (!path.absolute && referencedBase !== undefined) {
          current = referencedBase
          yield* authorize(current, identity, EXECUTE, op)
        } else if (!path.absolute && base !== undefined) {
          const target = handles.get(base)

          if (target === undefined) {
            return yield* pathOp.fail("InvalidHandle")
          }

          if (target.volume !== volumeIdentity) {
            return yield* pathOp.fail("ForeignHandle")
          }

          if (target.directory === undefined) {
            return yield* pathOp.fail("InvalidHandle")
          }

          current = target.directory
          yield* authorize(current, identity, EXECUTE, pathOp)
        }

        if (current.metadata.nlink === 0) {
          return yield* pathOp.fail("NotFound")
        }

        let work = path
        let parent: Directory | undefined
        let name: string | undefined
        let traversals = 0

        for (let index = 0; index < work.components.length - (parentOnly ? 1 : 0); index++) {
          if (current.kind !== "directory") {
            return yield* pathOp.fail("NotDirectory")
          }

          yield* authorize(current, identity, EXECUTE, pathOp)
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

            return yield* pathOp.fail("NotFound")
          }

          if (
            child.kind === "symlink" && (followFinalSymlink || index < work.components.length - 1 || work.trailingSlash)
          ) {
            if (child.target.length === 0) {
              return yield* pathOp.fail("NotFound")
            }

            if (++traversals > 40) {
              return yield* pathOp.fail("SymlinkLoop")
            }

            const suffix = work.suffixes[index] ?? new Uint8Array(0)

            if (
              settings.maxPathBytes !== undefined &&
              ByteSize.isGreaterThan(ByteSize.bytes(child.target.length + suffix.length), settings.maxPathBytes)
            ) {
              return yield* pathOp.fail("PathTooLong")
            }

            const expansion = new Uint8Array(child.target.length + suffix.length)
            expansion.set(child.target)
            expansion.set(suffix, child.target.length)
            const expanded = preparePath(ownedPath(expansion), op.operation, settings.maxPathBytes)

            // The expansion is synthetic: its per-component limits are the caller's to hear about,
            // but the path in the error has to be the one the caller passed in, so the
            // expansion's own failure is not kept as the cause.
            if (Result.isFailure(expanded)) {
              return yield* pathOp.fail(expanded.failure.code)
            }

            work = expanded.success

            if (work.absolute) current = state.root
            index = -1
          } else current = child
        }

        if (!parentOnly && work.trailingSlash && current.kind !== "directory") {
          return yield* pathOp.fail("NotDirectory")
        }

        return { node: current, parent, name }
      })

      const resolveNode = Effect.fnUntraced(
        function*(
          path: PreparedPath,
          base: DirectoryHandle | undefined,
          op: OpContext,
          options?: Pick<LookupOptions, "followFinalSymlink">
        ) {
          const pathOp = op.at(path.input)
          const result = yield* lookup(path, base, op, options)

          if (result.node === undefined) {
            return yield* pathOp.fail("NotFound")
          }

          return result.node
        }
      )

      const locate = Effect.fnUntraced(
        function*(
          path: PreparedPath,
          base: DirectoryHandle | undefined,
          op: OpContext,
          options?: Pick<LookupOptions, "parentOnly">
        ) {
          const pathOp = op.at(path.input)
          const result = yield* lookup(path, base, op, options)
          const node = result.node

          if (node === undefined) {
            return yield* pathOp.fail("NotFound")
          }

          if (node.kind !== "directory") {
            return yield* pathOp.fail("NotDirectory")
          }

          return node
        }
      )

      const ResolvedEntry = {
        // Takes a path whose preparation already succeeded, so a verb with two paths reports either one's
        // preparation failure before locating any parent.
        fromPath: Effect.fnUntraced(function*(path: PreparedPath, base: DirectoryHandle | undefined, op: OpContext) {
          const parent = yield* locate(path, base, op, { parentOnly: true })

          return {
            parent,
            name: path.components.at(-1),
            trailingSlash: path.trailingSlash,
            op: op.at(path.input)
          } satisfies ResolvedEntry
        }),
        // Takes a name the caller validated before coordination, so a bad name outranks the reference.
        fromReference: Effect.fnUntraced(function*(directoryReference: ObjectReference, name: string, op: OpContext) {
          const parent = yield* referencedDirectory(directoryReference, op)

          return { parent, name, trailingSlash: false, op } satisfies ResolvedEntry
        })
      }

      const acquireDirectory = Effect.fnUntraced(
        function*(input: PathInput, options: RelativeOptions | undefined, op: OpContext) {
          const pathOp = op.at(input)
          const prepared = preparePath(input, op.operation, settings.maxPathBytes)
          const base = options?.relativeTo
          const acquired = makeDirectoryReference()
          // Register before retaining a directory. Closed scopes can run this immediately,
          // so registration must not happen while holding the volume permit.
          yield* Effect.addFinalizer(() => release(acquired))

          return yield* coordinatedRead(
            op,
            Effect.uninterruptible(Effect.gen(function*() {
              if (acquired.closed) return yield* Effect.interrupt
              const path = yield* Effect.fromResult(prepared)
              const directory = yield* locate(path, base, op)
              yield* authorize(directory, identity, EXECUTE, pathOp)
              acquired.directory = directory

              return acquired
            }))
          )
        }
      )

      const list = Effect.fnUntraced(function*(input: PathInput, options?: RelativeOptions) {
        const op = OpContext.make("readDirectory")
        const pathOp = op.at(input)
        const prepared = preparePath(input, op.operation, settings.maxPathBytes)
        const base = options?.relativeTo

        return yield* coordinated(
          op,
          Effect.gen(function*() {
            const directory = yield* locate(yield* Effect.fromResult(prepared), base, op)
            yield* authorize(directory, identity, READ, pathOp)
            const result = [...directory.entries.keys()].map(nameBytes)
            directory.metadata = { ...directory.metadata, atimeNs: (yield* timestamp(op)) }

            return result
          })
        )
      })

      const readTarget = Effect.fnUntraced(function*(input: PathInput, options?: RelativeOptions) {
        const op = OpContext.make("readLink")
        const pathOp = op.at(input)
        const prepared = preparePath(input, op.operation, settings.maxPathBytes)
        const base = options?.relativeTo

        return yield* coordinatedRead(
          op,
          Effect.gen(function*() {
            const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, op, {
              followFinalSymlink: false
            })

            if (node.kind !== "symlink") {
              return yield* pathOp.fail("InvalidArgument")
            }

            return new Uint8Array(node.target)
          })
        )
      })

      const canonical = Effect.fnUntraced(function*(input: PathInput, options?: RelativeOptions) {
        const op = OpContext.make("realPath")
        const pathOp = op.at(input)
        const prepared = preparePath(input, op.operation, settings.maxPathBytes)
        const base = options?.relativeTo

        return yield* coordinatedRead(
          op,
          Effect.gen(function*() {
            const result = yield* lookup(yield* Effect.fromResult(prepared), base, op)
            const components: Array<string> = []

            if (result.node?.kind !== "directory" && result.name !== undefined) components.push(result.name)
            let directory = result.node?.kind === "directory" ? result.node : result.parent

            while (directory !== undefined && directory.parent !== undefined) {
              const parent: Directory = directory.parent
              const entry = [...parent.entries].find(([, child]) => child === directory)

              if (entry === undefined) {
                return yield* pathOp.fail("NotFound")
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
          op: OpContext
        ) {
          if (reference.directory === undefined) {
            return yield* op.fail("ClosedCaller")
          }

          if (isFileHandle(target) || isDirectoryHandle(target)) {
            const ref = isFileHandle(target) ? files.get(target) : handles.get(target)

            if (ref === undefined) return yield* op.fail("InvalidHandle")

            if (ref.volume !== volumeIdentity) {
              return yield* op.fail("ForeignHandle")
            }

            const node = "file" in ref ? ref.file : ref.directory

            if (node === undefined) return yield* op.fail("InvalidHandle")

            return node
          }

          const path = yield* Effect.fromResult(preparePath(target, op.operation, settings.maxPathBytes))

          return yield* resolveNode(path, options?.relativeTo, op, {
            followFinalSymlink: options?.followFinalSymlink !== false
          })
        }
      )

      const permittedMode = (metadata: Pick<Metadata, "kind" | "uid" | "gid">, mode: number, op: OpContext) => {
        if (!identity.privileged && identity.uid !== metadata.uid) {
          return Effect.fail(op.fail("AccessDenied"))
        }

        const group = identity.gid === metadata.gid || identity.groups.includes(metadata.gid)

        return Effect.succeed(!identity.privileged && metadata.kind === "file" && !group ? mode & ~0o2000 : mode)
      }

      const changeMode = Effect.fnUntraced(
        function*(target: PathInput | FileHandle | DirectoryHandle, mode: number, options?: MetadataOptions) {
          const op = OpContext.make("chmod")

          if (!isMode(mode)) return yield* op.fail("InvalidArgument")
          const chosen = options === undefined ? undefined : { ...options }

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const node = yield* metadataNode(target, chosen, op)
              const permitted = yield* permittedMode(node.metadata, mode, op)
              node.metadata = {
                ...node.metadata,
                mode: permitted,
                ctimeNs: (yield* timestamp(op))
              }
              advanceRevision(node)
              publishNode(node)
            })
          )
        }
      )

      const changeOwner = Effect.fnUntraced(
        function*(target: PathInput | FileHandle | DirectoryHandle, owner: OwnerUpdate, options?: MetadataOptions) {
          const op = OpContext.make("chown")

          const decoded = yield* decodeOwnerUpdate(owner).pipe(
            Effect.mapError((cause) => op.fail("InvalidArgument", { cause }))
          )

          const update = { ...decoded }
          const chosen = options === undefined ? undefined : { ...options }

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const node = yield* metadataNode(target, chosen, op)

              if (
                !identity.privileged && (identity.uid !== node.metadata.uid ||
                  (update.uid !== undefined && update.uid !== node.metadata.uid) ||
                  (update.gid !== undefined && update.gid !== identity.gid && !identity.groups.includes(update.gid)))
              ) {
                return yield* op.fail("AccessDenied")
              }

              if (update.uid === undefined && update.gid === undefined) return
              node.metadata = {
                ...node.metadata,
                uid: update.uid ?? node.metadata.uid,
                gid: update.gid ?? node.metadata.gid,
                mode: node.kind === "file" ? node.metadata.mode & ~SET_ID_BITS : node.metadata.mode,
                ctimeNs: (yield* timestamp(op))
              }
              advanceRevision(node)
              publishNode(node)
            })
          )
        }
      )

      const changeTimes = Effect.fnUntraced(
        function*(target: PathInput | FileHandle | DirectoryHandle, times: Times, options?: MetadataOptions) {
          const op = OpContext.make("utimes")

          const decoded = yield* decodeTimes(times).pipe(
            Effect.mapError((cause) => op.fail("InvalidArgument", { cause }))
          )

          const access = { ...decoded.access }
          const modification = { ...decoded.modification }
          const chosen = options === undefined ? undefined : { ...options }

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const node = yield* metadataNode(target, chosen, op)

              if (access.kind === "omit" && modification.kind === "omit") return

              // POSIX grants write access only when both times are UTIME_NOW; both UTIME_OMIT
              // returned above. Every other combination, mixed ones included, needs ownership.
              if (!identity.privileged && identity.uid !== node.metadata.uid) {
                const path = pathOf(target)
                // A handle has no caller path, so its denial names none.
                const located = path === undefined ? op : op.at(path)

                if (access.kind !== "now" || modification.kind !== "now") {
                  return yield* located.fail("AccessDenied")
                }

                yield* authorize(node, identity, WRITE, located)
              }

              const now = yield* timestamp(op)
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

      const authorizeRemoval = (parent: Directory, child: Node, op: OpContext) =>
        (parent.metadata.mode & STICKY_BIT) !== 0 && !identity.privileged &&
          identity.uid !== parent.metadata.uid && identity.uid !== child.metadata.uid
          ? Effect.fail(op.fail("AccessDenied"))
          : Effect.void

      // Authorizes creating the entry and returns its name. Only a path can name a dot entry, and one always
      // exists, so it fails as AlreadyExists.
      const claimName = Effect.fnUntraced(function*(entry: ResolvedEntry) {
        yield* authorize(entry.parent, identity, WRITE | EXECUTE, entry.op)

        if (isDotComponent(entry.name) || entry.parent.entries.has(entry.name)) {
          return yield* entry.op.fail("AlreadyExists")
        }

        return entry.name
      })

      const makeDirectory = Effect.fnUntraced(function*(
        entry: ResolvedEntry,
        request: {
          readonly mode: number
          readonly exactMode?: boolean | undefined
          readonly times?: Times | undefined
        },
        op: OpContext
      ) {
        const parent = entry.parent
        const name = yield* claimName(entry)

        yield* reserveEntry(entry.op)
        const before = parent.revision
        const now = yield* timestamp(op)

        const mode = request.exactMode
          ? yield* permittedMode({ kind: "directory", uid: identity.uid, gid: parent.metadata.gid }, request.mode, op)
          : (request.mode & 0o777 & ~umask) | (request.mode & STICKY_BIT)

        const child = newDirectory(parent, mode, now, request.times)

        // No Effect yield or expected failure between these publication writes.
        attach(parent, name, child, now)
        state.nextInode += 1n
        state.entries += 1
        publishEntry("Create", parent, name)

        return { child, directory: { before, after: parent.revision } }
      })

      const linkNode = Effect.fnUntraced(
        function*(node: Exclude<Node, Directory>, entry: ResolvedEntry, op: OpContext) {
          const parent = entry.parent
          const name = yield* claimName(entry)

          if (entry.trailingSlash) return yield* entry.op.fail("NotDirectory")
          yield* reserveEntry(entry.op)
          const before = parent.revision
          const now = yield* timestamp(op)
          attach(parent, name, node, now)
          node.metadata = { ...node.metadata, nlink: node.metadata.nlink + 1, ctimeNs: now }
          advanceRevision(node)
          state.entries += 1
          publishEntry("Create", parent, name)

          return { before, after: parent.revision }
        }
      )

      // Takes target bytes the caller already copied, so nothing else holds them.
      const makeSymlink = Effect.fnUntraced(function*(
        entry: ResolvedEntry,
        target: Uint8Array,
        times: Times | undefined,
        op: OpContext
      ) {
        const parent = entry.parent
        const name = yield* claimName(entry)

        if (entry.trailingSlash) return yield* entry.op.fail("NotDirectory")
        yield* reserveEntry(entry.op)
        yield* reserveBytes(entry.op, BigInt(target.length))
        const before = parent.revision
        const now = yield* timestamp(op)
        const child = newSymlink(parent, target, now, times)

        attach(parent, name, child, now)
        state.nextInode += 1n
        state.entries += 1
        state.usedBytes += BigInt(target.length)
        publishEntry("Create", parent, name)

        return { child, directory: { before, after: parent.revision } }
      })

      // A directory's ".." entry was a link to the parent, so removing one drops the parent's link count.
      const removeChild = Effect.fnUntraced(function*(parent: Directory, name: string, child: Node, op: OpContext) {
        const before = parent.revision
        const now = yield* timestamp(op)
        parent.entries.delete(name)
        parent.metadata = {
          ...parent.metadata,
          nlink: parent.metadata.nlink - (child.kind === "directory" ? 1 : 0),
          mtimeNs: now,
          ctimeNs: now
        }
        advanceRevision(parent)
        detach(child, now)
        state.entries -= 1
        publishEntry("Remove", parent, name)

        return { before, after: parent.revision }
      })

      // Authorizes removing from the entry's directory and returns the named child. Only a path can name a dot
      // entry, and each verb reports it with its own code.
      const removalTarget = Effect.fnUntraced(function*(
        entry: ResolvedEntry,
        dotNameCode: "IsDirectory" | "InvalidArgument"
      ) {
        yield* authorize(entry.parent, identity, WRITE | EXECUTE, entry.op)

        if (isDotComponent(entry.name)) return yield* entry.op.fail(dotNameCode)
        const child = entry.parent.entries.get(entry.name)

        if (child === undefined) return yield* entry.op.fail("NotFound")

        return { name: entry.name, child }
      })

      // Removes a file or an empty directory; only references reach it, so a dot name never does.
      const removeEntry = Effect.fnUntraced(function*(entry: ResolvedEntry, op: OpContext) {
        const parent = entry.parent
        const { name, child } = yield* removalTarget(entry, "InvalidArgument")
        yield* authorizeRemoval(parent, child, entry.op)

        if (child.kind === "directory" && child.entries.size > 0) return yield* entry.op.fail("NotEmpty")

        return yield* removeChild(parent, name, child, op)
      })

      const unlinkEntry = Effect.fnUntraced(function*(entry: ResolvedEntry, op: OpContext) {
        const parent = entry.parent
        const { name, child } = yield* removalTarget(entry, "IsDirectory")

        if (child.kind === "directory") return yield* entry.op.fail("IsDirectory")

        if (entry.trailingSlash) return yield* entry.op.fail("NotDirectory")
        yield* authorizeRemoval(parent, child, entry.op)

        return yield* removeChild(parent, name, child, op)
      })

      // Needs no trailing-slash check: anything it removes is a directory.
      const rmdirEntry = Effect.fnUntraced(function*(entry: ResolvedEntry, op: OpContext) {
        const parent = entry.parent
        const { name, child } = yield* removalTarget(entry, "InvalidArgument")
        yield* authorizeRemoval(parent, child, entry.op)

        if (child.kind !== "directory") return yield* entry.op.fail("NotDirectory")

        if (child.entries.size > 0) return yield* entry.op.fail("NotEmpty")

        return yield* removeChild(parent, name, child, op)
      })

      const renameEntry = Effect.fnUntraced(
        function*(source: ResolvedEntry, destination: ResolvedEntry, op: OpContext) {
          const sourceDirectory = source.parent
          const destinationDirectory = destination.parent
          const sourceName = source.name
          const destinationName = destination.name
          yield* authorize(sourceDirectory, identity, WRITE | EXECUTE, source.op)
          yield* authorize(destinationDirectory, identity, WRITE | EXECUTE, destination.op)

          // Both dot names report against the source path.
          if (isDotComponent(sourceName) || isDotComponent(destinationName)) {
            return yield* source.op.fail("InvalidArgument")
          }

          const sourceBefore = sourceDirectory.revision
          const destinationBefore = destinationDirectory.revision
          const child = sourceDirectory.entries.get(sourceName)

          if (child === undefined) return yield* source.op.fail("NotFound")
          const replaced = destinationDirectory.entries.get(destinationName)

          if (destination.trailingSlash && replaced === undefined) {
            return yield* destination.op.fail("NotFound")
          }

          if (source.trailingSlash && child.kind !== "directory") {
            return yield* source.op.fail("NotDirectory")
          }

          if (destination.trailingSlash && replaced?.kind !== "directory") {
            return yield* destination.op.fail("NotDirectory")
          }

          const result = () =>
            sourceDirectory === destinationDirectory
              ? {
                _tag: "SameDirectory" as const,
                directory: { before: sourceBefore, after: sourceDirectory.revision }
              }
              : {
                _tag: "DifferentDirectories" as const,
                sourceDirectory: { before: sourceBefore, after: sourceDirectory.revision },
                destinationDirectory: { before: destinationBefore, after: destinationDirectory.revision }
              }

          if (child === replaced) return result()
          yield* authorizeRemoval(sourceDirectory, child, source.op)

          if (replaced !== undefined) {
            yield* authorizeRemoval(destinationDirectory, replaced, destination.op)

            if (child.kind === "directory" && replaced.kind !== "directory") {
              return yield* destination.op.fail("NotDirectory")
            }

            if (child.kind !== "directory" && replaced.kind === "directory") {
              return yield* destination.op.fail("IsDirectory")
            }

            if (replaced.kind === "directory" && replaced.entries.size > 0) {
              return yield* destination.op.fail("NotEmpty")
            }
          }

          for (
            let ancestor: Directory | undefined = destinationDirectory;
            ancestor !== undefined;
            ancestor = ancestor.parent
          ) {
            if (ancestor === child) return yield* destination.op.fail("InvalidArgument")
          }

          const now = yield* timestamp(op)

          // Every rejection above precedes the namespace and metadata writes below.
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
            nlink: destinationDirectory.metadata.nlink + (child.kind === "directory" && replaced === undefined ? 1 : 0),
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

          return result()
        }
      )

      const rootReferenceOp = OpContext.make("rootReference")

      return Object.freeze({
        [CallerId]: true as const,
        rootReference: coordinatedRead(
          rootReferenceOp,
          Effect.gen(function*() {
            if (reference.directory === undefined) {
              return yield* rootReferenceOp.fail("ClosedCaller")
            }

            return referenceFor(state.root)
          })
        ).pipe(Effect.withSpan("Caller.rootReference")),
        lookupReference: Effect.fn("Caller.lookupReference")(function*(directoryReference, name) {
          const op = OpContext.make("lookupReference")

          if (
            !isAttachedBytes(name) || name.length === 0 || name.length > MAX_NAME_BYTES || name.includes(0) ||
            name.includes(SLASH_BYTE)
          ) return yield* op.fail("InvalidArgument")
          const key = Encoding.encodeHex(new Uint8Array(name))

          if (isDotComponent(key)) return yield* op.fail("InvalidArgument")

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const directory = yield* referencedNode(directoryReference, op)

              if (directory.kind !== "directory") {
                return yield* op.fail("NotDirectory")
              }

              // TODO(#186): a reference has no caller path, so this and parentReference and observeDirectory pass "/"
              // to authorize, while reference mutations name no path; settle one rule with the public error family.
              yield* authorize(directory, identity, EXECUTE, op.at("/"))
              const child = directory.entries.get(key)

              if (child === undefined) return yield* op.fail("NotFound")

              return referenceFor(child)
            })
          )
        }),
        parentReference: Effect.fn("Caller.parentReference")(function*(directoryReference) {
          const op = OpContext.make("parentReference")

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const directory = yield* referencedNode(directoryReference, op)

              if (directory.kind !== "directory") {
                return yield* op.fail("NotDirectory")
              }

              yield* authorize(directory, identity, EXECUTE, op.at("/"))

              return referenceFor(directory.parent ?? directory)
            })
          )
        }),
        observeMetadata: Effect.fn("Caller.observeMetadata")(function*(objectReference) {
          const op = OpContext.make("observeMetadata")

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, op)

              return Object.freeze({ value: Object.freeze({ ...node.metadata }), revision: node.revision })
            })
          )
        }),
        accessReference: Effect.fn("Caller.accessReference")(function*(objectReference, bits = 0) {
          const op = OpContext.make("accessReference")

          if (!Number.isInteger(bits) || bits < 0 || bits > (READ | WRITE | EXECUTE)) {
            return yield* op.fail("InvalidArgument")
          }

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, op)

              if (node.kind === "file" && (bits & EXECUTE) !== 0 && (node.metadata.mode & ANY_EXECUTE) === 0) {
                return yield* op.fail("AccessDenied")
              }

              yield* authorize(node, identity, bits, op)
            })
          )
        }),
        observeDirectory: Effect.fn("Caller.observeDirectory")(function*(directoryReference) {
          const op = OpContext.make("observeDirectory")

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const directory = yield* referencedNode(directoryReference, op)

              if (directory.kind !== "directory") {
                return yield* op.fail("NotDirectory")
              }

              yield* authorize(directory, identity, READ, op.at("/"))

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
          const op = OpContext.make("readLinkReference")

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, op)

              if (node.kind !== "symlink") {
                return yield* op.fail("InvalidArgument")
              }

              return new Uint8Array(node.target)
            })
          )
        }),
        mkdirReference: Effect.fn("Caller.mkdirReference")(function*(directoryReference, input, raw = {}) {
          const op = OpContext.make("mkdirReference")
          const name = yield* referencedName(input, op)

          const decoded = yield* decodeMkdirReferenceSettings(raw).pipe(
            Effect.mapError((cause) => op.fail("InvalidArgument", { cause }))
          )

          const chosen = { ...decoded }

          if (chosen.exactMode && chosen.mode === undefined) {
            return yield* op.fail("InvalidArgument")
          }

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const entry = yield* ResolvedEntry.fromReference(directoryReference, name, op)

              const { child, directory } = yield* makeDirectory(
                entry,
                { mode: chosen.mode ?? 0o777, exactMode: chosen.exactMode, times: chosen.times },
                op
              )

              return { reference: referenceFor(child), directory }
            })
          )
        }),
        symlinkReference: Effect.fn("Caller.symlinkReference")(
          function*(target, directoryReference, input, raw = {}) {
            const op = OpContext.make("symlinkReference")
            const name = yield* referencedName(input, op)

            const decoded = yield* decodeSymlinkReferenceSettings(raw).pipe(
              Effect.mapError((cause) => op.fail("InvalidArgument", { cause }))
            )

            const rawTarget = inputBytes(target)

            if (Result.isFailure(rawTarget)) {
              return yield* op.fail(rawTarget.failure)
            }

            if (rawTarget.success.includes(0)) {
              return yield* op.fail("InvalidArgument")
            }

            const targetBytes = new Uint8Array(rawTarget.success)
            const chosen = { ...decoded }

            return yield* coordinated(
              op,
              Effect.gen(function*() {
                const entry = yield* ResolvedEntry.fromReference(directoryReference, name, op)
                const { child, directory } = yield* makeSymlink(entry, targetBytes, chosen.times, op)

                return { reference: referenceFor(child), directory }
              })
            )
          }
        ),
        linkReference: Effect.fn("Caller.linkReference")(
          function*(sourceReference, directoryReference, input) {
            const op = OpContext.make("linkReference")
            const name = yield* referencedName(input, op)

            return yield* coordinated(
              op,
              Effect.gen(function*() {
                const node = yield* referencedNode(sourceReference, op)

                if (node.kind === "directory") {
                  return yield* op.fail("IsDirectory")
                }

                if (node.metadata.nlink === 0) {
                  return yield* op.fail("StaleReference")
                }

                const entry = yield* ResolvedEntry.fromReference(directoryReference, name, op)
                const directory = yield* linkNode(node, entry, op)

                return { reference: referenceFor(node), directory }
              })
            )
          }
        ),
        unlinkReference: Effect.fn("Caller.unlinkReference")(function*(directoryReference, input) {
          const op = OpContext.make("unlinkReference")
          const name = yield* referencedName(input, op)

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const entry = yield* ResolvedEntry.fromReference(directoryReference, name, op)

              return yield* unlinkEntry(entry, op)
            })
          )
        }),
        rmdirReference: Effect.fn("Caller.rmdirReference")(function*(directoryReference, input) {
          const op = OpContext.make("rmdirReference")
          const name = yield* referencedName(input, op)

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const entry = yield* ResolvedEntry.fromReference(directoryReference, name, op)

              return yield* rmdirEntry(entry, op)
            })
          )
        }),
        removeReference: Effect.fn("Caller.removeReference")(function*(directoryReference, input) {
          const op = OpContext.make("removeReference")
          const name = yield* referencedName(input, op)

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const entry = yield* ResolvedEntry.fromReference(directoryReference, name, op)

              return yield* removeEntry(entry, op)
            })
          )
        }),
        renameReference: Effect.fn("Caller.renameReference")(
          function*(sourceDirectoryReference, sourceInput, destinationDirectoryReference, destinationInput) {
            const op = OpContext.make("renameReference")
            const sourceName = yield* referencedName(sourceInput, op)
            const destinationName = yield* referencedName(destinationInput, op)

            return yield* coordinated(
              op,
              Effect.gen(function*() {
                const source = yield* ResolvedEntry.fromReference(sourceDirectoryReference, sourceName, op)

                const destination = yield* ResolvedEntry.fromReference(
                  destinationDirectoryReference,
                  destinationName,
                  op
                )

                return yield* renameEntry(source, destination, op)
              })
            )
          }
        ),
        chmodReference: Effect.fn("Caller.chmodReference")(function*(objectReference, mode) {
          const op = OpContext.make("chmodReference")

          if (!isMode(mode)) return yield* op.fail("InvalidArgument")

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, op)
              const permitted = yield* permittedMode(node.metadata, mode, op)
              node.metadata = { ...node.metadata, mode: permitted, ctimeNs: (yield* timestamp(op)) }
              advanceRevision(node)
              publishNode(node)
            })
          )
        }),
        chownReference: Effect.fn("Caller.chownReference")(function*(objectReference, owner) {
          const op = OpContext.make("chownReference")

          const decoded = yield* decodeOwnerUpdate(owner).pipe(
            Effect.mapError((cause) => op.fail("InvalidArgument", { cause }))
          )

          const update = { ...decoded }

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, op)

              if (
                !identity.privileged && (identity.uid !== node.metadata.uid ||
                  (update.uid !== undefined && update.uid !== node.metadata.uid) ||
                  (update.gid !== undefined && update.gid !== identity.gid && !identity.groups.includes(update.gid)))
              ) return yield* op.fail("AccessDenied")

              if (update.uid === undefined && update.gid === undefined) return
              node.metadata = {
                ...node.metadata,
                uid: update.uid ?? node.metadata.uid,
                gid: update.gid ?? node.metadata.gid,
                mode: node.kind === "file" ? node.metadata.mode & ~SET_ID_BITS : node.metadata.mode,
                ctimeNs: (yield* timestamp(op))
              }
              advanceRevision(node)
              publishNode(node)
            })
          )
        }),
        utimesReference: Effect.fn("Caller.utimesReference")(function*(objectReference, times) {
          const op = OpContext.make("utimesReference")

          const decoded = yield* decodeTimes(times).pipe(
            Effect.mapError((cause) => op.fail("InvalidArgument", { cause }))
          )

          const access = { ...decoded.access }
          const modification = { ...decoded.modification }

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, op)

              if (access.kind === "omit" && modification.kind === "omit") return

              if (!identity.privileged && identity.uid !== node.metadata.uid) {
                if (access.kind !== "now" || modification.kind !== "now") {
                  return yield* op.fail("AccessDenied")
                }

                yield* authorize(node, identity, WRITE, op)
              }

              const now = yield* timestamp(op)
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
          const op = OpContext.make("truncateReference")

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const node = yield* referencedNode(objectReference, op)

              if (node.kind !== "file") {
                return yield* op.fail("IsDirectory")
              }

              yield* authorize(node, identity, WRITE, op)
              yield* resize(node, length, op)
            })
          )
        }),
        openReference: Effect.fn("Caller.openReference")(function*(objectReference, raw = { access: "read" }) {
          const op = OpContext.make("openReference")

          const decoded = yield* decodeOpenReferenceSettings(raw).pipe(
            Effect.mapError((cause) => op.fail("InvalidArgument", { cause }))
          )

          const chosen = { ...decoded }

          if (chosen.access === "read" && (chosen.append || chosen.truncate)) {
            return yield* op.fail("InvalidArgument")
          }

          const acquired = makeFileReference(chosen.access, chosen.append ?? false)

          yield* Effect.addFinalizer(() => finalizeFile(acquired))

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              if (acquired.closed) return yield* Effect.interrupt
              const node = yield* referencedNode(objectReference, op)

              if (node.kind !== "file") return yield* op.fail("IsDirectory")

              if (node.metadata.nlink === 0) {
                return yield* op.fail("StaleReference")
              }

              yield* authorize(
                node,
                identity,
                chosen.access === "read" ? READ : chosen.access === "write" ? WRITE : READ | WRITE,
                op
              )

              if (chosen.truncate) yield* resize(node, 0n, op)
              node.openCount += 1
              acquired.file = node

              return fileHandle(acquired)
            })
          )
        }),
        openChildReference: Effect.fn("Caller.openChildReference")(
          function*(directoryReference, input, raw, expected) {
            const op = OpContext.make("openChildReference")
            const name = yield* referencedName(input, op)

            const decoded = yield* decodeOpenChildReferenceSettings(raw).pipe(
              Effect.mapError((cause) => op.fail("InvalidArgument", { cause }))
            )

            const chosen = { ...decoded }

            if (chosen.access === "read" && (chosen.append || chosen.truncate)) {
              return yield* op.fail("InvalidArgument")
            }

            if (
              (chosen.mode !== undefined || chosen.times !== undefined || chosen.initialSize !== undefined ||
                chosen.exactMode !== undefined || chosen.owner !== undefined) &&
              (chosen.create === undefined || chosen.create === "never")
            ) {
              return yield* op.fail("InvalidArgument")
            }

            if (chosen.exactMode && chosen.mode === undefined) {
              return yield* op.fail("InvalidArgument")
            }

            const relativePath = preparePath(ownedPath(nameBytes(name)), op.operation, undefined)

            const acquired = makeFileReference(chosen.access, chosen.append ?? false)

            yield* Effect.addFinalizer(() => finalizeFile(acquired))

            return yield* coordinated(
              op,
              Effect.gen(function*() {
                if (acquired.closed) return yield* Effect.interrupt
                const parent = yield* referencedDirectory(directoryReference, op)
                yield* authorize(parent, identity, EXECUTE, op)
                const direct = parent.entries.get(name)

                if (expected !== undefined) {
                  let expectedNode: Node | undefined

                  if (expected !== null) {
                    const observed = yield* Effect.result(referencedNode(expected, op))

                    if (Result.isFailure(observed)) {
                      return yield* op.fail("VolumeBusy", { cause: observed.failure })
                    }

                    expectedNode = observed.success
                  }

                  if (direct !== expectedNode) {
                    return yield* op.fail("VolumeBusy")
                  }
                }

                if (chosen.expectedChild === null) {
                  if (direct !== undefined) {
                    return yield* op.fail("StaleReference")
                  }
                } else if (chosen.expectedChild !== undefined) {
                  const expected = chosen.expectedChild
                  const observed = yield* referencedNode(expected.reference, op)

                  if (
                    direct !== observed || observed.revision !== expected.revision ||
                    observed.metadata.atimeNs !== expected.atimeNs || observed.metadata.mtimeNs !== expected.mtimeNs
                  ) {
                    return yield* op.fail("StaleReference")
                  }
                }

                if (direct !== undefined && chosen.create === "exclusive") {
                  return yield* op.fail("AlreadyExists")
                }

                let file: Node | undefined = direct
                let mutationParent = parent
                let mutationName = name

                if (file?.kind === "symlink" && chosen.followFinalSymlink !== false) {
                  const resolved = yield* lookup(
                    yield* Effect.fromResult(relativePath),
                    undefined,
                    op,
                    {
                      followFinalSymlink: true,
                      allowMissing: chosen.create === "ifMissing" || chosen.create === "exclusive"
                    },
                    parent
                  )

                  file = resolved.node

                  if (file === undefined) {
                    if (resolved.parent === undefined || resolved.name === undefined) {
                      return yield* op.fail("IsDirectory")
                    }

                    mutationParent = resolved.parent
                    mutationName = resolved.name
                  }
                }

                const before = mutationParent.revision
                let created = false

                if (file === undefined) {
                  if (chosen.create === undefined || chosen.create === "never") {
                    return yield* op.fail("NotFound")
                  }

                  yield* authorize(mutationParent, identity, WRITE | EXECUTE, op)

                  if (atEntryLimit()) {
                    return yield* op.fail("NoSpace")
                  }

                  const size = chosen.initialSize ?? 0n

                  if (size < 0n) {
                    return yield* op.fail("InvalidArgument")
                  }

                  if (size > BigInt(maxFileBytes)) {
                    return yield* op.fail("FileTooLarge")
                  }

                  if (
                    settings.maxBytes !== undefined && size > ByteSize.toBigInt(settings.maxBytes) - state.usedBytes
                  ) {
                    return yield* op.fail("NoSpace")
                  }

                  if (
                    !identity.privileged &&
                    ((chosen.owner?.uid !== undefined && chosen.owner.uid !== identity.uid) ||
                      (chosen.owner?.gid !== undefined && chosen.owner.gid !== identity.gid &&
                        !identity.groups.includes(chosen.owner.gid)))
                  ) {
                    return yield* op.fail("AccessDenied")
                  }

                  const now = yield* timestamp(op)
                  const initial = creationTimes(chosen.times, now)

                  const creationMode = chosen.exactMode
                    ? yield* permittedMode(
                      {
                        kind: "file",
                        uid: chosen.owner?.uid ?? identity.uid,
                        gid: chosen.owner?.gid ?? mutationParent.metadata.gid
                      },
                      chosen.mode!,
                      op
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
                    return yield* op.fail("SymlinkLoop")
                  }

                  if (file.kind !== "file") {
                    return yield* op.fail("IsDirectory")
                  }

                  yield* authorize(
                    file,
                    identity,
                    chosen.access === "read" ? READ : chosen.access === "write" ? WRITE : READ | WRITE,
                    op
                  )

                  if (chosen.truncate) yield* resize(file, 0n, op)
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
          const op = OpContext.make("readFile")
          const pathOp = op.at(input)
          const prepared = preparePath(input, op.operation, settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, op)

              if (node.kind !== "file") {
                return yield* pathOp.fail("IsDirectory")
              }

              yield* authorize(node, identity, READ, pathOp)
              const data = new Uint8Array(node.data.bytes)
              node.metadata = { ...node.metadata, atimeNs: (yield* timestamp(op)) }

              return data
            })
          )
        }),
        writeFile: Effect.fn("Caller.writeFile")(
          function*(input: PathInput, bytes: Uint8Array, options: WriteFileOptions) {
            const op = OpContext.make("writeFile")
            const pathOp = op.at(input)
            const prepared = preparePath(input, op.operation, settings.maxPathBytes)

            if (!isAttachedBytes(bytes)) {
              return yield* pathOp.fail("InvalidArgument")
            }

            const captured = new Uint8Array(bytes)
            const { relativeTo: base, ...raw } = options

            const chosen = yield* decodeWriteFileSettings(raw).pipe(
              Effect.mapError((cause) => pathOp.fail("InvalidArgument", { cause }))
            )

            return yield* coordinated(
              op,
              Effect.gen(function*() {
                const path = yield* Effect.fromResult(prepared)

                if (chosen.create === "exclusive") {
                  const exists = yield* Effect.result(lookup(path, base, op, { followFinalSymlink: false }))

                  if (Result.isSuccess(exists)) {
                    return yield* pathOp.fail("AlreadyExists")
                  }

                  if (exists.failure.code !== "NotFound") return yield* exists.failure
                }

                const resolved = yield* lookup(
                  path,
                  base,
                  op,
                  {
                    followFinalSymlink: chosen.replaceFinalSymlink !== true && chosen.followFinalSymlink !== false,
                    allowMissing: chosen.create === "ifMissing" || chosen.create === "exclusive"
                  }
                )

                const { name, parent } = resolved

                if (parent === undefined || name === undefined || resolved.node?.kind === "directory") {
                  return yield* pathOp.fail("IsDirectory")
                }

                const replaced = resolved.node?.kind === "symlink" ? resolved.node : undefined

                if (replaced !== undefined && !chosen.replaceFinalSymlink) {
                  return yield* pathOp.fail("SymlinkLoop")
                }

                if (chosen.access === "read") {
                  return yield* pathOp.fail("InvalidHandle")
                }

                const file = resolved.node?.kind === "file" ? resolved.node : undefined

                if (file === undefined) {
                  yield* authorize(parent, identity, WRITE | EXECUTE, pathOp)

                  if (replaced !== undefined) yield* authorizeRemoval(parent, replaced, pathOp)

                  if (replaced === undefined && atEntryLimit()) {
                    return yield* pathOp.fail("NoSpace")
                  }
                } else {
                  yield* authorize(
                    file,
                    identity,
                    chosen.access === "readWrite" ? READ | WRITE : WRITE,
                    pathOp
                  )
                }

                const finalMode = chosen.finalMode === undefined ? undefined : yield* permittedMode(
                  file?.metadata ?? { kind: "file", uid: identity.uid, gid: parent.metadata.gid },
                  chosen.finalMode,
                  pathOp
                )

                const previous = file?.data.bytes.length ?? 0
                const initial = chosen.truncate ? 0 : previous
                const position = chosen.append ? initial : 0
                const size = Math.max(initial, position + captured.length)

                if (size > maxFileBytes) {
                  return yield* pathOp.fail("FileTooLarge")
                }

                const reclaimed = replaced !== undefined && replaced.metadata.nlink === 1 ? replaced.target.length : 0

                if (
                  settings.maxBytes !== undefined &&
                  BigInt(size - previous) > ByteSize.toBigInt(settings.maxBytes) - state.usedBytes + BigInt(reclaimed)
                ) {
                  return yield* pathOp.fail("NoSpace")
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

                const now = yield* timestamp(op)

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
          const op = OpContext.make("access")
          const pathOp = op.at(input)
          const prepared = preparePath(input, op.operation, settings.maxPathBytes)
          const base = options?.relativeTo

          if (!Number.isInteger(bits) || bits < 0 || bits > (READ | WRITE | EXECUTE)) {
            return yield* pathOp.fail("InvalidArgument")
          }

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, op)

              if (node.kind === "file" && (bits & EXECUTE) !== 0 && (node.metadata.mode & ANY_EXECUTE) === 0) {
                return yield* pathOp.fail("AccessDenied")
              }

              yield* authorize(node, identity, bits, pathOp)
            })
          )
        }),
        truncate: Effect.fn("Caller.truncate")(function*(input: PathInput, length: bigint, options?: RelativeOptions) {
          const op = OpContext.make("truncate")
          const pathOp = op.at(input)
          const prepared = preparePath(input, op.operation, settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, op)

              if (node.kind !== "file") {
                return yield* pathOp.fail("IsDirectory")
              }

              yield* authorize(node, identity, WRITE, pathOp)
              yield* resize(node, length, op)
            })
          )
        }),
        lstat: Effect.fn("Caller.lstat")(function*(input: PathInput, options?: RelativeOptions) {
          const op = OpContext.make("lstat")
          const prepared = preparePath(input, op.operation, settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const node = yield* resolveNode(yield* Effect.fromResult(prepared), base, op, {
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
            const op = OpContext.make("link")
            const sourceOp = op.at(source)
            const a = preparePath(source, op.operation, settings.maxPathBytes)
            const b = preparePath(destination, op.operation, settings.maxPathBytes)
            const sourceBase = options?.sourceRelativeTo
            const destinationBase = options?.destinationRelativeTo
            const follow = options?.followSourceSymlink ?? false

            return yield* coordinated(
              op,
              Effect.gen(function*() {
                const node = yield* resolveNode(yield* Effect.fromResult(a), sourceBase, op, {
                  followFinalSymlink: follow
                })

                if (node.kind === "directory") {
                  return yield* sourceOp.fail("IsDirectory")
                }

                const entry = yield* ResolvedEntry.fromPath(yield* Effect.fromResult(b), destinationBase, op)
                yield* linkNode(node, entry, op)
              })
            )
          }
        ),
        symlink: Effect.fn("Caller.symlink")(function*(target: PathInput, input: PathInput, options?: RelativeOptions) {
          const op = OpContext.make("symlink")
          const targetOp = op.at(target)
          const prepared = preparePath(input, op.operation, settings.maxPathBytes)

          const rawTarget = inputBytes(target)

          if (Result.isFailure(rawTarget)) {
            return yield* targetOp.fail(rawTarget.failure)
          }

          if (rawTarget.success.includes(0)) {
            return yield* targetOp.fail("InvalidArgument")
          }

          const targetBytes = new Uint8Array(rawTarget.success)
          const base = options?.relativeTo

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const entry = yield* ResolvedEntry.fromPath(yield* Effect.fromResult(prepared), base, op)
              yield* makeSymlink(entry, targetBytes, undefined, op)
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
          const op = OpContext.make("open")
          const pathOp = op.at(input)
          const prepared = preparePath(input, op.operation, settings.maxPathBytes)
          const { relativeTo: base, ...raw } = options

          const decoded = yield* decodeOpenSettings(raw).pipe(
            Effect.mapError((cause) => pathOp.fail("InvalidArgument", { cause }))
          )

          const chosen = { ...decoded }

          if (chosen.access === "read" && (chosen.append || chosen.truncate)) {
            return yield* pathOp.fail("InvalidArgument")
          }

          if (chosen.mode !== undefined && (chosen.create === undefined || chosen.create === "never")) {
            return yield* pathOp.fail("InvalidArgument")
          }

          const acquired = makeFileReference(chosen.access, chosen.append ?? false)

          yield* Effect.addFinalizer(() => finalizeFile(acquired))

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              if (acquired.closed) return yield* Effect.interrupt
              const path = yield* Effect.fromResult(prepared)

              if (chosen.create === "exclusive") {
                const existing = yield* Effect.result(lookup(path, base, op, { followFinalSymlink: false }))

                if (Result.isSuccess(existing)) {
                  return yield* pathOp.fail("AlreadyExists")
                }

                if (existing.failure.code !== "NotFound") return yield* existing.failure
              }

              const resolved = yield* lookup(
                path,
                base,
                op,
                {
                  followFinalSymlink: chosen.followFinalSymlink !== false,
                  allowMissing: chosen.create === "ifMissing" || chosen.create === "exclusive"
                }
              )

              const parent = resolved.parent

              if (parent === undefined) {
                return yield* pathOp.fail("IsDirectory")
              }

              const name = resolved.name

              if (isDotComponent(name)) {
                return yield* pathOp.fail("IsDirectory")
              }

              yield* authorize(parent, identity, EXECUTE, pathOp)
              let file = resolved.node

              if (file !== undefined && chosen.create === "exclusive") {
                return yield* pathOp.fail("AlreadyExists")
              }

              if (file === undefined) {
                if (chosen.create === undefined || chosen.create === "never" || path.trailingSlash) {
                  return yield* pathOp.fail("NotFound")
                }

                yield* authorize(parent, identity, WRITE | EXECUTE, pathOp)

                if (atEntryLimit()) {
                  return yield* pathOp.fail("NoSpace")
                }

                const now = yield* timestamp(op)
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
                  return yield* pathOp.fail("SymlinkLoop")
                }

                if (file.kind !== "file") {
                  return yield* pathOp.fail("IsDirectory")
                }

                if (path.trailingSlash) {
                  return yield* pathOp.fail("NotDirectory")
                }

                yield* authorize(
                  file,
                  identity,
                  chosen.access === "read" ? READ : chosen.access === "write" ? WRITE : READ | WRITE,
                  pathOp
                )

                if (chosen.truncate) yield* resize(file, 0n, op)
              }

              file.openCount += 1
              acquired.file = file

              return fileHandle(acquired)
            })
          )
        }),
        unlink: Effect.fn("Caller.unlink")(function*(input: PathInput, options?: RelativeOptions) {
          const op = OpContext.make("unlink")
          const prepared = preparePath(input, op.operation, settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const entry = yield* ResolvedEntry.fromPath(yield* Effect.fromResult(prepared), base, op)
              yield* unlinkEntry(entry, op)
            })
          )
        }),
        rename: Effect.fn("Caller.rename")(function*(
          source: PathInput,
          destination: PathInput,
          options?: { readonly sourceRelativeTo?: DirectoryHandle; readonly destinationRelativeTo?: DirectoryHandle }
        ) {
          const op = OpContext.make("rename")
          const sourcePrepared = preparePath(source, op.operation, settings.maxPathBytes)
          const destinationPrepared = preparePath(destination, op.operation, settings.maxPathBytes)

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const sourcePath = yield* Effect.fromResult(sourcePrepared)
              const destinationPath = yield* Effect.fromResult(destinationPrepared)
              const sourceEntry = yield* ResolvedEntry.fromPath(sourcePath, options?.sourceRelativeTo, op)

              const destinationEntry = yield* ResolvedEntry.fromPath(
                destinationPath,
                options?.destinationRelativeTo,
                op
              )

              yield* renameEntry(sourceEntry, destinationEntry, op)
            })
          )
        }),
        rmdir: Effect.fn("Caller.rmdir")(function*(input: PathInput, options?: RelativeOptions) {
          const op = OpContext.make("rmdir")
          const prepared = preparePath(input, op.operation, settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const entry = yield* ResolvedEntry.fromPath(yield* Effect.fromResult(prepared), base, op)
              yield* rmdirEntry(entry, op)
            })
          )
        }),
        stat: Effect.fn("Caller.stat")(function*(input: PathInput, options?: RelativeOptions) {
          const op = OpContext.make("stat")
          const prepared = preparePath(input, op.operation, settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const path = yield* Effect.fromResult(prepared)
              const directory = yield* resolveNode(path, base, op)

              return { ...directory.metadata }
            })
          )
        }),
        mkdir: Effect.fn("Caller.mkdir")(
          function*(input: PathInput, options?: RelativeOptions & { readonly mode?: number }) {
            const op = OpContext.make("mkdir")
            const pathOp = op.at(input)
            const prepared = preparePath(input, op.operation, settings.maxPathBytes)
            const base = options?.relativeTo
            const mode = options?.mode === undefined ? 0o777 : options.mode

            if (!isMode(mode)) return yield* pathOp.fail("InvalidArgument")

            return yield* coordinated(
              op,
              Effect.gen(function*() {
                const entry = yield* ResolvedEntry.fromPath(yield* Effect.fromResult(prepared), base, op)
                yield* makeDirectory(entry, { mode }, op)
              })
            )
          }
        ),
        withDirectory: Effect.fn("Caller.withDirectory")(function*(input: PathInput, options?: RelativeOptions) {
          const acquired = yield* acquireDirectory(input, options, OpContext.make("withDirectory"))

          return createCaller(acquired, identity, umask)
        }),
        openDirectory: Effect.fn("Caller.openDirectory")(function*(input: PathInput, options?: RelativeOptions) {
          const acquired = yield* acquireDirectory(input, options, OpContext.make("openDirectory"))

          const statOp = OpContext.make("stat")

          const handle: DirectoryHandle = Object.freeze({
            [DirectoryHandleId]: true as const,
            stat: coordinatedRead(
              statOp,
              Effect.suspend(() =>
                acquired.directory === undefined
                  ? Effect.fail(statOp.fail("InvalidHandle"))
                  : Effect.succeed({ ...acquired.directory.metadata })
              )
            ).pipe(Effect.withSpan("DirectoryHandle.stat")),
            close: coordinatedCleanup(Effect.suspend(() => {
              if (acquired.directory === undefined) {
                return Effect.fail(OpContext.make("close").fail("InvalidHandle"))
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
      return Effect.fromResult(decodeConfiguration(OverlayChangesOptions, options === undefined ? {} : options))
    }

    // An overlay is a spread copy of `volume`, so the object the caller holds is not always the one
    // built here. `watch` runs lazily, so it reads whichever surface was actually handed out.
    let surface: Volume

    const volume: Volume = Object.freeze({
      [VolumeId]: true as const,
      durability,
      identity,
      incarnation,
      limits,
      usage: coordinatedRead(
        OpContext.make("usage"),
        Effect.sync((): VolumeUsage => ({ usedBytes: state.usedBytes, entries: state.entries }))
      )
        .pipe(
          Effect.withSpan("Volume.usage")
        ),
      watch: Effect.gen(function*() {
        const hook = TestHooks.getRegistrationHook(surface)

        return yield* admit(OpContext.make("watch"), watchHub.subscribe(hook?.afterSubscribe))
      }).pipe(Effect.withSpan("Volume.watch")),
      snapshot: coordinatedRead(OpContext.make("snapshot"), captureSnapshot()).pipe(Effect.withSpan("Volume.snapshot")),

      caller: Effect.fn("Volume.caller")(function*(options?: RootCallerOptions) {
        const decoded = yield* Effect.fromResult(
          decodeConfiguration(RootCallerOptions, options === undefined ? {} : options)
        )

        const chosen = decoded.identity ?? { uid: 0, gid: 0, groups: [], privileged: true }
        const identity = Object.freeze({ ...chosen, groups: Object.freeze([...chosen.groups]) })

        return yield* coordinatedRead(
          OpContext.make("caller"),
          Effect.sync(() =>
            createCaller(
              makeDirectoryReference(state.root),
              identity,
              decoded.umask ?? 0o022
            )
          )
        )
      })
    })

    surface = volume

    if (!Predicate.isTagged("Overlay")(source) || baseObservation === undefined) {
      // SAFETY: Overlay sources return below, so S is non-Overlay here and VolumeFor<S> is Volume.
      return Object.freeze({ volume: volume as VolumeFor<S>, shutdown: staged?.shutdown, initialImage })
    }

    const hook = TestHooks.getObservationHook(source.base)

    const overlay: OverlayVolume = Object.freeze({
      ...volume,
      changes: Effect.fn("OverlayVolume.changes")(function*(options?: OverlayChangesOptions) {
        const selected = yield* changeOptions(options)
        const current = yield* coordinatedRead(OpContext.make("changes"), observeChanges())

        return publicChanges(compareOverlay(baseObservation, current, selected.includeTimestamps ?? false))
      }),
      capture: Effect.fn("OverlayVolume.capture")(function*(options?: OverlayChangesOptions) {
        const selected = yield* changeOptions(options)
        const current = yield* coordinatedRead(OpContext.make("capture"), captureState(hook))

        return Object.freeze({
          snapshot: current.snapshot,
          changes: publicChanges(
            compareOverlay(baseObservation, current.observation, selected.includeTimestamps ?? false)
          )
        })
      })
    })

    surface = overlay

    return Object.freeze({ volume: overlay, shutdown: staged?.shutdown, initialImage })
  }
)

/** @internal */
export const make = Effect.fn("VirtualFileSystem.make")(function*(options?: VolumeOptions) {
  return (yield* makeVolume(VolumeSource.Empty(), options).pipe(Effect.catchTag("ImageError", Effect.die))).volume
})

/** @internal */
export const prepareEmptyLiveImage = Effect.fnUntraced(function*(options?: VolumeOptions) {
  const { initialImage } = yield* makeVolume(VolumeSource.Empty(), options, undefined, captureLiveImage)

  if (initialImage === undefined) return yield* new ImageError({ code: "InvalidStructure", field: "liveImage" })

  return initialImage
})

/** @internal */
export const openImageVolume = Effect.fnUntraced(function*(
  image: Uint8Array,
  maxImageBytes: ByteSize.ByteSize,
  commit: (image: Uint8Array) => Effect.Effect<"committed" | "rejected" | "unknown">,
  durability: VolumeDurability = "memory-only"
) {
  const document = yield* LiveImage.decode(image, maxImageBytes)
  const prepared = new WeakMap<EngineState, Uint8Array>()
  const identity = VolumeIdentity.make(document.identity)
  const commitOp = OpContext.make("commit")

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

  const { volume, shutdown } = yield* makeVolume(
    VolumeSource.Live({ document }),
    undefined,
    {
      prepare: (candidate) =>
        captureLiveImage(candidate, identity, limits).pipe(
          Effect.mapError((cause) => commitOp.fail("StorageRejected", { cause })),
          Effect.flatMap((bytes) =>
            ByteSize.isGreaterThan(ByteSize.bytes(bytes.length), maxImageBytes)
              ? commitOp.fail("StorageRejected")
              : Effect.sync(() => {
                prepared.set(candidate, bytes)
              })
          )
        ),
      commit: (candidate) =>
        Effect.suspend(() => {
          const bytes = prepared.get(candidate)

          if (bytes === undefined) return Effect.succeed("unknown" as const)
          prepared.delete(candidate)

          return commit(bytes)
        })
    },
    undefined,
    durability
  )

  if (shutdown === undefined) return yield* new ImageError({ code: "InvalidStructure", field: "liveImage" })

  return Object.freeze({ volume, shutdown })
})

/** @internal */
export const fromSnapshot = Effect.fn("VirtualFileSystem.fromSnapshot")(
  function*(snapshot: Snapshot, options?: VolumeOptions) {
    const image = yield* Image.inspect(snapshot)

    return (yield* makeVolume(VolumeSource.Snapshot({ image }), options)).volume
  }
)

/** @internal */
export const makeOverlay = Effect.fn("VirtualFileSystem.makeOverlay")(
  function*(base: Snapshot, options?: VolumeOptions) {
    const image = yield* Image.inspect(base)

    return (yield* makeVolume(VolumeSource.Overlay({ base, image }), options)).volume
  }
)
