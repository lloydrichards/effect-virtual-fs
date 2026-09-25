// Runtime definitions and cohesive live virtual filesystem engine.
import * as Brand from "effect/Brand"
import * as ByteSize from "effect/ByteSize"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { BytePath } from "../BytePath.js"
import {
  CallerId,
  type Identity,
  MkdirReferenceSettings,
  ObjectReferenceId,
  OpenChildReferenceSettings,
  OpenReferenceSettings,
  OpenSettings,
  RootCallerOptions,
  SymlinkReferenceSettings,
  WriteFileSettings
} from "../Caller.js"
import { DirectoryHandleId, FileHandleId, SeekMode } from "../FileHandle.js"
import { type Metadata, Mode, OwnerUpdate, Times } from "../Metadata.js"
import type { Snapshot } from "../Snapshot.js"
import type { FsFailure, ImageFailure } from "../VfsError.js"
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
import {
  OverlayChange,
  OverlayChangesOptions,
  type VolumeDurability,
  VolumeId,
  VolumeIdentity,
  VolumeIncarnation,
  VolumeOptions
} from "../Volume.js"
import { CanonicalBase64 } from "./canonicalBase64.js"
import {
  argumentFailure,
  decodeConfiguration,
  fsFailure,
  imageFailure,
  OpContext,
  retargetFailure,
  VfsError
} from "./errors.js"
import * as Image from "./image.js"
import * as InodeTable from "./inodeTable.js"
import { MAX_FILE_BYTES } from "./limits.js"
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
import { type CommitProvider, offerCommit } from "./stagedState.js"
import { VolumeTestSeams } from "./testSeams.js"
import { makeTurnstile } from "./turnstile.js"
import * as WatchHub from "./watchHub.js"

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

const isMode = Schema.is(Mode)

const isNatural = Schema.is(Schema.Natural)

// Whether an identity belongs to a group, by its primary group or a supplementary one.
const inGroup = (identity: Identity, gid: number) => identity.gid === gid || identity.groups.includes(gid)

const isTimestamp = Schema.is(MetadataDomain.Timestamp)

const isSeekMode = Schema.is(SeekMode)

/** @internal */
export type OpenOptions = OpenSettings & RelativeOptions

/** @internal */
export type WriteFileOptions = WriteFileSettings & RelativeOptions

const decodeOwnerUpdate = Schema.decodeEffect(OwnerUpdate, { onExcessProperty: "error" })

const decodeTimes = Schema.decodeEffect(Times, { onExcessProperty: "error" })

const decodeWriteFileSettings = Schema.decodeEffect(WriteFileSettings, { onExcessProperty: "error" })

const decodeOpenSettings = Schema.decodeEffect(OpenSettings, { onExcessProperty: "error" })

const decodeMkdirReferenceSettings = Schema.decodeEffect(MkdirReferenceSettings, { onExcessProperty: "error" })

const decodeSymlinkReferenceSettings = Schema.decodeEffect(SymlinkReferenceSettings, { onExcessProperty: "error" })

const decodeOpenReferenceSettings = Schema.decodeEffect(OpenReferenceSettings, { onExcessProperty: "error" })

const decodeOpenChildReferenceSettings = Schema.decodeEffect(OpenChildReferenceSettings, { onExcessProperty: "error" })

// What opening or creating a resolved entry needs; a path open supplies only the OpenSettings fields.
type OpenRequest = Omit<OpenChildReferenceSettings, "append" | "followFinalSymlink" | "expectedChild">

// An inode number: monotonic within a volume, never reused, and persisted by the live image. A number keys the
// inode table more cheaply than a bigint; the public metadata still reports it as one.
type Ino = number & Brand.Brand<"@effect-vfs/core/Ino">

const Ino = Brand.nominal<Ino>()

const ROOT_INO = Ino(1)

// One name that reaches an inode: the directory holding it and the hex-encoded name bytes.
interface Link {
  readonly parent: Ino
  readonly name: string
}

// Inodes are immutable values: every change replaces the value in the state's inode table.
interface Directory {
  readonly kind: "directory"
  readonly ino: Ino
  readonly lineage: string | undefined
  // Directories have one name; a detached directory keeps its last one and reads as unnamed through nlink 0.
  readonly parent: Ino
  readonly name: string
  readonly entries: ReadonlyMap<string, Ino>
  readonly metadata: Metadata
  readonly revision: bigint
}

interface RegularFile {
  readonly kind: "file"
  readonly ino: Ino
  readonly lineage: string | undefined
  readonly data: Content.Content
  readonly links: ReadonlyArray<Link>
  readonly metadata: Metadata
  readonly revision: bigint
}

interface SymbolicLink {
  readonly kind: "symlink"
  readonly ino: Ino
  readonly lineage: string | undefined
  readonly target: Uint8Array
  readonly links: ReadonlyArray<Link>
  readonly metadata: Metadata
  readonly revision: bigint
}

type Node = Directory | RegularFile | SymbolicLink

// The whole volume as one value. A transition builds the next value; nothing is published until it is installed.
interface VolumeState {
  readonly inodes: InodeTable.InodeTable<Node>
  // Handles holding a file open; an unlinked file stays in the table, and in the live image, while any does.
  readonly open: ReadonlyMap<Ino, number>
  readonly nextInode: Ino
  readonly revision: bigint
  readonly entries: number
  readonly usedBytes: bigint
}

/** @internal */
export type EngineState = VolumeState

const getNode = (state: VolumeState, ino: Ino): Node | undefined => InodeTable.get(state.inodes, ino)

// The namespace entry a path or a directory reference plus name resolves to, so each verb has one body. A
// path's final component can be absent or a dot and can carry a trailing slash; a reference name never does,
// so a body's checks for those cases never fire on references.
interface ResolvedEntry {
  readonly parent: Ino
  readonly name: string | undefined
  readonly trailingSlash: boolean
  // Names the path on path-addressed entries; the method's own context on reference-addressed ones.
  readonly op: OpContext
}

// The node a path, handle, or object reference resolves to, so each node-addressed verb has one body.
interface ResolvedNode {
  readonly ino: Ino
  // Names the path on path-addressed nodes; the method's own context on handles and references.
  readonly op: OpContext
}

// Copies options before coordination, so a caller changing them while the operation waits has no effect. The
// node-addressed bodies take a resolver rather than a resolve effect so that this copy, like each verb's own
// argument checks, still runs only after validation.
const ownedOptions = <A extends object>(options: A | undefined): A | undefined =>
  options === undefined ? undefined : { ...options }

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

const byIno = (a: Node, b: Node) => a.ino - b.ino

// Open files that no name reaches any more; the live image keeps them until their final close.
/** @internal */
export const retainedFiles = (state: VolumeState): Array<RegularFile> => {
  const retained: Array<RegularFile> = []

  for (const ino of state.open.keys()) {
    const node = getNode(state, ino)

    if (node?.kind === "file" && node.links.length === 0) retained.push(node)
  }

  return retained.sort(byIno)
}

/** @internal */
export const captureLiveImage = Effect.fnUntraced(function*(
  state: VolumeState,
  identity: VolumeIdentity,
  limits: VolumeLimits
) {
  const records: Array<LiveImage.Record> = []
  const visited = new Set<Ino>()
  const retained = retainedFiles(state)
  const pending: Array<Ino> = [ROOT_INO, ...retained.map((file) => file.ino)]

  for (let index = 0; index < pending.length; index++) {
    if (index % WALK_YIELD_INTERVAL === 0) yield* Effect.yieldNow
    const ino = pending[index]

    if (ino === undefined || visited.has(ino)) continue
    visited.add(ino)
    const node = getNode(state, ino)

    if (node === undefined) return yield* imageFailure("snapshot", "InvalidStructure")

    const common: LiveImageCommon = {
      ino: BigInt(node.ino),
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
        entries.push({ name: CanonicalBase64.encode(nameBytes(name)), target: BigInt(child) })
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
    root: BigInt(ROOT_INO),
    nextInode: BigInt(state.nextInode),
    revisionCounter: state.revision,
    entries: state.entries,
    usedBytes: state.usedBytes,
    limits: storedLimits,
    retainedFiles: retained.map((file) => BigInt(file.ino)),
    records
  }

  return yield* LiveImage.encode(document)
})

// Builds the next volume value for one transition. Reads see pending writes; a discarded draft leaves the
// base untouched, so an interrupted or failed transition needs no rollback.
class Draft {
  // Pending writes, applied to the table in one batch under this owner when the draft finishes.
  private readonly owner: InodeTable.Owner = Symbol()
  private readonly pending = new Map<Ino, Node | undefined>()
  private opens: Map<Ino, number> | undefined
  private nextInode: Ino
  private changed = false
  private finished: VolumeState | undefined
  // The revision every inode this transition replaces is stamped with.
  readonly revision: bigint
  entries: number
  usedBytes: bigint
  // Watch events, computed against the installed value once a watcher takes them.
  readonly events: Array<(installed: VolumeState) => Iterable<Change>> = []
  // Handle record writes, applied once the value is installed.
  readonly after: Array<() => void> = []
  readonly removed: Array<Ino> = []

  constructor(readonly base: VolumeState) {
    this.nextInode = base.nextInode
    this.revision = base.revision + 1n
    this.entries = base.entries
    this.usedBytes = base.usedBytes
  }

  get(ino: Ino): Node | undefined {
    const pending = this.pending.get(ino)

    return pending !== undefined || this.pending.has(ino) ? pending : InodeTable.get(this.base.inodes, ino)
  }

  // Replaces an inode with a value built for this write, stamped with this transition's revision.
  put(node: Node): void {
    this.changed = true
    // SAFETY: callers construct the value they pass, so stamping it in place replaces a spread on every write.
    const stamped = node as { revision: bigint }
    stamped.revision = this.revision
    this.pending.set(node.ino, node)
  }

  // Replaces an inode without stamping it; access-time updates do not advance revisions.
  putQuiet(node: Node): void {
    this.pending.set(node.ino, node)
  }

  // Drops an inode nothing reaches. The link change that orphaned it was stamped; its removal advances nothing.
  remove(ino: Ino): void {
    this.removed.push(ino)
    this.pending.set(ino, undefined)
  }

  allocate(): Ino {
    const ino = this.nextInode
    this.nextInode = Ino(ino + 1)

    return ino
  }

  // Whether another inode can be allocated. The allocator itself must stay exactly representable, since a live
  // image refuses one past the largest safe integer, so the last inode it hands out is one below that.
  get canAllocate(): boolean {
    return this.nextInode < Number.MAX_SAFE_INTEGER
  }

  openCount(ino: Ino): number {
    return this.opens?.get(ino) ?? this.base.open.get(ino) ?? 0
  }

  retain(ino: Ino): void {
    this.opens = (this.opens ?? new Map()).set(ino, this.openCount(ino) + 1)
  }

  release(ino: Ino): number {
    const count = this.openCount(ino) - 1
    this.opens = (this.opens ?? new Map()).set(ino, count < 0 ? 0 : count)

    return count
  }

  // Builds the next value once; a staged commit offers the same object it later installs.
  finish(): VolumeState {
    if (this.finished !== undefined) return this.finished
    const base = this.base
    let inodes = base.inodes

    for (const [ino, node] of this.pending) inodes = InodeTable.set(inodes, ino, node, this.owner)
    let open = base.open

    if (this.opens !== undefined) {
      const next = new Map(base.open)

      for (const [ino, count] of this.opens) {
        if (count > 0) next.set(ino, count)
        else next.delete(ino)
      }

      open = next
    }

    this.finished = {
      inodes,
      open,
      nextInode: this.nextInode,
      revision: this.changed ? this.revision : base.revision,
      entries: this.entries,
      usedBytes: this.usedBytes
    }

    return this.finished
  }
}

// The object reference token stays opaque; this pairs it with the volume that issued it and the inode it names.
interface ObjectReferenceState {
  readonly volume: symbol
  readonly ino: Ino
}

const objectReferences = new WeakMap<ObjectReference, ObjectReferenceState>()

const isFileHandle = (value: PathInput | FileHandle | DirectoryHandle): value is FileHandle =>
  Predicate.hasProperty(FileHandleId)(value)

const isDirectoryHandle = (value: PathInput | FileHandle | DirectoryHandle): value is DirectoryHandle =>
  Predicate.hasProperty(DirectoryHandleId)(value)

// The handle's own scope, forked from its acquiring scope; explicit close closes it too.
interface HandleScope {
  scope: Scope.Closeable | undefined
  closed: boolean
}

// Handle records are written only after the transition that changes them is installed.
interface FileReference extends HandleScope {
  readonly volume: symbol
  ino: Ino | undefined
  offset: bigint
  readonly access: "read" | "write" | "readWrite"
  readonly append: boolean
}

const files = new WeakMap<FileHandle, FileReference>()

interface DirectoryReference extends HandleScope {
  readonly volume: symbol
  ino: Ino | undefined
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

const withEntries = (directory: Directory, edit: (entries: Map<string, Ino>) => void): Directory => {
  const entries = new Map(directory.entries)
  edit(entries)

  return { ...directory, entries }
}

// Removes one link to a file or symbolic link.
const withoutLink = (links: ReadonlyArray<Link>, parent: Ino, name: string): ReadonlyArray<Link> => {
  const index = links.findIndex((link) => link.parent === parent && link.name === name)

  return index < 0 ? links : [...links.slice(0, index), ...links.slice(index + 1)]
}

type VolumeSource =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Live"; readonly document: LiveImage.Document }
  // A snapshot's image, and the value it restores to once the volume's limits have accepted the image.
  | {
    readonly _tag: "Restored"
    readonly image: Image.Document
    readonly restore: (initialTime: bigint) => Effect.Effect<VolumeState, ImageFailure>
  }

/** @internal */
export const VolumeSource = Data.taggedEnum<VolumeSource>()

const UpdateChange = Schema.TaggedStruct("Update", { path: BytePath })

const RescanChange = Schema.TaggedStruct("Rescan", { path: BytePath })

// A fresh directory root for a volume whose image names none; a restored image always carries its own.
const emptyRoot = (lineage: string | undefined, now: bigint): Directory => ({
  kind: "directory",
  ino: ROOT_INO,
  lineage,
  parent: ROOT_INO,
  name: "",
  entries: new Map(),
  metadata: directoryMetadata(BigInt(ROOT_INO), 0, 0, 0o755, now),
  revision: 1n
})

// Restores a snapshot image into a volume value. Inode numbers follow record order, so every volume restored
// from one image assigns the same numbers, and every restored inode carries the image record as its lineage.
const restoreImage = Effect.fnUntraced(function*(image: Image.Document, initialTime: bigint) {
  // Restored inodes are built mutably here and frozen into the table once every entry is wired.
  const incoming = new Map<string, { node: Node; entries: Map<string, Ino>; links: Array<Link> }>()
  let nextInode = Ino(2)

  for (const record of image.records) {
    const isRoot = record.id === image.root
    const ino = isRoot ? ROOT_INO : nextInode

    if (!isRoot) nextInode = Ino(nextInode + 1)

    const metadata: Metadata = {
      ...record.metadata,
      kind: record._tag,
      ino: BigInt(ino),
      nlink: Image.Record.guards.directory(record) ? 2 : 0,
      size: 0n,
      atimeNs: record.metadata.atimeNs,
      mtimeNs: record.metadata.mtimeNs,
      ctimeNs: record.metadata.ctimeNs,
      birthtimeNs: record.metadata.birthtimeNs
    }

    if (Image.Record.guards.directory(record)) {
      const entries = new Map<string, Ino>()
      incoming.set(record.id, {
        node: {
          kind: "directory",
          ino,
          lineage: record.id,
          parent: ROOT_INO,
          name: "",
          entries,
          metadata,
          revision: 1n
        },
        entries,
        links: []
      })
    } else if (Image.Record.guards.file(record)) {
      const data = Content.make(yield* CanonicalBase64.decode(record.data))
      const links: Array<Link> = []
      incoming.set(record.id, {
        node: {
          kind: "file",
          ino,
          lineage: record.id,
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
      incoming.set(record.id, {
        node: {
          kind: "symlink",
          ino,
          lineage: record.id,
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
    if (!Image.Record.guards.directory(record)) continue
    const parent = incoming.get(record.id)

    if (parent?.node.kind !== "directory") return yield* imageFailure("snapshot", "InvalidStructure")

    for (const entry of record.entries) {
      const child = incoming.get(entry.target)

      if (child === undefined) return yield* imageFailure("snapshot", "InvalidStructure")
      const name = Encoding.encodeHex(yield* CanonicalBase64.decode(entry.name))
      parent.entries.set(name, child.node.ino)

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

  if (InodeTable.get(inodes, ROOT_INO) === undefined) {
    inodes = InodeTable.set(inodes, ROOT_INO, emptyRoot(image.root, initialTime), owner)
  }

  return { inodes, nextInode }
})

// Volumes layered on one snapshot share its restored value, and so every unchanged inode and payload.
const baseStates = new WeakMap<Snapshot, VolumeState>()

/** @internal */
export const hasBaseState = (snapshot: Snapshot): boolean => baseStates.has(snapshot)

/** @internal */
export const baseStateFor = (snapshot: Snapshot, image: Image.Document, initialTime: bigint) =>
  Effect.suspend(() => {
    const cached = baseStates.get(snapshot)

    if (cached !== undefined) return Effect.succeed(cached)

    return Effect.map(restoreImage(image, initialTime), (restored) => {
      const value: VolumeState = { ...restored, open: new Map(), revision: 1n, entries: 0, usedBytes: 0n }
      baseStates.set(snapshot, value)

      return value
    })
  })

const captureSnapshot = Effect.fnUntraced(function*(captured: VolumeState) {
  const ids = new Map<Ino, string>([[ROOT_INO, "0"]])
  const pending: Array<Ino> = [ROOT_INO]
  const records: Array<Image.Record> = []

  for (let index = 0; index < pending.length; index++) {
    if (index % WALK_YIELD_INTERVAL === 0) yield* Effect.yieldNow
    const ino = pending[index]

    if (ino === undefined) continue
    const node = getNode(captured, ino)
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

      records.push(Image.Record.cases.directory.make({ id, metadata, entries: children }))
    } else if (node.kind === "file") {
      records.push(Image.Record.cases.file.make({ id, metadata, data: CanonicalBase64.encode(node.data.bytes) }))
    } else {records.push(
        Image.Record.cases.symlink.make({ id, metadata, target: CanonicalBase64.encode(node.target) })
      )}
  }

  return yield* Image.capture({ format: "effect-vfs", version: 1, root: "0", records }, undefined, true)
})

// Every object's path, lineage, kind, content and stored metadata: what an overlay compares against its base.
const observeChanges = Effect.fnUntraced(function*(captured: VolumeState) {
  const observation: Array<ObservationEntry> = []
  const paths: Array<readonly [Ino, Uint8Array]> = [[ROOT_INO, new Uint8Array([SLASH_BYTE])]]

  for (let index = 0; index < paths.length; index++) {
    if (index % WALK_YIELD_INTERVAL === 0) yield* Effect.yieldNow
    const entry = paths[index]

    if (entry === undefined) continue
    const [ino, path] = entry
    const node = getNode(captured, ino)

    if (node === undefined) continue
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

// Each execution constructs a fresh volume and captures its Clock.

/** @internal */
export const makeVolume = Effect.fnUntraced(
  function*(
    source: VolumeSource,
    options?: VolumeOptions,
    commitProvider?: CommitProvider<VolumeState>,
    captureInitial?: (
      state: VolumeState,
      identity: VolumeIdentity,
      limits: VolumeLimits
    ) => Effect.Effect<Uint8Array, ImageFailure>,
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
      decodeConfiguration(VolumeOptions, restoredOptions === undefined ? {} : restoredOptions, "make")
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
      return yield* argumentFailure("make", "clock.currentTimeNanos")
    }

    const timestamp = (op: OpContext) =>
      Effect.suspend(() => {
        const now = clock.currentTimeNanosUnsafe()

        return isTimestamp(now)
          ? Effect.succeed(now)
          : Effect.fail(op.fail("InvalidArgument"))
      })

    const volumeIdentity = Symbol()
    // One token per inode, so aliases and renames return the same reference; dropped when the inode leaves the table.
    const tokens = new Map<Ino, ObjectReference>()
    // Directory handles holding an inode. Not part of the value: opening a directory is an observation, and the
    // live image never keeps a detached directory. A held directory stays in the table until its last close.
    const directoryHolds = new Map<Ino, number>()

    const makeFileReference = (access: FileReference["access"], append: boolean): FileReference => ({
      volume: volumeIdentity,
      scope: undefined,
      closed: false,
      ino: undefined,
      offset: 0n,
      access,
      append
    })

    const makeDirectoryReference = (ino?: Ino): DirectoryReference => ({
      volume: volumeIdentity,
      scope: undefined,
      closed: false,
      ino
    })

    const maxPendingOperations = settings.maxPendingOperations ?? 64
    // Observations each take one permit and run beside each other; a change, a cleanup or a watch registration
    // takes them all, so it sees no reader and no reader sees it half done.
    const permits = maxPendingOperations + 1
    const gate = Semaphore.makeUnsafe(permits)
    // The gate hands permits to whichever waiter it can satisfy, so a change waiting for every permit would be
    // overtaken by each later observation. A change holds a turnstile while it gathers the permits, and an
    // observation passes the turnstile before it takes one, so observations that arrive after a change wait
    // behind it. The turnstile goes to its waiters in arrival order, even to one that arrives while a finished
    // change is still releasing. Both waits stay interruptible, and every permit is taken and released by
    // `withPermits`.
    const turnstile = makeTurnstile()

    const observing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.andThen(turnstile.withTurn(Effect.void), gate.withPermits(1)(effect))

    const changing = <A, E, R>(effect: Effect.Effect<A, E, R>) => turnstile.withTurn(gate.withPermits(permits)(effect))

    const admission = yield* Semaphore.make(permits)

    const admit = <A, E, R>(op: OpContext, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | FsFailure, R> =>
      admission.withPermitsIfAvailable(1)(effect).pipe(
        Effect.flatMap(Option.match({
          onNone: () => op.fail("VolumeBusy"),
          onSome: Effect.succeed
        }))
      )

    const root = emptyRoot(image?.root, initialTime)

    let state: VolumeState = {
      inodes: InodeTable.set(InodeTable.empty<Node>(), ROOT_INO, root),
      open: new Map(),
      nextInode: Ino(2),
      revision: 1n,
      entries: 0,
      usedBytes: 0n
    }

    // The schema caps this value at uint32, so this boundary conversion is exact.
    const maxFileBytes = Number(ByteSize.toBigInt(settings.maxFileBytes ?? ByteSize.bytes(MAX_FILE_BYTES)))

    const limits: VolumeLimits = Object.freeze({
      maxBytes: settings.maxBytes,
      maxFileBytes: ByteSize.bytes(maxFileBytes),
      maxEntries: settings.maxEntries,
      maxPathBytes: settings.maxPathBytes,
      maxPendingOperations: settings.maxPendingOperations ?? 64,
      maxWatchEvents: settings.maxWatchEvents ?? 256
    })

    if (Predicate.isTagged("Restored")(source)) {
      let content = 0n
      let count = 0

      for (const record of source.image.records) {
        if (Image.Record.guards.directory(record)) count += record.entries.length
        else {
          const length = CanonicalBase64.decodedLength(
            Image.Record.guards.file(record) ? record.data : record.target
          )

          if (Image.Record.guards.file(record) && length > maxFileBytes) {
            return yield* imageFailure("snapshot", "LimitExceeded", { field: "maxFileBytes" })
          }

          content += BigInt(length)
        }
      }

      if (
        (settings.maxEntries !== undefined && count > settings.maxEntries) ||
        (settings.maxBytes !== undefined && content > ByteSize.toBigInt(settings.maxBytes))
      ) {
        return yield* imageFailure("snapshot", "LimitExceeded", { field: "volume" })
      }

      state = { ...state, ...(yield* source.restore(initialTime)), entries: count, usedBytes: content }
    }

    if (live !== undefined) {
      const incoming = new Map<bigint, { node: Node; entries: Map<string, Ino>; links: Array<Link> }>()

      for (const record of live.records) {
        const ino = Ino(Number(record.ino))
        const metadata: Metadata = { ...record.metadata, kind: record._tag, ino: record.ino }

        if (LiveImage.Record.guards.directory(record)) {
          const entries = new Map<string, Ino>()
          incoming.set(record.ino, {
            node: {
              kind: "directory",
              ino,
              lineage: record.lineage,
              parent: ROOT_INO,
              name: "",
              entries,
              metadata,
              revision: record.revision
            },
            entries,
            links: []
          })
        } else if (LiveImage.Record.guards.file(record)) {
          const links: Array<Link> = []
          incoming.set(record.ino, {
            node: {
              kind: "file",
              ino,
              lineage: record.lineage,
              data: Content.make(yield* CanonicalBase64.decode(record.data)),
              links,
              metadata,
              revision: record.revision
            },
            entries: new Map(),
            links
          })
        } else {
          const links: Array<Link> = []
          incoming.set(record.ino, {
            node: {
              kind: "symlink",
              ino,
              lineage: record.lineage,
              target: yield* CanonicalBase64.decode(record.target),
              links,
              metadata,
              revision: record.revision
            },
            entries: new Map(),
            links
          })
        }
      }

      for (const record of live.records) {
        if (!LiveImage.Record.guards.directory(record)) continue
        const parent = incoming.get(record.ino)

        if (parent?.node.kind !== "directory") return yield* imageFailure("snapshot", "InvalidStructure")

        for (const entry of record.entries) {
          const child = incoming.get(entry.target)

          if (child === undefined) return yield* imageFailure("snapshot", "InvalidStructure")
          const name = Encoding.encodeHex(yield* CanonicalBase64.decode(entry.name))
          parent.entries.set(name, child.node.ino)

          if (child.node.kind === "directory") child.node = { ...child.node, parent: parent.node.ino, name }
          else child.links.push({ parent: parent.node.ino, name })
        }
      }

      const restoredRoot = incoming.get(live.root)

      if (restoredRoot?.node.kind !== "directory" || restoredRoot.node.ino !== ROOT_INO) {
        return yield* imageFailure("snapshot", "InvalidStructure")
      }

      let usedBytes = live.usedBytes

      // A previous process's handles no longer exist. Their zero-link files
      // remain in the stored image but are reclaimed from this runtime state.
      for (const ino of live.retainedFiles) {
        const orphan = incoming.get(ino)

        if (orphan?.node.kind !== "file") return yield* imageFailure("snapshot", "InvalidStructure")
        usedBytes -= BigInt(orphan.node.data.bytes.length)
        incoming.delete(ino)
      }

      const owner = Symbol()
      let inodes = InodeTable.empty<Node>()

      for (const { node } of incoming.values()) inodes = InodeTable.set(inodes, node.ino, node, owner)

      state = {
        inodes,
        open: new Map(),
        nextInode: Ino(Number(live.nextInode)),
        revision: live.revisionCounter,
        entries: live.entries,
        usedBytes
      }
    }

    const initialImage = captureInitial === undefined ? undefined : yield* captureInitial(state, identity, limits)

    // The running transition's draft; reads inside a transition see its pending writes.
    let draft: Draft | undefined

    const view = (ino: Ino): Node | undefined => draft === undefined ? getNode(state, ino) : draft.get(ino)

    // False once storage's answer about a candidate cannot be trusted; every later operation is refused.
    let available = true

    const checkAvailable = (operation: string) =>
      Effect.suspend(() => available ? Effect.void : Effect.fail(fsFailure("VolumeUnavailable", operation)))

    const watchCoordinate: WatchHub.Coordinator = (effect) => changing(effect)

    const watchHub = yield* WatchHub.make<Change, FsFailure>(
      watchCoordinate,
      settings.maxWatchEvents ?? 256,
      () => RescanChange.make({ path: ownedPath(new Uint8Array([47])) }),
      checkAvailable("watch")
    )

    // Installs a finished draft: the only place the volume's value changes, and where its events publish.
    const install = (finished: Draft) => {
      state = finished.finish()

      for (const ino of finished.removed) tokens.delete(ino)

      for (const apply of finished.after) apply()

      for (const events of finished.events) watchHub.publishManyUnsafe(() => events(state))
    }

    // Runs a change against a fresh draft and returns the finished draft with the change's value. A failure or
    // an interruption anywhere in the change discards the draft, so the volume's value is untouched.
    const transition = <A, E, R>(change: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const current = new Draft(state)
        draft = current

        return Effect.onExit(change, () =>
          Effect.sync(() => {
            draft = undefined
          })).pipe(Effect.map((value) => [value, current] as const))
      })

    // A change that runs outside admission and needs no provider: handle cleanup.
    const applyDirect = (change: (d: Draft) => void) => {
      const current = new Draft(state)
      draft = current

      try {
        change(current)
      } finally {
        draft = undefined
      }

      install(current)
    }

    // Offers the finished draft's value to the store before installing it. A rejected candidate is discarded and
    // the volume stays available; an uncertain answer stops the volume. A change that is a cleanup runs its
    // release even when the store refuses, since the handle must not stay open.
    const committed = Effect.fnUntraced(function*(
      op: OpContext,
      provider: CommitProvider<VolumeState>,
      finished: Draft,
      onStorageFailure: (() => void) | undefined
    ) {
      const next = finished.finish()

      if (provider.prepare !== undefined) yield* provider.prepare(next)
      const answer = yield* offerCommit(provider, op.operation, next, onStorageFailure !== undefined)

      if (!answer.available) available = false

      if (answer.failure !== undefined) {
        if (!answer.available) onStorageFailure?.()

        return yield* answer.failure
      }

      install(finished)
    })

    // Records what failed on the span the caller has open.
    const annotateFailure = (error: VfsError) =>
      Effect.annotateCurrentSpan({ operation: error.operation, code: error.code })

    // Permit waits stay interruptible. A change and its publication run under every permit; with a store, the
    // change itself stays interruptible and only the commit and installation are not.
    const coordinated = <A, E, R>(op: OpContext, effect: Effect.Effect<A, E, R>, onStorageFailure?: () => void) =>
      admit(
        op,
        changing(
          commitProvider === undefined
            ? Effect.uninterruptible(
              Effect.map(transition(Effect.andThen(checkAvailable(op.operation), effect)), ([value, finished]) => {
                install(finished)

                return value
              })
            )
            : Effect.uninterruptibleMask((restore) =>
              Effect.flatMap(
                restore(transition(Effect.andThen(checkAvailable(op.operation), effect))),
                ([value, finished]) => Effect.as(committed(op, commitProvider, finished, onStorageFailure), value)
              )
            )
        )
      ).pipe(Effect.tapError((error) => Schema.is(VfsError)(error) ? annotateFailure(error) : Effect.void))

    // Pure observations take one permit each, so they run beside each other and never beside a change.
    const coordinatedRead = <A, E, R>(op: OpContext, effect: Effect.Effect<A, E, R>) =>
      admit(op, observing(Effect.andThen(checkAvailable(op.operation), effect))).pipe(
        Effect.tapError((error) => Schema.is(VfsError)(error) ? annotateFailure(error) : Effect.void)
      )

    const coordinatedCleanup = <A, E, R>(effect: Effect.Effect<A, E, R>) => changing(Effect.uninterruptible(effect))

    // Stops the volume once its store is going away; a later operation fails as unavailable.
    const shutdown = commitProvider === undefined ? undefined : changing(Effect.sync(() => {
      available = false
    }))

    const current = (): Draft => {
      if (draft === undefined) throw new Error("Volume mutation outside a transition")

      return draft
    }

    // The path that reaches a directory, or nothing once it is detached or an ancestor is gone.
    const pathOf = (get: (ino: Ino) => Node | undefined, ino: Ino): string | undefined => {
      const names: Array<string> = []
      let node = get(ino)

      if (node?.kind !== "directory" || node.metadata.nlink === 0) return undefined

      while (node.ino !== ROOT_INO) {
        names.push(node.name)
        const parent = get(node.parent)

        if (parent?.kind !== "directory" || parent.metadata.nlink === 0) return undefined
        node = parent
      }

      return SLASH_HEX + names.reverse().join(SLASH_HEX)
    }

    const entryPath = (prefix: string, name: string) =>
      ownedPath(nameBytes(prefix + (prefix === SLASH_HEX ? "" : SLASH_HEX) + name))

    // Events name their paths against the installed value, and only once a watcher takes them.
    const publishEntry = (_tag: Change["_tag"], parent: Ino, name: string) => {
      current().events.push((installed) => {
        const prefix = pathOf((ino) => getNode(installed, ino), parent)

        return prefix === undefined ? [] : [{ _tag, path: entryPath(prefix, name) }]
      })
    }

    const publishNode = (ino: Ino) => {
      const target = current().get(ino)

      if (target === undefined) return

      if (target.kind === "directory") {
        current().events.push((installed) => {
          const path = pathOf((at) => getNode(installed, at), ino)

          return path === undefined ? [] : [UpdateChange.make({ path: ownedPath(nameBytes(path)) })]
        })

        return
      }

      // The names bound now: a later transition may rename them, but this one published these.
      const links = target.links

      current().events.push((installed) => {
        const changes: Array<Change> = []

        for (const link of links) {
          const prefix = pathOf((at) => getNode(installed, at), link.parent)

          if (prefix !== undefined) changes.push(UpdateChange.make({ path: entryPath(prefix, link.name) }))
        }

        return changes
      })
    }

    const captureState = Effect.fnUntraced(function*() {
      const captured = state
      const snapshot = yield* captureSnapshot(captured)

      yield* (yield* VolumeTestSeams).betweenSnapshotAndSummary

      return { snapshot, observation: yield* observeChanges(captured) }
    })

    const referenceFor = (ino: Ino): ObjectReference => {
      const existing = tokens.get(ino)

      if (existing !== undefined) return existing
      const reference = Object.freeze({ [ObjectReferenceId]: true as const })
      objectReferences.set(reference, { volume: volumeIdentity, ino })
      tokens.set(ino, reference)

      return reference
    }

    const holdDirectory = (ino: Ino) => {
      directoryHolds.set(ino, (directoryHolds.get(ino) ?? 0) + 1)
    }

    // Drops one hold; a detached directory nothing holds any more leaves the table.
    const unholdDirectory = (ino: Ino) => {
      const count = (directoryHolds.get(ino) ?? 1) - 1

      if (count > 0) {
        directoryHolds.set(ino, count)

        return
      }

      directoryHolds.delete(ino)
      const node = getNode(state, ino)

      if (node?.kind === "directory" && node.metadata.nlink === 0) applyDirect((d) => d.remove(ino))
    }

    const releaseDirectory = (reference: DirectoryReference) => {
      const ino = reference.ino
      reference.ino = undefined
      reference.closed = true

      if (ino !== undefined) unholdDirectory(ino)
    }

    const finalizeDirectory = (reference: DirectoryReference) =>
      Effect.uninterruptible(
        Effect.suspend(() =>
          reference.closed
            ? Effect.void
            : coordinatedCleanup(Effect.sync(() => releaseDirectory(reference)))
        )
      )

    // Only a close that released the handle closes its scope; an interrupted close leaves both open.
    const closeReleasedScope = (reference: HandleScope) =>
      Effect.suspend(() =>
        !reference.closed || reference.scope === undefined ? Effect.void : Scope.close(reference.scope, Exit.void)
      )

    const authorize = (node: Node, identity: Identity, bits: number, op: OpContext) => {
      if (identity.privileged) return Effect.void
      const metadata = node.metadata

      const shift = metadata.uid === identity.uid ?
        6
        : inGroup(identity, metadata.gid)
        ? 3
        : 0

      return ((metadata.mode >> shift) & bits) === bits
        ? Effect.void
        : Effect.fail(op.fail("AccessDenied"))
    }

    // An inode no name reaches leaves the table once nothing holds it open; a file's bytes are released then.
    const reclaim = (d: Draft, ino: Ino) => {
      const node = d.get(ino)

      if (node === undefined) return

      if (node.kind === "file") {
        if (node.links.length > 0 || d.openCount(ino) > 0) return
        d.usedBytes -= BigInt(node.data.bytes.length)
      } else if (node.kind === "symlink") {
        if (node.links.length > 0) return
        d.usedBytes -= BigInt(node.target.length)
      } else if (node.metadata.nlink > 0 || directoryHolds.has(ino)) return

      d.remove(ino)
    }

    // Whether the volume's entry quota is already full.
    const atEntryLimit = () => settings.maxEntries !== undefined && current().entries >= settings.maxEntries

    // Every new entry but a replacement names a new inode, so running out of inode numbers is running out of space.
    const reserveEntry = (op: OpContext) =>
      atEntryLimit() || !current().canAllocate ? Effect.fail(op.fail("NoSpace")) : Effect.void

    const reserveBytes = (op: OpContext, bytes: bigint) =>
      settings.maxBytes !== undefined && bytes > ByteSize.toBigInt(settings.maxBytes) - current().usedBytes
        ? Effect.fail(op.fail("NoSpace"))
        : Effect.void

    // Adds a name for a child. A new subdirectory's ".." entry is a second link to the parent; other node kinds
    // add none. The child records the name too, so events and paths never search for it.
    const attach = (parent: Directory, name: string, child: Node, now: bigint) => {
      const d = current()

      d.put(withEntries(
        {
          ...parent,
          metadata: {
            ...parent.metadata,
            nlink: parent.metadata.nlink + (child.kind === "directory" ? 1 : 0),
            mtimeNs: now,
            ctimeNs: now
          }
        },
        (entries) => entries.set(name, child.ino)
      ))

      if (child.kind === "directory") d.put({ ...child, parent: parent.ino, name })
      else {
        d.put({
          ...child,
          links: [...child.links, { parent: parent.ino, name }],
          metadata: { ...child.metadata, nlink: child.links.length + 1, ctimeNs: now }
        })
      }
    }

    // Drops the name `parent`/`name` from a child, which the caller has already removed from the parent.
    const detach = (child: Node, parent: Ino, name: string, now: bigint) => {
      const d = current()

      if (child.kind === "directory") {
        d.put({ ...child, metadata: { ...child.metadata, nlink: 0, ctimeNs: now } })
      } else {
        const links = withoutLink(child.links, parent, name)
        d.put({ ...child, links, metadata: { ...child.metadata, nlink: links.length, ctimeNs: now } })
      }

      reclaim(d, child.ino)
    }

    const releaseFile = (ref: FileReference) => {
      const ino = ref.ino

      if (ino !== undefined) {
        const d = current()
        d.release(ino)
        reclaim(d, ino)
      }

      ref.ino = undefined
      ref.closed = true
    }

    const releaseOpenFile = (ref: FileReference) =>
      coordinatedCleanup(Effect.sync(() => {
        if (!ref.closed) applyDirect(() => releaseFile(ref))
      }))

    // Explicit close and scope cleanup share one release. A release whose commit fails still completes as
    // cleanup, so the handle never stays open; only an explicit close reports the failure. A close refused
    // admission never entered the volume, so it leaves the handle open for a retry.
    const closeFile = (ref: FileReference, op: OpContext, check: Effect.Effect<unknown, FsFailure>) =>
      coordinated(
        op,
        Effect.andThen(
          check,
          Effect.sync(() => {
            const ino = ref.ino

            if (ino !== undefined) {
              const d = current()
              d.release(ino)
              reclaim(d, ino)
            }

            current().after.push(() => {
              ref.ino = undefined
              ref.closed = true
            })
          })
        ),
        () => applyDirect(() => releaseFile(ref))
      ).pipe(
        Effect.tapError((error) => error.code === "VolumeBusy" ? Effect.void : releaseOpenFile(ref))
      )

    // Keyed on the file rather than the closed flag, so a rerun releases an open that published after a first run.
    // Cleanup is uninterruptible and does not need admission, so an interrupted or busy scope close still releases.
    const finalizeFile = (ref: FileReference) =>
      Effect.uninterruptible(Effect.suspend(() =>
        ref.ino === undefined
          ? Effect.sync(() => {
            ref.closed = true
          })
          : Effect.ignore(closeFile(ref, OpContext.make("close"), Effect.void)).pipe(
            Effect.andThen(Effect.suspend(() => ref.closed ? Effect.void : releaseOpenFile(ref)))
          )
      ))

    // Acquires a handle into its own scope, forked from the caller's. The finalizer is registered before waiting,
    // since a closed scope runs a new finalizer at once and the permit is not reentrant. A scope that closes
    // before or during acquisition interrupts it, and releasing here, under the permit, keeps the acquisition
    // from outliving a finalizer that already ran. A scope that closes while the acquisition commits interrupts it
    // too. Every exit without a handle reruns the finalizer, which may have run before the commit published and
    // which closing an already closed scope would not run again.
    const acquireHandle = Effect.fnUntraced(function*<A, E, R>(
      reference: HandleScope,
      coordinate: (acquire: Effect.Effect<A, E, R>) => Effect.Effect<A, E | FsFailure, R>,
      acquire: Effect.Effect<A, E, R>,
      releaseAcquired: () => void,
      finalize: Effect.Effect<void>
    ) {
      const scope = yield* Scope.fork(yield* Effect.scope)
      reference.scope = scope
      yield* Scope.addFinalizer(scope, finalize)
      const closed = () => Predicate.isTagged(scope.state, "Closed")

      return yield* coordinate(
        Effect.suspend(() => closed() ? Effect.interrupt : acquire).pipe(
          Effect.tap(() =>
            Effect.suspend(() => {
              if (!closed()) return Effect.void
              releaseAcquired()

              return Effect.interrupt
            })
          )
        )
      ).pipe(
        Effect.tap(() => Effect.suspend(() => closed() ? Effect.interrupt : Effect.void)),
        Effect.onError(() => Effect.andThen(finalize, Scope.close(scope, Exit.void)))
      )
    })

    // Records the inode a handle opened, once the transition that opened it is installed.
    const bindFile = (ref: FileReference, ino: Ino) => {
      current().after.push(() => {
        ref.ino = ino
      })
    }

    // Replacing a payload clears setuid and setgid, and charges the volume for the size delta.
    const replaceContent = (file: RegularFile, data: Uint8Array, now: bigint, publish = true) => {
      const d = current()
      d.usedBytes += BigInt(data.length - file.data.bytes.length)
      d.put({
        ...file,
        data: Content.make(data),
        metadata: {
          ...file.metadata,
          size: BigInt(data.length),
          mode: file.metadata.mode & ~SET_ID_BITS,
          mtimeNs: now,
          ctimeNs: now
        }
      })

      if (publish) publishNode(file.ino)
    }

    const resize = Effect.fnUntraced(function*(file: RegularFile, length: bigint, op: OpContext, publish = true) {
      if (!Predicate.isBigInt(length) || length < 0n) {
        return yield* op.fail("InvalidArgument")
      }

      if (length > BigInt(maxFileBytes)) return yield* op.fail("FileTooLarge")
      const size = Number(length)

      yield* reserveBytes(op, BigInt(size - file.data.bytes.length))

      const data = new Uint8Array(size)
      data.set(file.data.bytes.subarray(0, size))
      replaceContent(file, data, yield* timestamp(op), publish)
    })

    const fileHandle = (ref: FileReference): FileHandle => {
      const get = (op: OpContext, access?: "read" | "write") => {
        const node = ref.ino === undefined ? undefined : view(ref.ino)

        return node?.kind !== "file" || (access === "read" && ref.access === "write") ||
            (access === "write" && ref.access === "read")
          ? Effect.fail(op.fail("InvalidHandle"))
          : Effect.succeed(node)
      }

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
              current().putQuiet({ ...file, metadata: { ...file.metadata, atimeNs: (yield* timestamp(readOp)) } })
            }

            if (position === undefined) {
              const next = offset + BigInt(data.length)
              current().after.push(() => {
                ref.offset = next
              })
            }

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
              : ByteSize.toBigInt(settings.maxBytes) - current().usedBytes

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

            if (position === undefined) {
              const next = offset + BigInt(count)
              current().after.push(() => {
                ref.offset = next
              })
            }

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
        close: closeFile(ref, closeOp, Effect.suspend(() => get(closeOp))).pipe(
          Effect.ensuring(closeReleasedScope(ref)),
          Effect.withSpan("FileHandle.close")
        )
      })

      files.set(handle, ref)

      return handle
    }

    const createCaller = (reference: DirectoryReference, identity: Identity, umask: number): Caller => {
      const referencedNode = Effect.fnUntraced(function*(target: ObjectReference, op: OpContext) {
        if (reference.ino === undefined) return yield* op.fail("ClosedCaller")

        if (!Predicate.isObject(target)) return yield* op.fail("InvalidReference")
        const known = objectReferences.get(target)

        if (known === undefined) return yield* op.fail("InvalidReference")

        if (known.volume !== volumeIdentity) {
          return yield* op.fail("ForeignReference")
        }

        const node = view(known.ino)

        // A removed directory goes stale at once, even while a handle keeps its inode in the table.
        if (node === undefined || (node.kind === "directory" && node.metadata.nlink === 0)) {
          return yield* op.fail("StaleReference")
        }

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

      // The caller's own directory, which a closed caller no longer has.
      const callerDirectory = (op: OpContext) => {
        const node = reference.ino === undefined ? undefined : view(reference.ino)

        return node?.kind === "directory" ? Effect.succeed(node) : Effect.fail(op.fail("ClosedCaller"))
      }

      // Re-reads a directory the transition may have replaced since it was resolved.
      const directoryNow = (ino: Ino): Directory => {
        const node = view(ino)

        if (node?.kind !== "directory") throw new Error("Directory left the inode table during a transition")

        return node
      }

      const nodeNow = (ino: Ino): Node => {
        const node = view(ino)

        if (node === undefined) throw new Error("Inode left the table during a transition")

        return node
      }

      const creationTimes = (times: Times | undefined, now: bigint) => ({
        atimeNs: times?.access.kind === "value" ? times.access.nanoseconds : now,
        mtimeNs: times?.modification.kind === "value" ? times.modification.nanoseconds : now
      })

      const newDirectory = (parent: Directory, mode: number, now: bigint, times?: Times): Directory => {
        const ino = current().allocate()

        return {
          kind: "directory",
          ino,
          lineage: undefined,
          parent: parent.ino,
          name: "",
          entries: new Map(),
          metadata: {
            ...directoryMetadata(BigInt(ino), identity.uid, parent.metadata.gid, mode, now),
            ...creationTimes(times, now)
          },
          revision: 0n
        }
      }

      const newFile = (
        parent: Directory,
        data: Content.Content,
        mode: number,
        now: bigint,
        owner?: OwnerUpdate,
        times?: Times
      ): RegularFile => {
        const ino = current().allocate()

        return {
          kind: "file",
          ino,
          lineage: undefined,
          data,
          links: [],
          metadata: {
            ...directoryMetadata(
              BigInt(ino),
              owner?.uid ?? identity.uid,
              owner?.gid ?? parent.metadata.gid,
              mode,
              now
            ),
            ...creationTimes(times, now),
            kind: "file",
            size: BigInt(data.bytes.length),
            nlink: 0
          },
          revision: 0n
        }
      }

      const newSymlink = (parent: Directory, target: Uint8Array, now: bigint, times?: Times): SymbolicLink => {
        const ino = current().allocate()

        return {
          kind: "symlink",
          ino,
          lineage: undefined,
          target,
          links: [],
          metadata: {
            ...directoryMetadata(BigInt(ino), identity.uid, parent.metadata.gid, 0o777, now),
            ...creationTimes(times, now),
            kind: "symlink",
            nlink: 0,
            size: BigInt(target.length)
          },
          revision: 0n
        }
      }

      const lookup = Effect.fnUntraced(function*(
        path: PreparedPath,
        base: DirectoryHandle | undefined,
        op: OpContext,
        options: LookupOptions = {},
        referencedBase?: Directory
      ) {
        const pathOp = op.at(path.input)
        const { followFinalSymlink = true, allowMissing = false, parentOnly = false } = options

        if (reference.ino === undefined) {
          return yield* pathOp.fail("ClosedCaller")
        }

        let current: Node = path.absolute ? nodeNow(ROOT_INO) : yield* callerDirectory(pathOp)

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

          const directory = target.ino === undefined ? undefined : view(target.ino)

          if (directory?.kind !== "directory") {
            return yield* pathOp.fail("InvalidHandle")
          }

          current = directory
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
            current = directoryNow(current.parent)
            parent = undefined
            name = undefined
            continue
          }

          parent = current
          name = component
          const childIno = current.entries.get(component)
          const child = childIno === undefined ? undefined : view(childIno)

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

            if (work.absolute) current = nodeNow(ROOT_INO)
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
            parent: parent.ino,
            name: path.components.at(-1),
            trailingSlash: path.trailingSlash,
            op: op.at(path.input)
          } satisfies ResolvedEntry
        }),
        // Takes a name the caller validated before coordination, so a bad name outranks the reference.
        fromReference: Effect.fnUntraced(function*(directoryReference: ObjectReference, name: string, op: OpContext) {
          const parent = yield* referencedDirectory(directoryReference, op)

          return { parent: parent.ino, name, trailingSlash: false, op } satisfies ResolvedEntry
        })
      }

      const acquireDirectory = Effect.fnUntraced(
        function*(input: PathInput, options: RelativeOptions | undefined, op: OpContext) {
          const pathOp = op.at(input)
          const prepared = preparePath(input, op.operation, settings.maxPathBytes)
          const base = options?.relativeTo
          const acquired = makeDirectoryReference()

          return yield* acquireHandle(
            acquired,
            (acquire) => coordinatedRead(op, Effect.uninterruptible(acquire)),
            Effect.gen(function*() {
              const path = yield* Effect.fromResult(prepared)
              const directory = yield* locate(path, base, op)
              yield* authorize(directory, identity, EXECUTE, pathOp)
              holdDirectory(directory.ino)
              acquired.ino = directory.ino

              return acquired
            }),
            // Nothing to undo here: the finalizer that follows an interrupted acquisition releases the hold under
            // every permit, where a detached directory may leave the table.
            () => {},
            finalizeDirectory(acquired)
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
            current().putQuiet({ ...directory, metadata: { ...directory.metadata, atimeNs: (yield* timestamp(op)) } })

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
            const directory = result.node?.kind === "directory" ? result.node : result.parent
            const prefix = directory === undefined ? SLASH_HEX : pathOf(view, directory.ino)

            if (prefix === undefined) {
              return yield* pathOp.fail("NotFound")
            }

            if (result.node?.kind === "directory" || result.name === undefined) return nameBytes(prefix)

            return nameBytes(prefix + (prefix === SLASH_HEX ? "" : SLASH_HEX) + result.name)
          })
        )
      })

      const ResolvedNode = {
        // A handle has no caller path, so its failures name none.
        fromTarget: Effect.fnUntraced(function*(
          target: PathInput | FileHandle | DirectoryHandle,
          options: MetadataOptions | undefined,
          op: OpContext
        ) {
          if (reference.ino === undefined) {
            return yield* op.fail("ClosedCaller")
          }

          if (isFileHandle(target) || isDirectoryHandle(target)) {
            const ref = isFileHandle(target) ? files.get(target) : handles.get(target)

            if (ref === undefined) return yield* op.fail("InvalidHandle")

            if (ref.volume !== volumeIdentity) {
              return yield* op.fail("ForeignHandle")
            }

            const node = ref.ino === undefined ? undefined : view(ref.ino)

            if (node === undefined) return yield* op.fail("InvalidHandle")

            return { ino: node.ino, op } satisfies ResolvedNode
          }

          const path = yield* Effect.fromResult(preparePath(target, op.operation, settings.maxPathBytes))

          const node = yield* resolveNode(path, options?.relativeTo, op, {
            followFinalSymlink: options?.followFinalSymlink !== false
          })

          return { ino: node.ino, op: op.at(target) } satisfies ResolvedNode
        }),
        // Unlike fromTarget, a closed caller surfaces from the lookup and names the path.
        fromPath: Effect.fnUntraced(function*(
          prepared: Result.Result<PreparedPath, FsFailure>,
          base: DirectoryHandle | undefined,
          op: OpContext
        ) {
          const path = yield* Effect.fromResult(prepared)
          const node = yield* resolveNode(path, base, op)

          return { ino: node.ino, op: op.at(path.input) } satisfies ResolvedNode
        }),
        fromReference: (target: ObjectReference, op: OpContext) =>
          Effect.map(referencedNode(target, op), (node): ResolvedNode => ({ ino: node.ino, op }))
      }

      const permittedMode = (metadata: Pick<Metadata, "kind" | "uid" | "gid">, mode: number, op: OpContext) => {
        if (!identity.privileged && identity.uid !== metadata.uid) {
          return Effect.fail(op.fail("AccessDenied"))
        }

        const group = inGroup(identity, metadata.gid)

        return Effect.succeed(!identity.privileged && metadata.kind === "file" && !group ? mode & ~0o2000 : mode)
      }

      const changeMode = Effect.fnUntraced(
        function*(resolve: () => Effect.Effect<ResolvedNode, FsFailure>, mode: number, op: OpContext) {
          if (!isMode(mode)) return yield* op.fail("InvalidArgument")
          const resolving = resolve()

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const node = nodeNow((yield* resolving).ino)
              const permitted = yield* permittedMode(node.metadata, mode, op)
              current().put({
                ...node,
                metadata: {
                  ...node.metadata,
                  mode: permitted,
                  ctimeNs: (yield* timestamp(op))
                }
              })
              publishNode(node.ino)
            })
          )
        }
      )

      const changeOwner = Effect.fnUntraced(
        function*(resolve: () => Effect.Effect<ResolvedNode, FsFailure>, owner: OwnerUpdate, op: OpContext) {
          const decoded = yield* decodeOwnerUpdate(owner).pipe(
            Effect.mapError((cause) => op.fail("InvalidArgument", { cause }))
          )

          const update = { ...decoded }
          const resolving = resolve()

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const node = nodeNow((yield* resolving).ino)

              if (
                !identity.privileged && (identity.uid !== node.metadata.uid ||
                  (update.uid !== undefined && update.uid !== node.metadata.uid) ||
                  (update.gid !== undefined && !inGroup(identity, update.gid)))
              ) {
                return yield* op.fail("AccessDenied")
              }

              if (update.uid === undefined && update.gid === undefined) return
              current().put({
                ...node,
                metadata: {
                  ...node.metadata,
                  uid: update.uid ?? node.metadata.uid,
                  gid: update.gid ?? node.metadata.gid,
                  mode: node.kind === "file" ? node.metadata.mode & ~SET_ID_BITS : node.metadata.mode,
                  ctimeNs: (yield* timestamp(op))
                }
              })
              publishNode(node.ino)
            })
          )
        }
      )

      const changeTimes = Effect.fnUntraced(
        function*(resolve: () => Effect.Effect<ResolvedNode, FsFailure>, times: Times, op: OpContext) {
          const decoded = yield* decodeTimes(times).pipe(
            Effect.mapError((cause) => op.fail("InvalidArgument", { cause }))
          )

          const access = { ...decoded.access }
          const modification = { ...decoded.modification }
          const resolving = resolve()

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const resolved = yield* resolving
              const node = nodeNow(resolved.ino)

              if (access.kind === "omit" && modification.kind === "omit") return

              // POSIX grants write access only when both times are UTIME_NOW; both UTIME_OMIT
              // returned above. Every other combination, mixed ones included, needs ownership.
              if (!identity.privileged && identity.uid !== node.metadata.uid) {
                if (access.kind !== "now" || modification.kind !== "now") {
                  return yield* resolved.op.fail("AccessDenied")
                }

                yield* authorize(node, identity, WRITE, resolved.op)
              }

              const now = yield* timestamp(op)
              current().put({
                ...node,
                metadata: {
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
              })
              publishNode(node.ino)
            })
          )
        }
      )

      // Takes bits the caller already validated, since that failure names the path on paths only.
      const accessNode = (resolve: () => Effect.Effect<ResolvedNode, FsFailure>, bits: number, op: OpContext) => {
        const resolving = resolve()

        return coordinatedRead(
          op,
          Effect.gen(function*() {
            const { ino, op: nodeOp } = yield* resolving
            const node = nodeNow(ino)

            if (node.kind === "file" && (bits & EXECUTE) !== 0 && (node.metadata.mode & ANY_EXECUTE) === 0) {
              return yield* nodeOp.fail("AccessDenied")
            }

            yield* authorize(node, identity, bits, nodeOp)
          })
        )
      }

      const truncateNode = (resolve: () => Effect.Effect<ResolvedNode, FsFailure>, length: bigint, op: OpContext) => {
        const resolving = resolve()

        return coordinated(
          op,
          Effect.gen(function*() {
            const { ino, op: nodeOp } = yield* resolving
            const node = nodeNow(ino)

            if (node.kind !== "file") return yield* nodeOp.fail("IsDirectory")

            yield* authorize(node, identity, WRITE, nodeOp)
            yield* resize(node, length, op)
          })
        )
      }

      const authorizeRemoval = (parent: Directory, child: Node, op: OpContext) =>
        (parent.metadata.mode & STICKY_BIT) !== 0 && !identity.privileged &&
          identity.uid !== parent.metadata.uid && identity.uid !== child.metadata.uid
          ? Effect.fail(op.fail("AccessDenied"))
          : Effect.void

      // Authorizes creating the entry and returns its name. Only a path can name a dot entry, and one always
      // exists, so it fails as AlreadyExists.
      const claimName = Effect.fnUntraced(function*(entry: ResolvedEntry) {
        const parent = directoryNow(entry.parent)
        yield* authorize(parent, identity, WRITE | EXECUTE, entry.op)

        if (isDotComponent(entry.name) || parent.entries.has(entry.name)) {
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
        const name = yield* claimName(entry)

        yield* reserveEntry(entry.op)
        const parent = directoryNow(entry.parent)
        const before = parent.revision
        const now = yield* timestamp(op)

        const mode = request.exactMode
          ? yield* permittedMode({ kind: "directory", uid: identity.uid, gid: parent.metadata.gid }, request.mode, op)
          : (request.mode & 0o777 & ~umask) | (request.mode & STICKY_BIT)

        const child = newDirectory(parent, mode, now, request.times)

        // No Effect yield or expected failure between these publication writes.
        attach(parent, name, child, now)
        current().entries += 1
        publishEntry("Create", parent.ino, name)

        return { child: child.ino, directory: { before, after: current().revision } }
      })

      const linkNode = Effect.fnUntraced(
        function*(node: Exclude<Node, Directory>, entry: ResolvedEntry, op: OpContext) {
          const name = yield* claimName(entry)

          if (entry.trailingSlash) return yield* entry.op.fail("NotDirectory")
          yield* reserveEntry(entry.op)
          const parent = directoryNow(entry.parent)
          const before = parent.revision
          const now = yield* timestamp(op)
          attach(parent, name, node, now)
          current().entries += 1
          publishEntry("Create", parent.ino, name)

          return { before, after: current().revision }
        }
      )

      // Takes target bytes the caller already copied, so nothing else holds them.
      const makeSymlink = Effect.fnUntraced(function*(
        entry: ResolvedEntry,
        target: Uint8Array,
        times: Times | undefined,
        op: OpContext
      ) {
        const name = yield* claimName(entry)

        if (entry.trailingSlash) return yield* entry.op.fail("NotDirectory")
        yield* reserveEntry(entry.op)
        yield* reserveBytes(entry.op, BigInt(target.length))
        const parent = directoryNow(entry.parent)
        const before = parent.revision
        const now = yield* timestamp(op)
        const child = newSymlink(parent, target, now, times)

        attach(parent, name, child, now)
        current().entries += 1
        current().usedBytes += BigInt(target.length)
        publishEntry("Create", parent.ino, name)

        return { child: child.ino, directory: { before, after: current().revision } }
      })

      // A directory's ".." entry was a link to the parent, so removing one drops the parent's link count.
      const removeChild = Effect.fnUntraced(function*(parent: Directory, name: string, child: Node, op: OpContext) {
        const before = parent.revision
        const now = yield* timestamp(op)
        const d = current()

        d.put(withEntries(
          {
            ...parent,
            metadata: {
              ...parent.metadata,
              nlink: parent.metadata.nlink - (child.kind === "directory" ? 1 : 0),
              mtimeNs: now,
              ctimeNs: now
            }
          },
          (entries) => entries.delete(name)
        ))
        // The event names the entry before the child loses its link, since a symlink's bytes go with it.
        publishEntry("Remove", parent.ino, name)
        detach(child, parent.ino, name, now)
        d.entries -= 1

        return { before, after: d.revision }
      })

      // Authorizes removing from the entry's directory and returns the named child. Only a path can name a dot
      // entry, and each verb reports it with its own code.
      const removalTarget = Effect.fnUntraced(function*(
        entry: ResolvedEntry,
        dotNameCode: "IsDirectory" | "InvalidArgument"
      ) {
        const parent = directoryNow(entry.parent)
        yield* authorize(parent, identity, WRITE | EXECUTE, entry.op)

        if (isDotComponent(entry.name)) return yield* entry.op.fail(dotNameCode)
        const childIno = parent.entries.get(entry.name)
        const child = childIno === undefined ? undefined : view(childIno)

        if (child === undefined) return yield* entry.op.fail("NotFound")

        return { parent, name: entry.name, child }
      })

      // Removes a file or an empty directory; only references reach it, so a dot name never does.
      const removeEntry = Effect.fnUntraced(function*(entry: ResolvedEntry, op: OpContext) {
        const { child, name, parent } = yield* removalTarget(entry, "InvalidArgument")
        yield* authorizeRemoval(parent, child, entry.op)

        if (child.kind === "directory" && child.entries.size > 0) return yield* entry.op.fail("NotEmpty")

        return yield* removeChild(parent, name, child, op)
      })

      const unlinkEntry = Effect.fnUntraced(function*(entry: ResolvedEntry, op: OpContext) {
        const { child, name, parent } = yield* removalTarget(entry, "IsDirectory")

        if (child.kind === "directory") return yield* entry.op.fail("IsDirectory")

        if (entry.trailingSlash) return yield* entry.op.fail("NotDirectory")
        yield* authorizeRemoval(parent, child, entry.op)

        return yield* removeChild(parent, name, child, op)
      })

      // Needs no trailing-slash check: anything it removes is a directory.
      const rmdirEntry = Effect.fnUntraced(function*(entry: ResolvedEntry, op: OpContext) {
        const { child, name, parent } = yield* removalTarget(entry, "InvalidArgument")
        yield* authorizeRemoval(parent, child, entry.op)

        if (child.kind !== "directory") return yield* entry.op.fail("NotDirectory")

        if (child.entries.size > 0) return yield* entry.op.fail("NotEmpty")

        return yield* removeChild(parent, name, child, op)
      })

      const renameEntry = Effect.fnUntraced(
        function*(source: ResolvedEntry, destination: ResolvedEntry, op: OpContext) {
          const sourceDirectory = directoryNow(source.parent)
          const destinationDirectory = directoryNow(destination.parent)
          const sameDirectory = source.parent === destination.parent
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
          const childIno = sourceDirectory.entries.get(sourceName)
          const child = childIno === undefined ? undefined : view(childIno)

          if (child === undefined) return yield* source.op.fail("NotFound")
          const replacedIno = destinationDirectory.entries.get(destinationName)
          const replaced = replacedIno === undefined ? undefined : view(replacedIno)

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
            sameDirectory
              ? {
                _tag: "SameDirectory" as const,
                directory: { before: sourceBefore, after: directoryNow(source.parent).revision }
              }
              : {
                _tag: "DifferentDirectories" as const,
                sourceDirectory: { before: sourceBefore, after: directoryNow(source.parent).revision },
                destinationDirectory: { before: destinationBefore, after: directoryNow(destination.parent).revision }
              }

          if (child.ino === replaced?.ino) return result()
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

          for (let ancestor = destinationDirectory;; ancestor = directoryNow(ancestor.parent)) {
            if (ancestor.ino === child.ino) return yield* destination.op.fail("InvalidArgument")

            if (ancestor.ino === ROOT_INO) break
          }

          const now = yield* timestamp(op)
          const d = current()

          // Every rejection above precedes the namespace and metadata writes below, and the old name is
          // published before the namespace changes.
          publishEntry("Remove", sourceDirectory.ino, sourceName)

          d.put(withEntries(
            {
              ...sourceDirectory,
              metadata: {
                ...sourceDirectory.metadata,
                nlink: sourceDirectory.metadata.nlink - (child.kind === "directory" ? 1 : 0),
                mtimeNs: now,
                ctimeNs: now
              }
            },
            (entries) => entries.delete(sourceName)
          ))

          const destinationNow = directoryNow(destination.parent)

          d.put(withEntries(
            {
              ...destinationNow,
              metadata: {
                ...destinationNow.metadata,
                nlink: destinationNow.metadata.nlink + (child.kind === "directory" && replaced === undefined ? 1 : 0),
                mtimeNs: now,
                ctimeNs: now
              }
            },
            (entries) => entries.set(destinationName, child.ino)
          ))

          const moved = nodeNow(child.ino)

          if (moved.kind === "directory") {
            d.put({
              ...moved,
              parent: destination.parent,
              name: destinationName,
              metadata: { ...moved.metadata, ctimeNs: now }
            })
          } else {
            d.put({
              ...moved,
              links: [
                ...withoutLink(moved.links, source.parent, sourceName),
                { parent: destination.parent, name: destinationName }
              ],
              metadata: { ...moved.metadata, ctimeNs: now }
            })
          }

          if (replaced !== undefined) {
            detach(nodeNow(replaced.ino), destination.parent, destinationName, now)
            d.entries -= 1
          }

          publishEntry("Create", destination.parent, destinationName)

          return result()
        }
      )

      // Opens an existing regular file for the requested access, truncating it when asked.
      const openExisting = Effect.fnUntraced(function*(
        file: RegularFile,
        request: Pick<OpenRequest, "access" | "truncate">,
        at: OpContext,
        op: OpContext
      ) {
        yield* authorize(
          file,
          identity,
          request.access === "read" ? READ : request.access === "write" ? WRITE : READ | WRITE,
          at
        )

        if (request.truncate) yield* resize(file, 0n, op)
      })

      // An entry whose name the front end already checked, since creating one needs a real name.
      type NamedEntry = ResolvedEntry & { readonly name: string }

      // Needs no trailing-slash checks: a path's lookup already rejects a trailing slash on anything but a
      // directory, and a reference name cannot hold one.
      const openFile = Effect.fnUntraced(function*(
        entry: NamedEntry,
        found: Node | undefined,
        request: OpenRequest,
        acquired: FileReference,
        op: OpContext
      ) {
        const { name } = entry
        const parent = directoryNow(entry.parent)
        const before = parent.revision
        let file = found
        let created = false

        if (file === undefined) {
          if (request.create === undefined || request.create === "never") return yield* entry.op.fail("NotFound")

          yield* authorize(parent, identity, WRITE | EXECUTE, entry.op)
          yield* reserveEntry(entry.op)
          const size = request.initialSize ?? 0n

          if (request.initialSize !== undefined) {
            if (size < 0n) return yield* entry.op.fail("InvalidArgument")

            if (size > BigInt(maxFileBytes)) return yield* entry.op.fail("FileTooLarge")
            yield* reserveBytes(entry.op, size)
          }

          const owner = request.owner

          if (
            !identity.privileged &&
            ((owner?.uid !== undefined && owner.uid !== identity.uid) ||
              (owner?.gid !== undefined && !inGroup(identity, owner.gid)))
          ) {
            return yield* entry.op.fail("AccessDenied")
          }

          const now = yield* timestamp(op)

          const mode = request.exactMode
            ? yield* permittedMode(
              { kind: "file", uid: owner?.uid ?? identity.uid, gid: owner?.gid ?? parent.metadata.gid },
              request.mode!,
              op
            )
            : (request.mode ?? 0o666) & 0o777 & ~umask

          file = newFile(parent, Content.make(new Uint8Array(Number(size))), mode, now, owner, request.times)
          attach(parent, name, file, now)
          current().entries += 1
          current().usedBytes += size
          created = true
          publishEntry("Create", parent.ino, name)
        } else {
          if (file.kind === "symlink") return yield* entry.op.fail("SymlinkLoop")

          if (file.kind !== "file") return yield* entry.op.fail("IsDirectory")
          yield* openExisting(file, request, entry.op, op)
        }

        current().retain(file.ino)
        bindFile(acquired, file.ino)

        return { ino: file.ino, created, directory: { before, after: directoryNow(entry.parent).revision } }
      })

      // Releases a file this transition opened, before the transition installs.
      const releasePending = (opened: () => Ino | undefined) => () => {
        const ino = opened()

        if (ino === undefined) return
        current().release(ino)
        reclaim(current(), ino)
      }

      const acquireOpenedFile = <A, E, R>(
        ref: FileReference,
        op: OpContext,
        acquire: (opened: (ino: Ino) => void) => Effect.Effect<A, E, R>
      ) => {
        let opened: Ino | undefined

        return acquireHandle(
          ref,
          (effect) => coordinated(op, effect),
          acquire((ino) => {
            opened = ino
          }),
          releasePending(() => opened),
          finalizeFile(ref)
        )
      }

      const rootReferenceOp = OpContext.make("rootReference")

      return Object.freeze({
        [CallerId]: true as const,
        rootReference: coordinatedRead(
          rootReferenceOp,
          Effect.gen(function*() {
            if (reference.ino === undefined) {
              return yield* rootReferenceOp.fail("ClosedCaller")
            }

            return referenceFor(ROOT_INO)
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

              return referenceFor(directory.parent)
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

          return yield* accessNode(() => ResolvedNode.fromReference(objectReference, op), bits, op)
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
                [...directory.entries].map(([name, child]) =>
                  Object.freeze({ name: nameBytes(name), reference: referenceFor(child) })
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

                return { reference: referenceFor(node.ino), directory }
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

          return yield* changeMode(() => ResolvedNode.fromReference(objectReference, op), mode, op)
        }),
        chownReference: Effect.fn("Caller.chownReference")(function*(objectReference, owner) {
          const op = OpContext.make("chownReference")

          return yield* changeOwner(() => ResolvedNode.fromReference(objectReference, op), owner, op)
        }),
        utimesReference: Effect.fn("Caller.utimesReference")(function*(objectReference, times) {
          const op = OpContext.make("utimesReference")

          return yield* changeTimes(() => ResolvedNode.fromReference(objectReference, op), times, op)
        }),
        truncateReference: Effect.fn("Caller.truncateReference")(function*(objectReference, length) {
          const op = OpContext.make("truncateReference")

          return yield* truncateNode(() => ResolvedNode.fromReference(objectReference, op), length, op)
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

          return yield* acquireOpenedFile(
            acquired,
            op,
            (opened) =>
              Effect.gen(function*() {
                const node = yield* referencedNode(objectReference, op)

                if (node.kind !== "file") return yield* op.fail("IsDirectory")

                if (node.metadata.nlink === 0) {
                  return yield* op.fail("StaleReference")
                }

                yield* openExisting(node, chosen, op, op)
                current().retain(node.ino)
                bindFile(acquired, node.ino)
                opened(node.ino)

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

            return yield* acquireOpenedFile(
              acquired,
              op,
              (opened) =>
                Effect.gen(function*() {
                  const parent = yield* referencedDirectory(directoryReference, op)
                  yield* authorize(parent, identity, EXECUTE, op)
                  const directIno = parent.entries.get(name)
                  const direct = directIno === undefined ? undefined : view(directIno)

                  if (expected !== undefined) {
                    let expectedIno: Ino | undefined

                    if (expected !== null) {
                      const observed = yield* Effect.result(referencedNode(expected, op))

                      if (Result.isFailure(observed)) {
                        return yield* op.fail("VolumeBusy", { cause: observed.failure })
                      }

                      expectedIno = observed.success.ino
                    }

                    if (direct?.ino !== expectedIno) {
                      return yield* op.fail("VolumeBusy")
                    }
                  }

                  if (chosen.expectedChild === null) {
                    if (direct !== undefined) {
                      return yield* op.fail("StaleReference")
                    }
                  } else if (chosen.expectedChild !== undefined) {
                    const expectedChild = chosen.expectedChild
                    const observed = yield* referencedNode(expectedChild.reference, op)

                    if (
                      direct?.ino !== observed.ino || observed.revision !== expectedChild.revision ||
                      observed.metadata.atimeNs !== expectedChild.atimeNs ||
                      observed.metadata.mtimeNs !== expectedChild.mtimeNs
                    ) {
                      return yield* op.fail("StaleReference")
                    }
                  }

                  if (direct !== undefined && chosen.create === "exclusive") {
                    return yield* op.fail("AlreadyExists")
                  }

                  let file: Node | undefined = direct
                  let mutationParent = parent.ino
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

                      mutationParent = resolved.parent.ino
                      mutationName = resolved.name
                    }
                  }

                  const result = yield* openFile(
                    { parent: mutationParent, name: mutationName, trailingSlash: false, op },
                    file,
                    // A reference create always checks its size, even when none was given.
                    { ...chosen, initialSize: chosen.initialSize ?? 0n },
                    acquired,
                    op
                  )

                  opened(result.ino)

                  return {
                    handle: fileHandle(acquired),
                    reference: referenceFor(result.ino),
                    created: result.created,
                    directory: result.directory
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
              current().putQuiet({ ...node, metadata: { ...node.metadata, atimeNs: (yield* timestamp(op)) } })

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

                  if (replaced === undefined) yield* reserveEntry(pathOp)
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

                // Replacing a symbolic link frees its target bytes once this is its last link.
                yield* reserveBytes(pathOp, BigInt(size - previous) - BigInt(reclaimed))

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
                const d = current()

                // Content and size are assigned below on the shared path that also covers an existing file.
                const node = file ?? newFile(parent, Content.empty(), (chosen.mode ?? 0o666) & 0o777 & ~umask, now)

                const written: RegularFile = {
                  ...node,
                  data: Content.make(data),
                  metadata: {
                    ...node.metadata,
                    mode: finalMode ?? node.metadata.mode & ~SET_ID_BITS,
                    size: BigInt(size),
                    mtimeNs: now,
                    ctimeNs: now
                  }
                }

                d.usedBytes += BigInt(size - previous)

                if (file === undefined) {
                  // The replaced symlink loses its name; attaching under the same name keeps the entry's position.
                  if (replaced !== undefined) detach(replaced, parent.ino, name, now)

                  attach(directoryNow(parent.ino), name, written, now)

                  if (replaced === undefined) d.entries += 1
                  publishEntry(replaced === undefined ? "Create" : "Update", parent.ino, name)
                } else {
                  d.put(written)
                  publishNode(written.ino)
                }
              })
            )
          }
        ),
        chmod: Effect.fn("Caller.chmod")(function*(path: PathInput, mode: number, options?: MetadataOptions) {
          const op = OpContext.make("chmod")
          yield* changeMode(() => ResolvedNode.fromTarget(path, ownedOptions(options), op), mode, op)
        }),
        chmodHandle: Effect.fn("Caller.chmodHandle")(function*(handle: FileHandle | DirectoryHandle, mode: number) {
          const op = OpContext.make("chmod")
          yield* changeMode(() => ResolvedNode.fromTarget(handle, undefined, op), mode, op)
        }),
        chown: Effect.fn("Caller.chown")(function*(path: PathInput, owner: OwnerUpdate, options?: MetadataOptions) {
          const op = OpContext.make("chown")
          yield* changeOwner(() => ResolvedNode.fromTarget(path, ownedOptions(options), op), owner, op)
        }),
        chownHandle: Effect.fn("Caller.chownHandle")(
          function*(handle: FileHandle | DirectoryHandle, owner: OwnerUpdate) {
            const op = OpContext.make("chown")
            yield* changeOwner(() => ResolvedNode.fromTarget(handle, undefined, op), owner, op)
          }
        ),
        utimes: Effect.fn("Caller.utimes")(function*(path: PathInput, times: Times, options?: MetadataOptions) {
          const op = OpContext.make("utimes")
          yield* changeTimes(() => ResolvedNode.fromTarget(path, ownedOptions(options), op), times, op)
        }),
        utimesHandle: Effect.fn("Caller.utimesHandle")(function*(handle: FileHandle | DirectoryHandle, times: Times) {
          const op = OpContext.make("utimes")
          yield* changeTimes(() => ResolvedNode.fromTarget(handle, undefined, op), times, op)
        }),
        access: Effect.fn("Caller.access")(function*(input: PathInput, bits = 0, options?: RelativeOptions) {
          const op = OpContext.make("access")
          const prepared = preparePath(input, op.operation, settings.maxPathBytes)
          const base = options?.relativeTo

          if (!Number.isInteger(bits) || bits < 0 || bits > (READ | WRITE | EXECUTE)) {
            return yield* op.at(input).fail("InvalidArgument")
          }

          return yield* accessNode(() => ResolvedNode.fromPath(prepared, base, op), bits, op)
        }),
        truncate: Effect.fn("Caller.truncate")(function*(input: PathInput, length: bigint, options?: RelativeOptions) {
          const op = OpContext.make("truncate")
          const prepared = preparePath(input, op.operation, settings.maxPathBytes)
          const base = options?.relativeTo

          return yield* truncateNode(() => ResolvedNode.fromPath(prepared, base, op), length, op)
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

          return yield* acquireOpenedFile(
            acquired,
            op,
            (opened) =>
              Effect.gen(function*() {
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
                const file = resolved.node

                if (file !== undefined && chosen.create === "exclusive") {
                  return yield* pathOp.fail("AlreadyExists")
                }

                const result = yield* openFile(
                  { parent: parent.ino, name, trailingSlash: path.trailingSlash, op: pathOp },
                  file,
                  chosen,
                  acquired,
                  op
                )

                opened(result.ino)

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
              Effect.suspend(() => {
                const node = acquired.ino === undefined ? undefined : view(acquired.ino)

                return node === undefined
                  ? Effect.fail(statOp.fail("InvalidHandle"))
                  : Effect.succeed({ ...node.metadata })
              })
            ).pipe(Effect.withSpan("DirectoryHandle.stat")),
            close: coordinatedCleanup(Effect.suspend(() => {
              if (acquired.ino === undefined) {
                return Effect.fail(OpContext.make("close").fail("InvalidHandle"))
              }

              releaseDirectory(acquired)

              return Effect.void
            })).pipe(Effect.ensuring(closeReleasedScope(acquired)), Effect.withSpan("DirectoryHandle.close"))
          })

          handles.set(handle, acquired)

          return handle
        })
      })
    }

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
        const seams = yield* VolumeTestSeams

        return yield* admit(OpContext.make("watch"), watchHub.subscribe(seams.afterSubscribe))
      }).pipe(Effect.withSpan("Volume.watch")),
      snapshot: coordinatedRead(OpContext.make("snapshot"), Effect.suspend(() => captureSnapshot(state))).pipe(
        Effect.withSpan("Volume.snapshot")
      ),

      caller: Effect.fn("Volume.caller")(function*(options?: RootCallerOptions) {
        const decoded = yield* Effect.fromResult(
          decodeConfiguration(RootCallerOptions, options === undefined ? {} : options, "caller")
        )

        const chosen = decoded.identity ?? { uid: 0, gid: 0, groups: [], privileged: true }
        const identity = Object.freeze({ ...chosen, groups: Object.freeze([...chosen.groups]) })

        return yield* coordinatedRead(
          OpContext.make("caller"),
          Effect.sync(() =>
            createCaller(
              makeDirectoryReference(ROOT_INO),
              identity,
              decoded.umask ?? 0o022
            )
          )
        )
      })
    })

    // What an overlay layered on this volume compares against its base: the current value's entries, and a
    // snapshot with the entries observed from the same value.
    const observe = Object.freeze({
      changes: coordinatedRead(OpContext.make("changes"), Effect.suspend(() => observeChanges(state))),
      capture: coordinatedRead(OpContext.make("capture"), captureState())
    })

    return Object.freeze({ volume, shutdown, initialImage, observe })
  }
)

/** @internal */
export const make = Effect.fn("VirtualFileSystem.make")(function*(options?: VolumeOptions) {
  return (yield* makeVolume(VolumeSource.Empty(), options).pipe(
    Effect.catchIf((error) => Schema.is(VfsError)(error) && error.code !== "InvalidArgument", Effect.die)
  )).volume
})

/** @internal */
export const prepareEmptyLiveImage = Effect.fnUntraced(function*(options?: VolumeOptions) {
  const { initialImage } = yield* Effect.mapError(
    makeVolume(VolumeSource.Empty(), options, undefined, captureLiveImage),
    (error) => retargetFailure("prepareEmptyImage", error)
  )

  if (initialImage === undefined) return yield* imageFailure("openImage", "InvalidStructure", { field: "liveImage" })

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
  // The image prepared for the candidate the store is about to see; prepare and commit run in sequence under
  // every permit, so one slot carries it between them.
  let prepared: Uint8Array | undefined
  const identity = VolumeIdentity.make(document.identity)
  const commitOp = OpContext.make("commit")

  const limits: VolumeLimits = {
    maxEntries: document.limits.maxEntries,
    maxBytes: document.limits.maxBytes === undefined ? undefined : ByteSize.bytes(document.limits.maxBytes),
    maxFileBytes: document.limits.maxFileBytes === undefined
      ? ByteSize.bytes(MAX_FILE_BYTES)
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
                prepared = bytes
              })
          )
        ),
      commit: () =>
        Effect.suspend(() => {
          const bytes = prepared
          prepared = undefined

          return bytes === undefined ? Effect.succeed("unknown" as const) : commit(bytes)
        })
    },
    undefined,
    durability
  )

  if (shutdown === undefined) return yield* imageFailure("openImage", "InvalidStructure", { field: "liveImage" })

  return Object.freeze({ volume, shutdown })
})

/** @internal */
const publicChange = (change: RawOverlayChange): OverlayChange =>
  Predicate.isTagged("Renamed")(change)
    ? OverlayChange.make({ ...change, from: ownedPath(change.from), to: ownedPath(change.to) })
    : OverlayChange.make({ ...change, path: ownedPath(change.path) })

const publicChanges = (changes: ReadonlyArray<RawOverlayChange>): ReadonlyArray<OverlayChange> =>
  Object.freeze(changes.map(publicChange))

const changeOptions = (options?: OverlayChangesOptions) => {
  return Effect.fromResult(decodeConfiguration(OverlayChangesOptions, options === undefined ? {} : options, "changes"))
}

/** @internal */
// A volume of its own restored from an image: nothing it holds is shared with another volume.
/** @internal */
export const restoredSource = (image: Image.Document): VolumeSource =>
  VolumeSource.Restored({
    image,
    restore: (initialTime) =>
      Effect.map(restoreImage(image, initialTime), (restored) => ({
        ...restored,
        open: new Map(),
        revision: 1n,
        entries: 0,
        usedBytes: 0n
      }))
  })

/** @internal */
export const fromSnapshot = Effect.fn("VirtualFileSystem.fromSnapshot")(
  function*(snapshot: Snapshot, options?: VolumeOptions) {
    return (yield* makeVolume(restoredSource(yield* Image.inspect(snapshot)), options)).volume
  },
  Effect.mapError((error) => retargetFailure("fromSnapshot", error))
)

// An overlay is a volume started from its base's restored value, plus a fold of that value against the current one.
/** @internal */
export const makeOverlay = Effect.fn("VirtualFileSystem.makeOverlay")(
  function*(base: Snapshot, options?: VolumeOptions) {
    const image = yield* Image.inspect(base)
    let baseState: VolumeState | undefined

    const source = VolumeSource.Restored({
      image,
      restore: (initialTime) =>
        Effect.tap(baseStateFor(base, image, initialTime), (value) =>
          Effect.sync(() => {
            baseState = value
          }))
    })

    const made = yield* Effect.mapError(makeVolume(source, options), (error) => retargetFailure("makeOverlay", error))

    if (baseState === undefined) return yield* imageFailure("makeOverlay", "InvalidStructure", { field: "snapshot" })
    const baseObservation = yield* observeChanges(baseState)

    const overlay: OverlayVolume = Object.freeze({
      ...made.volume,
      changes: Effect.fn("OverlayVolume.changes")(function*(options?: OverlayChangesOptions) {
        const selected = yield* changeOptions(options)
        const current = yield* made.observe.changes

        return publicChanges(compareOverlay(baseObservation, current, selected.includeTimestamps ?? false))
      }),
      capture: Effect.fn("OverlayVolume.capture")(function*(options?: OverlayChangesOptions) {
        const selected = yield* changeOptions(options)
        const current = yield* made.observe.capture

        return Object.freeze({
          snapshot: current.snapshot,
          changes: publicChanges(
            compareOverlay(baseObservation, current.observation, selected.includeTimestamps ?? false)
          )
        })
      })
    })

    return overlay
  }
)
