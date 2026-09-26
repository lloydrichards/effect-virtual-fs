// Runtime definitions and cohesive live virtual filesystem engine.
import * as ByteSize from "effect/ByteSize"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Random from "effect/Random"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import { BytePath } from "../BytePath.js"
import {
  CallerId,
  type Identity,
  MkdirOptions,
  ObjectReferenceId,
  OpenEntryOptions,
  OpenOptions,
  RemoveOptions,
  RootCallerOptions,
  SetattrOptions,
  SymlinkOptions,
  WalkOptions,
  WriteFileOptions
} from "../Caller.js"
import { DirectoryHandleId, FileHandleId, SeekMode } from "../FileHandle.js"
import { type Metadata, Mode, OwnerUpdate, Times, type TimeUpdate } from "../Metadata.js"
import type { Snapshot } from "../Snapshot.js"
import { type Entry, type EntryInput, isEntry, isTarget, type NameInput, Target, type TargetInput } from "../Target.js"
import { type FsFailure, type ImageFailure, make as makeError } from "../VfsError.js"
import type {
  Caller,
  Change,
  DirectoryHandle,
  FileHandle,
  ObjectReference,
  OverlayVolume,
  PathInput,
  Volume,
  VolumeLimits,
  VolumeUsage,
  WalkEntry,
  WalkFailure
} from "../VirtualFileSystem.js"
import {
  OverlayChange,
  OverlayChangesOptions,
  ReferenceKey,
  type VolumeDurability,
  VolumeId,
  VolumeIdentity,
  VolumeIncarnation,
  VolumeOptions
} from "../Volume.js"
import { WatchOptions } from "../Watch.js"
import { sameBytes } from "./bytes.js"
import {
  argumentFailure,
  decodeConfiguration,
  errorPath,
  fsFailure,
  imageFailure,
  OpContext,
  retargetFailure,
  VfsError
} from "./errors.js"
import { KeySecret, VolumeEpoch } from "./hex128.js"
import { hmacSha256, sameTag } from "./hmac.js"
import * as Image from "./image.js"
import * as InodeTable from "./inodeTable.js"
import * as LiveImage from "./liveImage.js"
import * as MetadataDomain from "./metadata.js"
import { compareOverlay, type ObservationEntry, type RawOverlayChange } from "./overlayDiff.js"
import {
  DOT_DOT_HEX,
  DOT_HEX,
  inputBytes,
  isAttachedBytes,
  isDotComponent,
  isWellFormed,
  joinPath,
  MAX_NAME_BYTES,
  MAX_SYMLINK_TRAVERSALS,
  nameBytes,
  ownedPath,
  type PreparedPath,
  preparePath,
  ROOT_PATH,
  SLASH_BYTE,
  SLASH_HEX
} from "./path.js"
import { type CommitProvider, offerCommit } from "./stagedState.js"
import { VolumeTestSeams } from "./testSeams.js"
import { makeTurnstile } from "./turnstile.js"
import {
  type Directory,
  directoryMetadata,
  emptyRoot,
  getNode,
  Ino,
  type Link,
  MAX_FILE_BYTES,
  type Node,
  type NodeMetadata,
  reachableValue,
  type RegularFile,
  ROOT_INO,
  storedMetadata,
  type SymbolicLink,
  type VolumeState,
  WALK_YIELD_INTERVAL
} from "./volumeState.js"
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

// relatime, as Linux mounts by default: a read refreshes an access time at least this old, 24 hours.
const RELATIME_INTERVAL_NS = 86_400_000_000_000n

// Options for a single path walk; `lookup` is defined per volume, so this lives at module level.
interface LookupOptions {
  readonly followFinalSymlink?: boolean
  readonly allowMissing?: boolean
  readonly parentOnly?: boolean
  // Creates a missing directory the path names, for a recursive mkdir; `final` says the name ends the path.
  readonly createMissing?: (parent: Directory, name: string, final: boolean) => Effect.Effect<Directory, FsFailure>
}

// Entries a caller's walk hands on per pull. Reading a directory ends a pull early, so each pull holds at most one
// permit once.
const WALK_CHUNK_ENTRIES = 128

// Largest signed 64-bit file offset, as POSIX off_t.
const MAX_FILE_OFFSET = 0x7fffffffffffffffn

const isMode = Schema.is(Mode)

const isNatural = Schema.is(Schema.Natural)

// A length arrives typed, but a caller outside TypeScript can pass anything. The published setattr schema
// bounds it, so truncate and setattr agree with it.
const isLength = Schema.is(SetattrOptions.fields.size.schema)

const inGroup = (identity: Identity, gid: number) => identity.gid === gid || identity.groups.includes(gid)

const isTimestamp = Schema.is(MetadataDomain.Timestamp)

const isSeekMode = Schema.is(SeekMode)

const decodeOwnerUpdate = Schema.decodeEffect(OwnerUpdate, { onExcessProperty: "error" })

const decodeTimes = Schema.decodeEffect(Times, { onExcessProperty: "error" })

const decodeExpected = Schema.decodeEffect(SetattrOptions.fields.expected.schema, { onExcessProperty: "error" })

const SETATTR_FIELDS: ReadonlyArray<string> = Object.keys(SetattrOptions.fields)

// The validated attributes one change applies; an undefined attribute keeps its value.
type Attributes = { readonly [K in keyof SetattrOptions]?: SetattrOptions[K] | undefined }

// A time after one update: the current value when omitted, the clock when "now", or the explicit value.
const timeAt = (update: TimeUpdate | undefined, value: bigint, now: bigint) =>
  update === undefined || update.kind === "omit" ? value : update.kind === "now" ? now : update.nanoseconds

const decodeWriteFileOptions = Schema.decodeEffect(WriteFileOptions, { onExcessProperty: "error" })

const decodeOpenOptions = Schema.decodeEffect(OpenOptions, { onExcessProperty: "error" })

const decodeMkdirOptions = Schema.decodeEffect(MkdirOptions, { onExcessProperty: "error" })

const decodeSymlinkOptions = Schema.decodeEffect(SymlinkOptions, { onExcessProperty: "error" })

const decodeWalkOptions = Schema.decodeEffect(WalkOptions, { onExcessProperty: "error" })

const decodeRemoveOptions = Schema.decodeEffect(RemoveOptions, { onExcessProperty: "error" })

const decodeOpenEntryOptions = Schema.decodeEffect(OpenEntryOptions, { onExcessProperty: "error" })

const encoder = new TextEncoder()

// What opening or creating a resolved entry needs; a path open supplies only the OpenSettings fields.
type OpenRequest = Omit<OpenEntryOptions, "append" | "followFinalSymlink" | "expectedChild" | "expected">

// Whether a read at `now` refreshes a node's access time: when it is not newer than the last modification or
// status change, or when it is at least a day old. A time already equal to `now` is never refreshed, as Linux
// skips it, so reads at one instant (a frozen or coarse clock) store nothing.
const accessDue = (metadata: NodeMetadata, now: bigint) =>
  now !== metadata.atimeNs && (
    metadata.atimeNs <= metadata.mtimeNs || metadata.atimeNs <= metadata.ctimeNs ||
    now - metadata.atimeNs >= RELATIME_INTERVAL_NS
  )

interface Access {
  readonly node: Node
  readonly now: bigint
}

// A read's result with the node it accessed and the time it read, or none when the read touches no access time.
interface Accessed<A> {
  readonly value: A
  readonly access: Access | undefined
}

// Whether a read's access time is due under relatime; the one rule both the observation and the change apply.
const refreshDue = <A>(read: Accessed<A>): read is Accessed<A> & { readonly access: Access } =>
  read.access !== undefined && accessDue(read.access.node.metadata, read.access.now)

// An entry a caller's walk has reached. `path` is relative to the walk's root; `listed` marks a directory a
// post-order walk has read and still has to report.
interface WalkFrame {
  readonly ino: Ino
  readonly kind: Node["kind"]
  readonly name: Uint8Array
  // The name as the directory keys it.
  readonly key: string
  readonly path: Uint8Array
  readonly parent: Ino
  // The frame of the directory it was listed in: the root's anchor for a child of a root reached by name, and
  // absent for a child of a root held by what it resolved to.
  readonly up: WalkFrame | undefined
  readonly depth: number
  // What the entry counts toward a walk's byte bound: a file's size or a link's target length.
  readonly bytes: bigint
  readonly reference: ObjectReference
  readonly directory: ObjectReference
  readonly listed: boolean
}

// The bounds and order of a walk, decoded.
interface WalkPlan {
  readonly order: "pre" | "post"
  readonly maxDepth: number | undefined
  readonly maxEntries: number | undefined
  readonly maxBytes: bigint | undefined
}

// The namespace entry a path or a directory reference plus name resolves to, so each verb has one body. A
// path's final component can be absent or a dot and can carry a trailing slash; a reference name never does,
// so a body's checks for those cases never fire on references.
interface ResolvedEntry {
  readonly parent: Ino
  readonly name: string | undefined
  readonly trailingSlash: boolean
  // A path names ".", ".." and existing names with the POSIX code of its verb; an entry reports a reserved name
  // as an invalid argument.
  readonly addressing: "path" | "entry"
  // Names the path on path-addressed entries; the method's own context on entry-addressed ones.
  readonly op: OpContext
}

// The node a path, handle, or object reference resolves to, so each node-addressed verb has one body.
interface ResolvedNode {
  readonly ino: Ino
  // Names the path on path-addressed nodes; the method's own context on handles and references.
  readonly op: OpContext
}

interface RestoredVolumeOptions {
  identity: VolumeIdentity
  maxEntries?: number
  maxBytes?: ByteSize.ByteSize
  maxFileBytes?: ByteSize.ByteSize
  maxPathBytes?: ByteSize.ByteSize
}

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
  readonly events: Array<(installed: VolumeState) => Iterable<WatchEvent>> = []
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

  // Whether the next value would equal the base, so there is nothing to commit.
  get unchanged(): boolean {
    return this.pending.size === 0 && this.opens === undefined && this.nextInode === this.base.nextInode &&
      this.entries === this.base.entries && this.usedBytes === this.base.usedBytes
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

const isFileHandle = (value: FileHandle | DirectoryHandle): value is FileHandle =>
  Predicate.hasProperty(FileHandleId)(value)

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

const withMetadata = (node: Node): Metadata => ({ ...node.metadata, revision: node.revision })

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
  // A reopened live image's value, identity and limits.
  | { readonly _tag: "Live"; readonly restored: LiveImage.Restored }
  // A snapshot's value, which the volume starts from once its limits have accepted it.
  | { readonly _tag: "Restored"; readonly value: VolumeState }

/** @internal */
export const VolumeSource = Data.taggedEnum<VolumeSource>()

const UpdateChange = Schema.TaggedStruct("Update", { path: BytePath })

const RescanChange = Schema.TaggedStruct("Rescan", { path: BytePath })

const RemoveChange = Schema.TaggedStruct("Remove", { path: BytePath })

// A change and where it happened: the directory holding the entry it names and the object behind that entry. A
// scoped watch tests these against the installed tree, so renaming its scope or an ancestor does not lose it.
interface WatchEvent {
  readonly change: Change
  readonly parent: Ino
  readonly ino: Ino
}

// The volume's values either side of one installation.
interface Installation {
  readonly before: VolumeState
  readonly after: VolumeState
}

// Every object's path, kind, content and stored metadata: what an overlay compares against its base. An overlay
// starts from its base's value, and inode numbers are never reused, so an inode's number is its lineage.
const observeChanges = Effect.fnUntraced(function*(captured: VolumeState) {
  const observation: Array<ObservationEntry> = []
  const paths: Array<readonly [Ino, Uint8Array]> = [[ROOT_INO, ROOT_PATH]]

  for (let index = 0; index < paths.length; index++) {
    if (index % WALK_YIELD_INTERVAL === 0) yield* Effect.yieldNow
    const entry = paths[index]

    if (entry === undefined) continue
    const [ino, path] = entry
    const node = getNode(captured, ino)

    if (node === undefined) continue
    observation.push({
      path: new Uint8Array(path),
      lineage: String(node.ino),
      kind: node.kind,
      content: node.kind === "file" ? node.data : node.kind === "symlink" ? node.target : undefined,
      metadata: storedMetadata(node.metadata)
    })

    if (node.kind !== "directory") continue

    for (const [name, child] of node.entries) paths.push([child, joinPath(path, nameBytes(name))])
  }

  return observation
})

// Each execution constructs a fresh volume and captures its Clock.

// 128 bits as lowercase hex. A platform Crypto service supplies them when one is in context; otherwise Effect's
// Random does, in four 32-bit draws, so a constructor needs no service and a test can seed its identities.
const randomHex128: Effect.Effect<string> = Effect.gen(function*() {
  const crypto = yield* Effect.serviceOption(Crypto.Crypto)

  if (Option.isSome(crypto)) return Encoding.encodeHex(yield* Effect.orDie(crypto.value.randomBytes(16)))

  let hex = ""

  for (let draw = 0; draw < 4; draw++) {
    hex += (yield* Random.nextIntBetween(0, 0x100000000, { halfOpen: true })).toString(16).padStart(8, "0")
  }

  return hex
})

// The 128-bit secret behind every key's tag, always from the platform's cryptographically secure generator. Unlike an
// identity or an epoch it must not follow a seedable Random: every key hands out the identity and epoch, so a
// reproducible secret would let one key forge the tag of any other inode. Web Crypto is global in every supported
// runtime, so reading it adds no service requirement; a runtime without it is a defect, not a recoverable failure.
const randomKeySecret: Effect.Effect<string> = Effect.sync(() => {
  // The DOM types declare the global, but a runtime without Web Crypto leaves it undefined.
  const webCrypto: typeof globalThis.crypto | undefined = globalThis.crypto

  if (webCrypto === undefined) {
    throw new Error("globalThis.crypto is unavailable, so a volume cannot draw its reference-key secret")
  }

  return Encoding.encodeHex(webCrypto.getRandomValues(new Uint8Array(16)))
})

/** @internal */
export const makeVolume = Effect.fnUntraced(
  function*(
    source: VolumeSource,
    options?: VolumeOptions,
    commitProvider?: CommitProvider<VolumeState>,
    captureInitial?: (
      state: VolumeState,
      naming: LiveImage.Naming,
      limits: VolumeLimits
    ) => Effect.Effect<Uint8Array, ImageFailure>,
    durability: VolumeDurability = "memory-only"
  ) {
    const live = Predicate.isTagged("Live")(source) ? source.restored : undefined
    let restoredOptions = options

    if (live !== undefined) {
      const recovered: RestoredVolumeOptions = { identity: live.identity }

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

    const identity = settings.identity === undefined
      ? VolumeIdentity.make(yield* randomHex128)
      : VolumeIdentity.make(settings.identity)

    const incarnation = VolumeIncarnation.make(yield* randomHex128)
    // The namespace this volume's inode numbers belong to. It starts over with the numbers, so every construction
    // mints one except a live reopen, which resumes the numbers it persisted. An overlay or a restore keeps its
    // source's numbers but may share its identity, so a fresh epoch is what keeps an older key from resolving there.
    const epoch = live === undefined ? VolumeEpoch.make(yield* randomHex128) : live.epoch
    // The secret behind every key's tag. It is drawn and resumed with the epoch, so a new numbering gets a new one,
    // but never from Random, so a seed that reproduces the identity and epoch cannot reproduce it.
    const keySecret = live === undefined ? KeySecret.make(yield* randomKeySecret) : live.keySecret
    const identityBytes = Result.getOrThrow(Encoding.decodeHex(identity))
    const epochBytes = Result.getOrThrow(Encoding.decodeHex(epoch))
    const keySecretBytes = Result.getOrThrow(Encoding.decodeHex(keySecret))
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

    const root = emptyRoot(initialTime)

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
      const restored = yield* reachableValue(source.value)

      if (restored.largestFile > maxFileBytes) {
        return yield* imageFailure("snapshot", "LimitExceeded", { field: "maxFileBytes" })
      }

      if (
        (settings.maxEntries !== undefined && restored.state.entries > settings.maxEntries) ||
        (settings.maxBytes !== undefined && restored.state.usedBytes > ByteSize.toBigInt(settings.maxBytes))
      ) {
        return yield* imageFailure("snapshot", "LimitExceeded", { field: "volume" })
      }

      state = restored.state
    }

    if (live !== undefined) state = live.value

    const initialImage = captureInitial === undefined
      ? undefined
      : yield* captureInitial(state, { identity, epoch, keySecret }, limits)

    // The running transition's draft; reads inside a transition see its pending writes.
    let draft: Draft | undefined

    const view = (ino: Ino): Node | undefined => draft === undefined ? getNode(state, ino) : draft.get(ino)

    // False once storage's answer about a candidate cannot be relied on; every later operation is refused.
    let available = true

    const checkAvailable = (operation: string) =>
      Effect.suspend(() => available ? Effect.void : Effect.fail(fsFailure("VolumeUnavailable", operation)))

    const watchCoordinate: WatchHub.Coordinator = (effect) => changing(effect)

    const watchHub = yield* WatchHub.make<WatchEvent, Installation, FsFailure>(
      watchCoordinate,
      settings.maxWatchEvents ?? 256
    )

    // Installs a finished draft: the only place the volume's value changes, and where its events publish.
    const install = (finished: Draft) => {
      const before = state
      state = finished.finish()

      for (const ino of finished.removed) tokens.delete(ino)

      for (const apply of finished.after) apply()

      const after = state

      watchHub.publishUnsafe(() => finished.events.flatMap((events) => Array.from(events(after))), { before, after })
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
      // A change that changes nothing, such as a read whose access time another read refreshed first, offers
      // nothing; its handle writes and events still apply.
      if (finished.unchanged) return install(finished)
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

    // Refreshes the access time a read reports, when relatime says it is due.
    const refreshAccess = <A>(read: Accessed<A>): A => {
      if (refreshDue(read)) {
        const { node, now } = read.access
        current().putQuiet({ ...node, metadata: { ...node.metadata, atimeNs: now } })
      }

      return read.value
    }

    // A read that may refresh an access time. It observes under one permit, so reads run beside each other, and
    // only when the access time is due does it run again as a change. The change repeats every check and the rule,
    // since another read may have refreshed the time meanwhile, and its result is the one returned.
    const accessing = <A, E, R>(op: OpContext, read: Effect.Effect<Accessed<A>, E, R>) =>
      Effect.flatMap(
        coordinatedRead(op, read),
        (observed) =>
          refreshDue(observed)
            ? coordinated(op, Effect.map(read, refreshAccess))
            : Effect.succeed(observed.value)
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

    // Events name their paths against the installed value, and only once a watcher takes them. `ino` is the object
    // the entry names, or named until this change removed it.
    const publishEntry = (_tag: Exclude<Change["_tag"], "Rescan">, parent: Ino, name: string, ino: Ino) => {
      current().events.push((installed) => {
        const prefix = pathOf((at) => getNode(installed, at), parent)

        return prefix === undefined ? [] : [{ change: { _tag, path: entryPath(prefix, name) }, parent, ino }]
      })
    }

    const publishNode = (ino: Ino) => {
      const target = current().get(ino)

      if (target === undefined) return

      if (target.kind === "directory") {
        current().events.push((installed) => {
          const directory = getNode(installed, ino)
          const path = pathOf((at) => getNode(installed, at), ino)

          return path === undefined || directory?.kind !== "directory"
            ? []
            : [{ change: UpdateChange.make({ path: ownedPath(nameBytes(path)) }), parent: directory.parent, ino }]
        })

        return
      }

      // The names bound now: a later transition may rename them, but this one published these.
      const links = target.links

      current().events.push((installed) => {
        const events: Array<WatchEvent> = []

        for (const link of links) {
          const prefix = pathOf((at) => getNode(installed, at), link.parent)

          if (prefix !== undefined) {
            events.push({
              change: UpdateChange.make({ path: entryPath(prefix, link.name) }),
              parent: link.parent,
              ino
            })
          }
        }

        return events
      })
    }

    // The paths that reach an object: a directory's one path, or every name of anything else.
    const pathsOf = (installed: VolumeState, ino: Ino): Array<BytePath> => {
      const node = getNode(installed, ino)

      if (node === undefined) return []

      if (node.kind === "directory") {
        const path = pathOf((at) => getNode(installed, at), ino)

        return path === undefined ? [] : [ownedPath(nameBytes(path))]
      }

      const paths: Array<BytePath> = []

      for (const link of node.links) {
        const prefix = pathOf((at) => getNode(installed, at), link.parent)

        if (prefix !== undefined) paths.push(entryPath(prefix, link.name))
      }

      return paths
    }

    // Whether a directory is `ancestor` or lies below it. Directories have one name each, so the walk up is the
    // directory's only path.
    const descends = (installed: VolumeState, directory: Ino, ancestor: Ino): boolean => {
      for (let at = directory;;) {
        if (at === ancestor) return true

        if (at === ROOT_INO) return false
        const node = getNode(installed, at)

        if (node?.kind !== "directory") return false
        at = node.parent
      }
    }

    const rootPath = () => ownedPath(new Uint8Array([SLASH_BYTE]))

    const volumeSelection: WatchHub.Selection<WatchEvent, Installation> = {
      includes: () => true,
      rescan: () => ({ change: RescanChange.make({ path: rootPath() }), parent: ROOT_INO, ino: ROOT_INO })
    }

    // The inode a watch scope names. An object whose last name is gone has nothing left to watch.
    const scopeRoot = (scope: ObjectReference, op: OpContext) =>
      Effect.suspend(() => {
        const known = objectReferences.get(scope)

        if (known === undefined) return Effect.fail(op.fail("InvalidReference"))

        if (known.volume !== volumeIdentity) return Effect.fail(op.fail("ForeignReference"))
        const node = getNode(state, known.ino)

        return node === undefined || node.metadata.nlink === 0
          ? Effect.fail(op.fail("StaleReference"))
          : Effect.succeed(known.ino)
      })

    // A watch of one object, and of its subtree when recursive. Membership is read from the installed tree when
    // each event is offered, so it follows renames of the scope and its ancestors. When the object's last name is
    // gone the watch reports its removal from the names it had and ends; that Remove is held back for the end of
    // the publication, so it is reported even where the queue would have given its slot to a Rescan.
    const scopedSelection = (root: Ino, recursive: boolean): WatchHub.Selection<WatchEvent, Installation> => {
      const gone = (installed: VolumeState) => {
        const node = getNode(installed, root)

        return node === undefined || node.metadata.nlink === 0
      }

      return {
        includes: (event, { after }) => {
          if (event.ino === root) return !(Predicate.isTagged(event.change, "Remove") && gone(after))

          return recursive ? descends(after, event.parent, root) : event.parent === root
        },
        rescan: ({ before, after }) => ({
          change: RescanChange.make({ path: pathsOf(after, root)[0] ?? pathsOf(before, root)[0] ?? rootPath() }),
          parent: root,
          ino: root
        }),
        settle: ({ before, after }) =>
          gone(after)
            ? pathsOf(before, root).map((path) => ({ change: RemoveChange.make({ path }), parent: root, ino: root }))
            : undefined
      }
    }

    const captureState = Effect.fnUntraced(function*() {
      const captured = state
      const snapshot = Image.make(captured)

      yield* (yield* VolumeTestSeams).betweenSnapshotAndSummary

      return { snapshot, observation: yield* observeChanges(captured) }
    })

    // Whether a reference to the inode still resolves: it is in the table and, if a directory, still has its name.
    // An unlinked file stays addressable while a handle holds it.
    const addressable = (ino: Ino): boolean => {
      const node = getNode(state, ino)

      return node !== undefined && !(node.kind === "directory" && node.metadata.nlink === 0)
    }

    // The key's tag: HMAC-SHA-256 over identity, epoch and the inode number as 64 bits big-endian, cut to 16 bytes.
    const keyTag = (ino: bigint): Uint8Array => {
      const message = new Uint8Array(40)
      message.set(identityBytes)
      message.set(epochBytes, 16)
      new DataView(message.buffer).setBigUint64(32, ino)

      return hmacSha256(keySecretBytes, message).subarray(0, 16)
    }

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

    // The permission bits the node's mode grants this identity's class.
    const permitted = (node: Node, identity: Identity) => {
      const metadata = node.metadata

      const shift = metadata.uid === identity.uid ?
        6
        : inGroup(identity, metadata.gid)
        ? 3
        : 0

      return (metadata.mode >> shift) & (READ | WRITE | EXECUTE)
    }

    const authorize = (node: Node, identity: Identity, bits: number, op: OpContext) =>
      identity.privileged || (permitted(node, identity) & bits) === bits
        ? Effect.void
        : Effect.fail(op.fail("AccessDenied"))

    // An inode no name reaches leaves the table once nothing holds it open; a file's bytes are released then.
    const reclaim = (d: Draft, ino: Ino) => {
      const node = d.get(ino)

      if (node === undefined) return

      if (node.kind === "file") {
        if (node.links.length > 0 || d.openCount(ino) > 0) return
        d.usedBytes -= BigInt(node.data.length)
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

    // A replacement keeps the entry count but still takes a new inode.
    const reserveInode = (op: OpContext) => current().canAllocate ? Effect.void : Effect.fail(op.fail("NoSpace"))

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
      d.usedBytes += BigInt(data.length - file.data.length)
      d.put({
        ...file,
        data,
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

    // Sets a file's length at a time the caller read, leaving its event to the caller.
    const resizeAt = Effect.fnUntraced(function*(file: RegularFile, length: bigint, now: bigint, op: OpContext) {
      if (length > BigInt(maxFileBytes)) return yield* op.fail("FileTooLarge")
      const size = Number(length)

      yield* reserveBytes(op, BigInt(size - file.data.length))

      const data = new Uint8Array(size)
      data.set(file.data.subarray(0, size))
      replaceContent(file, data, now, false)
    })

    const resize = Effect.fnUntraced(function*(file: RegularFile, length: bigint, op: OpContext) {
      if (!isLength(length)) return yield* op.fail("InvalidArgument")

      yield* resizeAt(file, length, yield* timestamp(op), op)
      publishNode(file.ino)
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

        const body = Effect.gen(function*() {
          const file = yield* get(op, "read")

          if (!isNatural(maximum)) return yield* readOp.fail("InvalidArgument")
          const offset = position ?? ref.offset

          if (!Predicate.isBigInt(offset) || offset < 0n || offset > MAX_FILE_OFFSET) {
            return yield* readOp.fail("InvalidArgument")
          }

          const start = Number(offset > file.metadata.size ? file.metadata.size : offset)
          const data = file.data.slice(start, start + Math.min(maximum, file.data.length - start))
          const eof = start + data.length >= file.data.length

          const access = maximum > 0 ? { node: file, now: yield* timestamp(readOp) } : undefined

          return { value: { bytes: data, eof, next: offset + BigInt(data.length) }, access }
        })

        // A positioned read runs beside other reads. A cursor read stays a change, since two reads beside each
        // other would start at the same offset.
        if (position !== undefined) return Effect.map(accessing(op, body), ({ bytes, eof }) => ({ bytes, eof }))

        return coordinated(
          op,
          Effect.map(body, (read) => {
            const { bytes, eof, next } = refreshAccess(read)
            current().after.push(() => {
              ref.offset = next
            })

            return { bytes, eof }
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

            const maximumEnd = BigInt(file.data.length) + free
            const end = Number(BigInt(maxFileBytes) < maximumEnd ? BigInt(maxFileBytes) : maximumEnd)
            const count = Math.min(bytes.length, Math.max(0, end - start))

            if (count === 0) return yield* writeOp.fail("NoSpace")
            const size = Math.max(file.data.length, start + count)
            // Always detach before mutation. A same-sized write is the critical
            // case: the current payload may belong to the base or a prior capture.
            const data = new Uint8Array(size)
            data.set(file.data)
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
          return (yield* read(maximum)).bytes
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
          Effect.map(Effect.suspend(() => get(statOp)), withMetadata)
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
        data: RegularFile["data"],
        mode: number,
        now: bigint,
        owner?: OwnerUpdate,
        times?: Times
      ): RegularFile => {
        const ino = current().allocate()

        return {
          kind: "file",
          ino,
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
            size: BigInt(data.length),
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
        const { allowMissing = false, createMissing, followFinalSymlink = true, parentOnly = false } = options

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
        // Leading components that came from a symbolic link's target. Only the components the caller wrote are
        // created, so a dangling link stays missing, as it does for mkdir -p.
        let linked = 0

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
            if (allowMissing && index === work.components.length - 1) {
              return { node: undefined, parent, name }
            }

            if (createMissing !== undefined && index >= linked) {
              current = yield* createMissing(current, component, index === work.components.length - 1)
              continue
            }

            return yield* pathOp.fail("NotFound")
          }

          if (
            child.kind === "symlink" && (followFinalSymlink || index < work.components.length - 1 || work.trailingSlash)
          ) {
            if (child.target.length === 0) {
              return yield* pathOp.fail("NotFound")
            }

            if (++traversals > MAX_SYMLINK_TRAVERSALS) {
              return yield* pathOp.fail("SymlinkLoop")
            }

            const suffix = work.suffixes[index] ?? new Uint8Array(0)
            const remaining = work.components.length - index - 1

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
            linked = work.components.length - remaining + Math.max(0, linked - index - 1)

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
            addressing: "path" as const,
            op: op.at(path.input)
          } satisfies ResolvedEntry
        })
      }

      // The mode an owner may set: an unprivileged caller outside the file's group cannot set setgid on it.
      const grantedMode = (metadata: Pick<Metadata, "kind" | "gid">, mode: number) =>
        !identity.privileged && metadata.kind === "file" && !inGroup(identity, metadata.gid) ? mode & ~0o2000 : mode

      const permittedMode = (metadata: Pick<Metadata, "kind" | "uid" | "gid">, mode: number, op: OpContext) =>
        !identity.privileged && identity.uid !== metadata.uid
          ? Effect.fail(op.fail("NotPermitted"))
          : Effect.succeed(grantedMode(metadata, mode))

      // Changes the attributes one change at a time would, as one change: one draft, one revision, one event.
      // Every check runs against the node before any attribute applies, ownership (NotPermitted) before
      // permission (AccessDenied), so the first failure leaves everything unchanged. The attributes apply as
      // size, owner, mode, then times, the POSIX composition of chown then chmod, so a requested mode wins over
      // the set-ID clearing that a resize or an owner change triggers; an adapter owns any protocol-specific
      // sanitising of the mode, as NFS SETATTR does after knfsd. The attributes arrive validated; an owner with
      // neither id still checks ownership, and times that omit both are no change and check nothing. An expected
      // revision is checked first, against the target as the change finds it, so a caller that decided the
      // attributes from an earlier observation learns the target moved instead of applying them to a newer state.
      const changeAttributes = (
        resolve: () => Effect.Effect<ResolvedNode, FsFailure>,
        attributes: Attributes,
        op: OpContext
      ) => {
        const { size, mode } = attributes
        const expected = attributes.expected?.revision
        // Copied now: the change runs after the permit wait, and the caller may reuse its objects meanwhile.
        const owner = attributes.owner === undefined ? undefined : { ...attributes.owner }

        const times = attributes.times === undefined
          ? undefined
          : { access: { ...attributes.times.access }, modification: { ...attributes.times.modification } }

        const timed = times !== undefined && (times.access.kind !== "omit" || times.modification.kind !== "omit")
        const bothNow = times?.access.kind === "now" && times.modification.kind === "now"
        const resolving = resolve()

        return coordinated(
          op,
          Effect.gen(function*() {
            const resolved = yield* resolving
            const node = nodeNow(resolved.ino)

            if (expected !== undefined && node.revision !== expected) {
              return yield* resolved.op.fail("StaleReference", { field: "expected" })
            }

            if (size !== undefined && node.kind === "symlink") return yield* resolved.op.fail("SymlinkLoop")

            if (size !== undefined && node.kind !== "file") return yield* resolved.op.fail("IsDirectory")
            const owns = identity.privileged || identity.uid === node.metadata.uid

            if (
              (mode !== undefined && !owns) ||
              (owner !== undefined && !identity.privileged && (!owns ||
                (owner.uid !== undefined && owner.uid !== node.metadata.uid) ||
                (owner.gid !== undefined && !inGroup(identity, owner.gid)))) ||
              // POSIX grants write access only when both times are UTIME_NOW; every other combination that
              // changes a time, mixed ones included, needs ownership.
              (timed && !owns && !bothNow)
            ) {
              return yield* resolved.op.fail("NotPermitted")
            }

            if (size !== undefined || (timed && !owns)) yield* authorize(node, identity, WRITE, resolved.op)
            const chowned = owner?.uid !== undefined || owner?.gid !== undefined

            if (size === undefined && !chowned && mode === undefined && !timed) return
            const now = yield* timestamp(op)

            if (size !== undefined && node.kind === "file") yield* resizeAt(node, size, now, op)
            const sized = nodeNow(resolved.ino)
            const gid = owner?.gid ?? sized.metadata.gid
            const cleared = chowned && sized.kind === "file" ? sized.metadata.mode & ~SET_ID_BITS : sized.metadata.mode

            if (chowned || mode !== undefined || timed) {
              current().put({
                ...sized,
                metadata: {
                  ...sized.metadata,
                  uid: owner?.uid ?? sized.metadata.uid,
                  gid,
                  mode: mode === undefined ? cleared : grantedMode({ kind: sized.kind, gid }, mode),
                  atimeNs: timeAt(times?.access, sized.metadata.atimeNs, now),
                  mtimeNs: timeAt(times?.modification, sized.metadata.mtimeNs, now),
                  ctimeNs: now
                }
              })
            }

            publishNode(node.ino)
          })
        )
      }

      const authorizeRemoval = (parent: Directory, child: Node, op: OpContext) =>
        (parent.metadata.mode & STICKY_BIT) !== 0 && !identity.privileged &&
          identity.uid !== parent.metadata.uid && identity.uid !== child.metadata.uid
          ? Effect.fail(op.fail("NotPermitted"))
          : Effect.void

      // Authorizes creating the entry and returns its name. Only a path can name a dot entry, and one always
      // exists, so it fails as AlreadyExists.
      // Follows Linux's order: search permission on the directory before the name is looked up, so a directory
      // the caller cannot search reveals nothing about its names; then a reserved or taken name, and a trailing
      // slash on a name that cannot be a directory, before write permission.
      const claimName = Effect.fnUntraced(function*(
        entry: ResolvedEntry,
        trailingSlash: "allowed" | "rejected" = "allowed"
      ) {
        const parent = directoryNow(entry.parent)

        if (isDotComponent(entry.name)) {
          return yield* entry.op.fail(entry.addressing === "entry" ? "InvalidArgument" : "AlreadyExists")
        }

        yield* authorize(parent, identity, EXECUTE, entry.op)

        if (parent.entries.has(entry.name)) return yield* entry.op.fail("AlreadyExists")

        // A trailing slash asks for a directory that does not exist.
        if (trailingSlash === "rejected" && entry.trailingSlash) return yield* entry.op.fail("NotFound")
        yield* authorize(parent, identity, WRITE, entry.op)

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
        publishEntry("Create", parent.ino, name, child.ino)

        return { child: child.ino, directory: { before, after: current().revision } }
      })

      // Creates every missing directory a path names in the running transition, so a failure anywhere discards
      // them all. The mode applies to each directory created and the times to the one in the final position. An
      // entry names one child, created unless it is already a directory. The result names the directory the path
      // ends on and its parent's revision before and after the call, so a final directory that already exists is
      // no change, while a path that leaves a directory it created, such as `new/..`, reports the creation.
      const makeDirectories = Effect.fnUntraced(function*(
        prepared: PreparedEntry,
        request: {
          readonly mode: number
          readonly exactMode?: boolean | undefined
          readonly times?: Times | undefined
        },
        op: OpContext
      ) {
        let node: Node | undefined
        let entryOp = op
        // Each directory that gained a child, with its revision before the first.
        const revisionsBefore = new Map<Ino, bigint>()

        if (prepared.kind === "entry") {
          const entry = yield* resolveEntry(prepared, op)
          const made = yield* Effect.result(makeDirectory(entry, request, op))

          if (Result.isSuccess(made)) return made.success
          const existingIno = entry.name === undefined ? undefined : directoryNow(entry.parent).entries.get(entry.name)
          node = existingIno === undefined ? undefined : view(existingIno)

          if (made.failure.code !== "AlreadyExists" || node?.kind !== "directory") return yield* made.failure
        } else {
          entryOp = op.at(prepared.path.input)

          const resolved = yield* lookup(prepared.path, prepared.base, op, {
            createMissing: (parent, name, final) =>
              Effect.map(
                makeDirectory(
                  { parent: parent.ino, name, trailingSlash: false, addressing: "path", op: entryOp },
                  final ? request : { mode: request.mode, exactMode: request.exactMode },
                  op
                ),
                (made) => {
                  if (!revisionsBefore.has(parent.ino)) revisionsBefore.set(parent.ino, made.directory.before)

                  return directoryNow(made.child)
                }
              )
          })

          node = resolved.node
        }

        if (node?.kind !== "directory") return yield* entryOp.fail("AlreadyExists")
        const after = directoryNow(node.parent).revision

        return { child: node.ino, directory: { before: revisionsBefore.get(node.parent) ?? after, after } }
      })

      const linkNode = Effect.fnUntraced(
        function*(node: Exclude<Node, Directory>, entry: ResolvedEntry, op: OpContext) {
          const name = yield* claimName(entry, "rejected")
          yield* reserveEntry(entry.op)
          const parent = directoryNow(entry.parent)
          const before = parent.revision
          const now = yield* timestamp(op)
          attach(parent, name, node, now)
          current().entries += 1
          publishEntry("Create", parent.ino, name, node.ino)

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
        const name = yield* claimName(entry, "rejected")
        yield* reserveEntry(entry.op)
        yield* reserveBytes(entry.op, BigInt(target.length))
        const parent = directoryNow(entry.parent)
        const before = parent.revision
        const now = yield* timestamp(op)
        const child = newSymlink(parent, target, now, times)

        attach(parent, name, child, now)
        current().entries += 1
        current().usedBytes += BigInt(target.length)
        publishEntry("Create", parent.ino, name, child.ino)

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
        publishEntry("Remove", parent.ino, name, child.ino)
        detach(child, parent.ino, name, now)
        d.entries -= 1

        return { before, after: d.revision }
      })

      // Authorizes removing from the entry's directory and returns the named child. Only a path can name a dot
      // entry, and each verb reports it with its own code. Search permission comes before the lookup and write
      // permission after it, as on Linux; `beforeWrite` holds the verb's own checks that Linux makes in between.
      const removalTarget = Effect.fnUntraced(function*(
        entry: ResolvedEntry,
        dotNameCode: "IsDirectory" | "InvalidArgument",
        beforeWrite?: (child: Node) => FsFailure | undefined
      ) {
        const parent = directoryNow(entry.parent)

        if (isDotComponent(entry.name)) {
          return yield* entry.op.fail(entry.addressing === "entry" ? "InvalidArgument" : dotNameCode)
        }

        yield* authorize(parent, identity, EXECUTE, entry.op)
        const childIno = parent.entries.get(entry.name)
        const child = childIno === undefined ? undefined : view(childIno)

        if (child === undefined) return yield* entry.op.fail("NotFound")
        const rejected = beforeWrite?.(child)

        if (rejected !== undefined) return yield* rejected
        yield* authorize(parent, identity, WRITE, entry.op)

        return { parent, name: entry.name, child }
      })

      // Removes a file, a symbolic link, or an empty directory. A dot name is invalid on either family, and a
      // trailing slash asks for a directory, judged before write permission as unlink and rmdir judge it.
      const removeEntry = Effect.fnUntraced(function*(entry: ResolvedEntry, op: OpContext) {
        const { child, name, parent } = yield* removalTarget(
          entry,
          "InvalidArgument",
          (found) => entry.trailingSlash && found.kind !== "directory" ? entry.op.fail("NotDirectory") : undefined
        )

        yield* authorizeRemoval(parent, child, entry.op)

        if (child.kind === "directory" && child.entries.size > 0) return yield* entry.op.fail("NotEmpty")

        return yield* removeChild(parent, name, child, op)
      })

      const unlinkEntry = Effect.fnUntraced(function*(entry: ResolvedEntry, op: OpContext) {
        // A trailing slash is judged before write permission, as Linux does.
        const { child, name, parent } = yield* removalTarget(
          entry,
          "IsDirectory",
          (found) =>
            !entry.trailingSlash
              ? undefined
              : entry.op.fail(found.kind === "directory" ? "IsDirectory" : "NotDirectory")
        )

        if (child.kind === "directory") return yield* entry.op.fail("IsDirectory")
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

          // Both dot names report against the source path.
          if (isDotComponent(sourceName) || isDotComponent(destinationName)) {
            return yield* source.op.fail("InvalidArgument")
          }

          // Linux's order: search permission on both directories before either name is looked up; the names,
          // trailing slashes, the subtree rule and the same-object no-op; then write permission and the rest.
          yield* authorize(sourceDirectory, identity, EXECUTE, source.op)
          yield* authorize(destinationDirectory, identity, EXECUTE, destination.op)
          const sourceBefore = sourceDirectory.revision
          const destinationBefore = destinationDirectory.revision
          const childIno = sourceDirectory.entries.get(sourceName)
          const child = childIno === undefined ? undefined : view(childIno)

          if (child === undefined) return yield* source.op.fail("NotFound")
          const replacedIno = destinationDirectory.entries.get(destinationName)
          const replaced = replacedIno === undefined ? undefined : view(replacedIno)

          // A trailing slash on either side asks for a directory; a missing slashed destination is fine when the
          // source is one, as Linux allows.
          if ((source.trailingSlash || destination.trailingSlash) && child.kind !== "directory") {
            return yield* (source.trailingSlash ? source.op : destination.op).fail("NotDirectory")
          }

          if (destination.trailingSlash && replaced !== undefined && replaced.kind !== "directory") {
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

          for (let ancestor = destinationDirectory;; ancestor = directoryNow(ancestor.parent)) {
            if (ancestor.ino === child.ino) return yield* destination.op.fail("InvalidArgument")

            if (ancestor.ino === ROOT_INO) break
          }

          if (child.ino === replaced?.ino) return result()
          yield* authorize(sourceDirectory, identity, WRITE, source.op)
          yield* authorize(destinationDirectory, identity, WRITE, destination.op)
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

          const now = yield* timestamp(op)
          const d = current()

          // Every rejection above precedes the namespace and metadata writes below, and the old name is
          // published before the namespace changes.
          publishEntry("Remove", sourceDirectory.ino, sourceName, child.ino)

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

          publishEntry("Create", destination.parent, destinationName, child.ino)

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
            return yield* entry.op.fail("NotPermitted")
          }

          const now = yield* timestamp(op)

          const mode = request.exactMode
            ? yield* permittedMode(
              { kind: "file", uid: owner?.uid ?? identity.uid, gid: owner?.gid ?? parent.metadata.gid },
              request.mode!,
              op
            )
            : (request.mode ?? 0o666) & 0o777 & ~umask

          file = newFile(parent, new Uint8Array(Number(size)), mode, now, owner, request.times)
          attach(parent, name, file, now)
          current().entries += 1
          current().usedBytes += size
          created = true
          publishEntry("Create", parent.ino, name, file.ino)
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

      // ---- Targets and entries. One resolution step per addressing mode; the verb bodies below take the result.

      const prepare = (input: PathInput, op: OpContext) => preparePath(input, op.operation, settings.maxPathBytes)

      // The node an open handle holds, which must belong to this volume and still be held.
      const handleNode = Effect.fnUntraced(function*(handle: FileHandle | DirectoryHandle, op: OpContext) {
        if (reference.ino === undefined) return yield* op.fail("ClosedCaller")
        const ref = isFileHandle(handle) ? files.get(handle) : handles.get(handle)

        if (ref === undefined) return yield* op.fail("InvalidHandle")

        if (ref.volume !== volumeIdentity) return yield* op.fail("ForeignHandle")
        const node = ref.ino === undefined ? undefined : view(ref.ino)

        if (node === undefined) return yield* op.fail("InvalidHandle")

        return node
      })

      interface Resolved {
        readonly node: Node
        // Names the path on a path target; the verb's own context on a reference or a handle.
        readonly op: OpContext
      }

      // A path prepares before the walk, so a malformed input fails before any lookup, and names the path on
      // every failure. A reference or handle names none. The verb's `followFinalSymlink` is the default a
      // path's own setting overrides; `final` makes the verb's setting win, for a verb such as `readLink` whose
      // meaning fixes it.
      const resolveTarget = (
        target: Target,
        op: OpContext,
        options?: { readonly followFinalSymlink?: boolean; readonly final?: boolean }
      ): Effect.Effect<Resolved, FsFailure> =>
        Target.$match(target, {
          Path: ({ followFinalSymlink, path, relativeTo }) =>
            Effect.flatMap(Effect.fromResult(prepare(path, op)), (prepared) =>
              Effect.map(
                resolveNode(prepared, relativeTo, op, {
                  followFinalSymlink: options?.final === true
                    ? options.followFinalSymlink ?? true
                    : followFinalSymlink ?? options?.followFinalSymlink ?? true
                }),
                (node) => ({ node, op: op.at(path) })
              )),
          Reference: ({ reference }) => Effect.map(referencedNode(reference, op), (node) => ({ node, op })),
          Handle: ({ handle }) => Effect.map(handleNode(handle, op), (node) => ({ node, op }))
        })

      const resolveDirectory = Effect.fnUntraced(function*(target: Target, op: OpContext) {
        const resolved = yield* resolveTarget(target, op)

        if (resolved.node.kind !== "directory") return yield* resolved.op.fail("NotDirectory")

        return { node: resolved.node, op: resolved.op }
      })

      // The directory an entry names a child of. A removed directory that a handle still holds takes no new
      // children, as on Linux, where creating through a descriptor of a removed directory fails with ENOENT.
      const entryDirectory = Effect.fnUntraced(function*(target: Target, op: OpContext) {
        const directory = yield* resolveDirectory(target, op)

        if (directory.node.metadata.nlink === 0) return yield* directory.op.fail("NotFound")

        return directory
      })

      const asResolvedNode = (target: Target, op: OpContext, options?: { readonly followFinalSymlink?: boolean }) =>
        Effect.map(
          resolveTarget(target, op, options),
          (resolved): ResolvedNode => ({ ino: resolved.node.ino, op: resolved.op })
        )

      // What an entry input becomes before coordination: a prepared path, or a directory target and a checked name.
      type PreparedEntry =
        | { readonly kind: "path"; readonly path: PreparedPath; readonly base: DirectoryHandle | undefined }
        | { readonly kind: "entry"; readonly directory: Target; readonly name: string }

      // A well-formed name is one to 255 bytes with no NUL and no slash; "." and ".." pass here and are
      // reported by the verb, after the directory resolves, with the code the addressing mode gives them.
      // A string name must be well-formed UTF-16, as a string path must.
      const entryName = (input: NameInput, op: OpContext): Result.Result<string, FsFailure> => {
        if (Predicate.isString(input) && !isWellFormed(input)) return Result.fail(op.fail("InvalidPathEncoding"))
        const bytes = Predicate.isString(input) ? encoder.encode(input) : input

        if (
          !isAttachedBytes(bytes) || bytes.length === 0 || bytes.length > MAX_NAME_BYTES || bytes.includes(0) ||
          bytes.includes(SLASH_BYTE)
        ) return Result.fail(op.fail("InvalidArgument"))

        return Result.succeed(Encoding.encodeHex(new Uint8Array(bytes)))
      }

      const prepareEntry = (input: EntryInput, op: OpContext): Result.Result<PreparedEntry, FsFailure> =>
        isEntry(input)
          ? Result.map(
            entryName(input.name, op),
            (name): PreparedEntry => ({ kind: "entry", directory: input.directory, name })
          )
          : isTarget(input)
          ? Result.map(
            prepare(input.path, op),
            (path): PreparedEntry => ({ kind: "path", path, base: input.relativeTo })
          )
          : Result.map(prepare(input, op), (path): PreparedEntry => ({ kind: "path", path, base: undefined }))

      const resolveEntry = Effect.fnUntraced(function*(prepared: PreparedEntry, op: OpContext) {
        if (prepared.kind === "path") {
          return yield* ResolvedEntry.fromPath(prepared.path, prepared.base, op)
        }

        const directory = yield* entryDirectory(prepared.directory, op)

        return {
          parent: directory.node.ino,
          name: prepared.name,
          trailingSlash: false,
          addressing: "entry" as const,
          op
        } satisfies ResolvedEntry
      })

      const asTarget = (input: TargetInput): Target => Target.of(input)

      const acquireDirectory = Effect.fnUntraced(function*(input: TargetInput, op: OpContext) {
        const target = asTarget(input)
        const acquired = makeDirectoryReference()

        return yield* acquireHandle(
          acquired,
          (acquire) => coordinatedRead(op, Effect.uninterruptible(acquire)),
          Effect.gen(function*() {
            const directory = yield* resolveDirectory(target, op)
            yield* authorize(directory.node, identity, EXECUTE, directory.op)
            holdDirectory(directory.node.ino)
            acquired.ino = directory.node.ino

            return acquired
          }),
          // Nothing to undo here: the finalizer that follows an interrupted acquisition releases the hold under
          // every permit, where a detached directory may leave the table.
          () => {},
          finalizeDirectory(acquired)
        )
      })

      // An invalid argument, naming the attribute at fault when there is one.
      const fail = (op: OpContext, cause?: unknown, field?: string) =>
        op.fail("InvalidArgument", field === undefined ? { cause } : { cause, field })

      // The context an entry's own failures use: the path on a path input, the verb's own on an entry.
      const preparedOp = (prepared: PreparedEntry, op: OpContext) =>
        prepared.kind === "path" ? op.at(prepared.path.input) : op

      // Opens through a path, which may create its final component.
      const openPath = Effect.fnUntraced(
        function*(target: Extract<Target, { _tag: "Path" }>, options: OpenOptions, op: OpContext) {
          const pathOp = op.at(target.path)
          const prepared = prepare(target.path, op)
          const chosen = yield* decodeOpenOptions(options).pipe(Effect.mapError((cause) => fail(pathOp, cause)))

          if (chosen.access === "read" && (chosen.append || chosen.truncate)) {
            return yield* pathOp.fail("InvalidArgument")
          }

          if (chosen.mode !== undefined && (chosen.create === undefined || chosen.create === "never")) {
            return yield* pathOp.fail("InvalidArgument")
          }

          const acquired = makeFileReference(chosen.access, chosen.append ?? false)
          const follow = target.followFinalSymlink ?? true

          return yield* acquireOpenedFile(
            acquired,
            op,
            (opened) =>
              Effect.gen(function*() {
                const path = yield* Effect.fromResult(prepared)

                if (chosen.create === "exclusive") {
                  const existing = yield* Effect.result(
                    lookup(path, target.relativeTo, op, { followFinalSymlink: false })
                  )

                  if (Result.isSuccess(existing)) return yield* pathOp.fail("AlreadyExists")

                  if (existing.failure.code !== "NotFound") return yield* existing.failure
                }

                const resolved = yield* lookup(path, target.relativeTo, op, {
                  followFinalSymlink: follow,
                  allowMissing: chosen.create === "ifMissing" || chosen.create === "exclusive"
                })

                const parent = resolved.parent

                if (parent === undefined) return yield* pathOp.fail("IsDirectory")
                const name = resolved.name

                if (isDotComponent(name)) return yield* pathOp.fail("IsDirectory")

                // A trailing slash asks for a directory, which a create cannot make.
                if (resolved.node === undefined && path.trailingSlash) return yield* pathOp.fail("IsDirectory")
                yield* authorize(parent, identity, EXECUTE, pathOp)
                const file = resolved.node

                if (file !== undefined && chosen.create === "exclusive") return yield* pathOp.fail("AlreadyExists")

                const result = yield* openFile(
                  { parent: parent.ino, name, trailingSlash: path.trailingSlash, addressing: "path", op: pathOp },
                  file,
                  chosen,
                  acquired,
                  op
                )

                opened(result.ino)

                return fileHandle(acquired)
              })
          )
        }
      )

      // Opens an existing file a reference or a handle names; nothing can be created through either.
      const openNode = Effect.fnUntraced(function*(target: Target, options: OpenOptions, op: OpContext) {
        const chosen = yield* decodeOpenOptions(options).pipe(Effect.mapError((cause) => fail(op, cause)))

        if (chosen.access === "read" && (chosen.append || chosen.truncate)) return yield* op.fail("InvalidArgument")

        if ((chosen.create !== undefined && chosen.create !== "never") || chosen.mode !== undefined) {
          return yield* op.fail("InvalidArgument")
        }

        const acquired = makeFileReference(chosen.access, chosen.append ?? false)

        return yield* acquireOpenedFile(
          acquired,
          op,
          (opened) =>
            Effect.gen(function*() {
              const resolved = yield* resolveTarget(target, op)
              const node = resolved.node

              if (node.kind !== "file") return yield* resolved.op.fail("IsDirectory")

              if (node.metadata.nlink === 0) return yield* resolved.op.fail("StaleReference")
              yield* openExisting(node, chosen, resolved.op, op)
              current().retain(node.ino)
              bindFile(acquired, node.ino)
              opened(node.ino)

              return fileHandle(acquired)
            })
        )
      })

      // Looks a name up under a directory target and opens or creates it in one gate hold.
      const openEntry = Effect.fnUntraced(function*(entry: Entry, options: OpenEntryOptions, op: OpContext) {
        const name = yield* Effect.fromResult(entryName(entry.name, op))
        const decoded = yield* decodeOpenEntryOptions(options).pipe(Effect.mapError((cause) => fail(op, cause)))
        const chosen = { ...decoded }

        if (chosen.access === "read" && (chosen.append || chosen.truncate)) return yield* op.fail("InvalidArgument")

        if (
          (chosen.mode !== undefined || chosen.times !== undefined || chosen.initialSize !== undefined ||
            chosen.exactMode !== undefined || chosen.owner !== undefined) &&
          (chosen.create === undefined || chosen.create === "never")
        ) {
          return yield* op.fail("InvalidArgument")
        }

        if (chosen.exactMode && chosen.mode === undefined) return yield* op.fail("InvalidArgument")
        const relativePath = preparePath(ownedPath(nameBytes(name)), op.operation, undefined)
        const acquired = makeFileReference(chosen.access, chosen.append ?? false)
        const expected = chosen.expected

        return yield* acquireOpenedFile(
          acquired,
          op,
          (opened) =>
            Effect.gen(function*() {
              const parent = (yield* entryDirectory(entry.directory, op)).node

              if (isDotComponent(name)) return yield* op.fail("InvalidArgument")
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

                if (direct?.ino !== expectedIno) return yield* op.fail("VolumeBusy")
              }

              if (chosen.expectedChild === null) {
                if (direct !== undefined) return yield* op.fail("StaleReference")
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

              if (direct !== undefined && chosen.create === "exclusive") return yield* op.fail("AlreadyExists")
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
                { parent: mutationParent, name: mutationName, trailingSlash: false, addressing: "entry", op },
                file,
                // An entry create always checks its size, even when none was given.
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
      })

      // A directory's children as walk frames, in the byte order of their names, which hex names keep. It runs in
      // the observation that read the directory, so every reference is minted while its object is in the table.
      const walkChildren = (
        directory: Directory,
        path: Uint8Array,
        depth: number,
        up: WalkFrame | undefined
      ): Array<WalkFrame> => {
        const listed = referenceFor(directory.ino)
        const frames: Array<WalkFrame> = []

        for (const name of [...directory.entries.keys()].sort()) {
          const childIno = directory.entries.get(name)
          const child = childIno === undefined ? undefined : view(childIno)

          if (child === undefined) continue
          const bytes = nameBytes(name)

          frames.push({
            ino: child.ino,
            kind: child.kind,
            name: bytes,
            key: name,
            path: joinPath(path, bytes),
            parent: directory.ino,
            up,
            depth: depth + 1,
            bytes: child.kind === "directory" ? 0n : child.metadata.size,
            reference: referenceFor(child.ino),
            directory: listed,
            listed: false
          })
        }

        return frames
      }

      // The frame that anchors a walk's root by the name its directory holds it under, so the root is reached by
      // name like every directory below it. It is never reported.
      const anchorFrame = (parent: Directory, key: string, root: Directory): WalkFrame => ({
        ino: root.ino,
        kind: root.kind,
        name: nameBytes(key),
        key,
        path: new Uint8Array(0),
        parent: parent.ino,
        up: undefined,
        depth: 0,
        bytes: 0n,
        reference: referenceFor(root.ino),
        directory: referenceFor(parent.ino),
        listed: false
      })

      // The anchor of a walk rooted at a path: the path's final name in its directory, when that name holds the
      // root itself. A root reached through a final symbolic link, named by a dot, or held by a reference or a
      // handle has none.
      const pathAnchor = (target: Target, root: Directory, op: OpContext): Effect.Effect<WalkFrame | undefined> => {
        if (!Target.$is("Path")(target)) return Effect.undefined
        const prepared = prepare(target.path, op)

        if (Result.isFailure(prepared)) return Effect.undefined

        return ResolvedEntry.fromPath(prepared.success, target.relativeTo, op).pipe(
          Effect.map((entry) => {
            const parent = view(entry.parent)

            return entry.name !== undefined && parent?.kind === "directory" &&
                parent.entries.get(entry.name) === root.ino
              ? anchorFrame(parent, entry.name, root)
              : undefined
          }),
          Effect.catch(() => Effect.undefined)
        )
      }

      // Whether a directory still holds a frame's name for the object the walk listed under it.
      const holds = (parent: Node | undefined, frame: WalkFrame): parent is Directory =>
        parent?.kind === "directory" && parent.metadata.nlink > 0 && parent.entries.get(frame.key) === frame.ino

      // The node a frame names, reached by name from the walk's root as a path lookup reaches it: every directory on
      // the way must be searchable and must still hold the name the walk listed for the object it listed. A frame
      // whose chain no longer holds it, such as a directory renamed out of the tree, reaches nothing. A root the
      // walk reached by name is anchored by that name, so a root moved away reaches nothing too; a root reached
      // through a reference or a handle is held by the object it resolved to, as a descriptor holds it.
      // It steps down the chain in a loop, so a tree of any depth reaches its frames without deepening the stack.
      const reachFrame = (frame: WalkFrame, at: OpContext): Effect.Effect<Node | undefined, FsFailure> =>
        Effect.gen(function*() {
          const chain: Array<WalkFrame> = []

          for (let link: WalkFrame | undefined = frame; link !== undefined; link = link.up) chain.push(link)
          let node: Node | undefined = view((chain.at(-1) ?? frame).parent)

          for (let index = chain.length - 1; index >= 0; index--) {
            const link = chain[index]

            if (link === undefined || node?.kind !== "directory" || node.metadata.nlink === 0) return undefined
            yield* authorize(node, identity, EXECUTE, at)
            node = node.entries.get(link.key) === link.ino ? view(link.ino) : undefined
          }

          return node
        })

      // Walks the tree below the directory `first` lists, depth first. Every later directory is read in its own
      // observation, so a walk holds one permit at a time and never a handle; it writes nothing, so it refreshes no
      // access time. Each directory is reached by name, so it needs search permission on the directories above it,
      // and one that left the tree after it was listed has nothing to walk. A directory past `maxDepth` is never
      // read. `locate` names an entry's path in a failure, and `listable` authorizes reading a directory. Entries
      // gathered before a failure are handed on before the failure is.
      const walkFrames = (
        op: OpContext,
        first: Effect.Effect<Array<WalkFrame>, FsFailure>,
        plan: WalkPlan,
        locate: (path: Uint8Array) => PathInput,
        listable: (directory: Directory, at: OpContext) => Effect.Effect<void, FsFailure>
      ): Stream.Stream<WalkFrame, WalkFailure> =>
        Stream.suspend(() => {
          let pending: Array<WalkFrame> | undefined
          let entries = 0
          let bytes = 0n
          let failure: WalkFailure | undefined

          const list = (frame: WalkFrame) =>
            coordinatedRead(
              op,
              Effect.suspend(() => {
                if (reference.ino === undefined) return Effect.fail(op.fail("ClosedCaller"))
                const at = op.at(locate(frame.path))

                return Effect.flatMap(reachFrame(frame, at), (node) =>
                  node?.kind !== "directory" || node.metadata.nlink === 0
                    ? Effect.succeed([])
                    : Effect.as(listable(node, at), walkChildren(node, frame.path, frame.depth, frame)))
              })
            )

          const exceeded = (frame: WalkFrame, field: keyof WalkOptions): WalkFailure =>
            makeError({ code: "LimitExceeded", operation: op.operation, field, path: errorPath(locate(frame.path)) })

          const admit = (frame: WalkFrame): WalkFailure | undefined => {
            if (plan.maxDepth !== undefined && frame.depth > plan.maxDepth) return exceeded(frame, "maxDepth")

            if (plan.maxEntries !== undefined && ++entries > plan.maxEntries) return exceeded(frame, "maxEntries")
            bytes += frame.bytes

            if (plan.maxBytes !== undefined && bytes > plan.maxBytes) return exceeded(frame, "maxBytes")

            return undefined
          }

          const step = Effect.gen(function*() {
            if (failure !== undefined) return yield* failure

            if (pending === undefined) pending = (yield* first).reverse()
            const out: Array<WalkFrame> = []

            const stop = (error: WalkFailure) => {
              if (out.length === 0) return Effect.fail(error)
              failure = error

              return Effect.succeed([out, Option.some(undefined)] as const)
            }

            while (out.length < WALK_CHUNK_ENTRIES) {
              const frame = pending.pop()

              if (frame === undefined) return [out, Option.none()] as const
              const unlisted = frame.kind === "directory" && !frame.listed

              if (!unlisted || plan.order === "pre") {
                const rejected = admit(frame)

                if (rejected !== undefined) return yield* stop(rejected)
                out.push(frame)
              }

              if (unlisted) {
                // A post-order walk reports a directory after its entries, so it judges the depth before reading.
                if (plan.maxDepth !== undefined && frame.depth > plan.maxDepth) {
                  return yield* stop(exceeded(frame, "maxDepth"))
                }

                const listed = yield* Effect.result(list(frame))

                if (Result.isFailure(listed)) return yield* stop(listed.failure)

                if (plan.order === "post") pending.push({ ...frame, listed: true })

                for (let index = listed.success.length - 1; index >= 0; index--) {
                  const child = listed.success[index]

                  if (child !== undefined) pending.push(child)
                }

                return [out, Option.some(undefined)] as const
              }
            }

            return [out, Option.some(undefined)] as const
          })

          return Stream.paginate(undefined, () => step)
        })

      // Empties the directory an entry names, entries before their directories, each removal its own change. Each
      // entry is removed by its name in the directory the walk reached by name from the target's name, and only
      // while that name still holds the object the walk listed, so a subtree renamed out of the target, the target
      // renamed away, and a replacement created under a listed name are all left alone. It stops at the first
      // failure, which names the entry's path under the one the caller gave. Removing an empty directory reveals nothing, so only a directory with entries must be readable, and
      // no permission is changed to make one so. With `force`, the entry itself going missing leaves nothing to
      // empty.
      const emptyDirectory = Effect.fnUntraced(function*(prepared: PreparedEntry, op: OpContext, force: boolean) {
        const prefix = prepared.kind === "path" ? prepared.path.bytes : nameBytes(prepared.name)
        const locate = (path: Uint8Array): PathInput => ownedPath(joinPath(prefix, path))

        const listable = (directory: Directory, at: OpContext) =>
          directory.entries.size === 0 ? Effect.void : authorize(directory, identity, READ, at)

        // The target's name and the object it held when the walk listed it, and the context its failures use.
        let anchor: WalkFrame | undefined
        let targetAt = preparedOp(prepared, op)

        const first = coordinatedRead(
          op,
          Effect.gen(function*() {
            const entry = yield* resolveEntry(prepared, op)
            const parent = directoryNow(entry.parent)
            yield* authorize(parent, identity, EXECUTE, entry.op)
            const childIno = entry.name === undefined ? undefined : parent.entries.get(entry.name)
            const child = childIno === undefined ? undefined : view(childIno)

            if (entry.name === undefined || child === undefined) return yield* entry.op.fail("NotFound")

            // Something else took the name since the removal found it full; removing the entry again judges it.
            if (child.kind !== "directory") return []
            yield* listable(child, entry.op)
            anchor = anchorFrame(parent, entry.name, child)
            targetAt = entry.op

            return walkChildren(child, new Uint8Array(0), 0, anchor)
          })
        ).pipe(
          Effect.catchIf((error) => force && error.code === "NotFound", () => Effect.succeed([]))
        )

        const seams = yield* VolumeTestSeams

        const removeFrame = (frame: WalkFrame) => {
          const at = op.at(locate(frame.path))

          return Effect.andThen(
            seams.beforeTreeRemoval,
            coordinated(
              op,
              Effect.suspend(() => {
                // A target moved out of its name leaves nothing to remove; `force` forgives that, as it does the
                // target going missing.
                if (anchor !== undefined && !holds(view(anchor.parent), anchor)) {
                  return force ? Effect.void : Effect.fail(targetAt.fail("NotFound"))
                }

                // The name must still hold the object the walk listed, so a replacement created under it stays.
                return Effect.flatMap(
                  frame.up === undefined ? Effect.succeed(view(frame.parent)) : reachFrame(frame.up, at),
                  (parent) =>
                    !holds(parent, frame)
                      ? Effect.fail(at.fail("NotFound"))
                      : removeEntry({
                        parent: parent.ino,
                        name: frame.key,
                        trailingSlash: false,
                        addressing: "entry",
                        op: at
                      }, op)
                )
              })
            )
          )
        }

        const plan: WalkPlan = { order: "post", maxDepth: undefined, maxEntries: undefined, maxBytes: undefined }

        return yield* Stream.runForEach(walkFrames(op, first, plan, locate, listable), removeFrame)
      })

      const rootOp = OpContext.make("root")

      const entryVerb = Effect.fnUntraced(function*<A>(
        operation: string,
        input: EntryInput,
        body: (entry: ResolvedEntry, op: OpContext) => Effect.Effect<A, FsFailure>
      ) {
        const op = OpContext.make(operation)
        const prepared = yield* Effect.fromResult(prepareEntry(input, op))

        return yield* coordinated(op, Effect.flatMap(resolveEntry(prepared, op), (entry) => body(entry, op)))
      })

      const caller: Caller = Object.freeze({
        [CallerId]: true as const,
        root: coordinatedRead(
          rootOp,
          Effect.suspend(() =>
            reference.ino === undefined
              ? Effect.fail(rootOp.fail("ClosedCaller"))
              : Effect.succeed(referenceFor(ROOT_INO))
          )
        ).pipe(Effect.withSpan("Caller.root")),
        lookup: Effect.fn("Caller.lookup")(function*(input) {
          const op = OpContext.make("lookup")
          const prepared = yield* Effect.fromResult(prepareEntry(input, op))

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const entry = yield* resolveEntry(prepared, op)
              const directory = directoryNow(entry.parent)

              if (isDotComponent(entry.name)) {
                return yield* entry.op.fail(entry.addressing === "entry" ? "InvalidArgument" : "NotFound")
              }

              yield* authorize(directory, identity, EXECUTE, entry.op)
              const child = directory.entries.get(entry.name)

              if (child === undefined) return yield* entry.op.fail("NotFound")

              return referenceFor(child)
            })
          )
        }),
        parent: Effect.fn("Caller.parent")(function*(input) {
          const op = OpContext.make("parent")
          const target = asTarget(input)

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const directory = yield* resolveDirectory(target, op)
              yield* authorize(directory.node, identity, EXECUTE, directory.op)

              return referenceFor(directory.node.parent)
            })
          )
        }),
        stat: Effect.fn("Caller.stat")(function*(input) {
          const op = OpContext.make("stat")
          const target = asTarget(input)

          return yield* coordinatedRead(
            op,
            Effect.map(resolveTarget(target, op), (resolved) => withMetadata(resolved.node))
          )
        }),
        readDirectory: Effect.fn("Caller.readDirectory")(function*(input) {
          const op = OpContext.make("readDirectory")
          const target = asTarget(input)

          return yield* accessing(
            op,
            Effect.gen(function*() {
              const directory = yield* resolveDirectory(target, op)
              yield* authorize(directory.node, identity, READ, directory.op)

              const value = Object.freeze(
                [...directory.node.entries].map(([name, child]) =>
                  Object.freeze({ name: nameBytes(name), reference: referenceFor(child) })
                )
              )

              const access = { node: directory.node, now: yield* timestamp(op) }

              return { value: Object.freeze({ value, revision: directory.node.revision }), access }
            })
          )
        }),
        walk: (input: TargetInput, options?: WalkOptions): Stream.Stream<WalkEntry, WalkFailure> => {
          const op = OpContext.make("walk")
          const target = asTarget(input)
          // A path root names each entry's path under it; a reference or handle root names the path below it.
          const prefix = Target.$is("Path")(target) ? Result.getOrUndefined(inputBytes(target.path)) : undefined

          const locate = (path: Uint8Array): PathInput =>
            ownedPath(prefix === undefined ? path : joinPath(prefix, path))

          const readable = (directory: Directory, at: OpContext) => authorize(directory, identity, READ, at)

          return Stream.unwrap(Effect.gen(function*() {
            const chosen = yield* decodeWalkOptions(options ?? {}).pipe(
              Effect.mapError((cause) => fail(Target.$is("Path")(target) ? op.at(target.path) : op, cause))
            )

            const first = coordinatedRead(
              op,
              Effect.gen(function*() {
                const directory = yield* resolveDirectory(target, op)
                yield* authorize(directory.node, identity, READ, directory.op)

                return walkChildren(directory.node, new Uint8Array(0), 0, yield* pathAnchor(target, directory.node, op))
              })
            )

            const plan: WalkPlan = {
              order: chosen.order ?? "pre",
              maxDepth: chosen.maxDepth,
              maxEntries: chosen.maxEntries,
              maxBytes: chosen.maxBytes === undefined ? undefined : ByteSize.toBigInt(chosen.maxBytes)
            }

            return Stream.map(walkFrames(op, first, plan, locate, readable), (frame): WalkEntry =>
              Object.freeze({
                path: ownedPath(frame.path),
                name: frame.name,
                reference: frame.reference,
                directory: frame.directory,
                kind: frame.kind,
                depth: frame.depth
              }))
          })).pipe(Stream.withSpan("Caller.walk"))
        },
        readLink: Effect.fn("Caller.readLink")(function*(input) {
          const op = OpContext.make("readLink")
          const target = asTarget(input)

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              // Reading a link never follows it, whatever the target asks.
              const resolved = yield* resolveTarget(target, op, { followFinalSymlink: false, final: true })

              if (resolved.node.kind !== "symlink") return yield* resolved.op.fail("InvalidArgument")

              return new Uint8Array(resolved.node.target)
            })
          )
        }),
        realPath: Effect.fn("Caller.realPath")(function*(input) {
          const op = OpContext.make("realPath")
          const target = asTarget(input)

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              if (Target.$is("Path")(target)) {
                const pathOp = op.at(target.path)
                const result = yield* lookup(yield* Effect.fromResult(prepare(target.path, op)), target.relativeTo, op)
                const directory = result.node?.kind === "directory" ? result.node : result.parent
                const prefix = directory === undefined ? SLASH_HEX : pathOf(view, directory.ino)

                if (prefix === undefined) return yield* pathOp.fail("NotFound")

                if (result.node?.kind === "directory" || result.name === undefined) return ownedPath(nameBytes(prefix))

                return ownedPath(nameBytes(prefix + (prefix === SLASH_HEX ? "" : SLASH_HEX) + result.name))
              }

              const resolved = yield* resolveTarget(target, op)
              const path = pathOf(view, resolved.node.ino)

              if (path === undefined) return yield* resolved.op.fail("NotFound")

              return ownedPath(nameBytes(path))
            })
          )
        }),
        access: Effect.fn("Caller.access")(function*(input, bits = 0) {
          const op = OpContext.make("access")
          const target = asTarget(input)

          if (!Number.isInteger(bits) || bits < 0 || bits > (READ | WRITE | EXECUTE)) {
            return yield* (Target.$is("Path")(target) ? op.at(target.path) : op).fail("InvalidArgument")
          }

          return yield* coordinatedRead(
            op,
            Effect.map(resolveTarget(target, op), (resolved) => {
              const node = resolved.node
              let granted = 0

              for (const bit of [READ, WRITE, EXECUTE]) {
                if ((bits & bit) === 0) continue

                // Even a privileged caller needs one execute bit somewhere to execute a file.
                if (bit === EXECUTE && node.kind === "file" && (node.metadata.mode & ANY_EXECUTE) === 0) continue

                if (identity.privileged || (permitted(node, identity) & bit) !== 0) granted |= bit
              }

              return granted
            })
          )
        }),
        readFile: Effect.fn("Caller.readFile")(function*(input) {
          const op = OpContext.make("readFile")
          const target = asTarget(input)

          return yield* accessing(
            op,
            Effect.gen(function*() {
              const resolved = yield* resolveTarget(target, op)
              const node = resolved.node

              // A symlink is reached only without following it, which Linux refuses with ELOOP, as open does.
              if (node.kind === "symlink") return yield* resolved.op.fail("SymlinkLoop")

              if (node.kind !== "file") return yield* resolved.op.fail("IsDirectory")
              yield* authorize(node, identity, READ, resolved.op)
              const data = new Uint8Array(node.data)

              return { value: data, access: { node, now: yield* timestamp(op) } }
            })
          )
        }),
        writeFile: Effect.fn("Caller.writeFile")(function*(input, bytes, options) {
          const op = OpContext.make("writeFile")

          const prepared = yield* Effect.fromResult(prepareEntry(input, op))
          const optionsOp = preparedOp(prepared, op)

          if (!isAttachedBytes(bytes)) return yield* optionsOp.fail("InvalidArgument")
          const captured = new Uint8Array(bytes)
          const chosen = yield* decodeWriteFileOptions(options).pipe(Effect.mapError((cause) => fail(optionsOp, cause)))

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              let entryOp = op
              let parent: Directory
              let name: string
              let found: Node | undefined
              let trailingSlash = false

              if (prepared.kind === "path") {
                const path = prepared.path
                entryOp = op.at(path.input)

                if (chosen.create === "exclusive") {
                  const exists = yield* Effect.result(lookup(path, prepared.base, op, { followFinalSymlink: false }))

                  if (Result.isSuccess(exists)) return yield* entryOp.fail("AlreadyExists")

                  if (exists.failure.code !== "NotFound") return yield* exists.failure
                }

                const resolved = yield* lookup(path, prepared.base, op, {
                  followFinalSymlink: chosen.replaceFinalSymlink !== true && chosen.followFinalSymlink !== false,
                  allowMissing: chosen.create === "ifMissing" || chosen.create === "exclusive"
                })

                if (
                  resolved.parent === undefined || resolved.name === undefined || resolved.node?.kind === "directory"
                ) {
                  return yield* entryOp.fail("IsDirectory")
                }

                parent = resolved.parent
                name = resolved.name
                found = resolved.node
                trailingSlash = path.trailingSlash
              } else {
                const directory = yield* entryDirectory(prepared.directory, op)

                if (isDotComponent(prepared.name)) return yield* op.fail("InvalidArgument")
                yield* authorize(directory.node, identity, EXECUTE, op)
                parent = directory.node
                name = prepared.name
                const childIno = parent.entries.get(name)
                let child = childIno === undefined ? undefined : view(childIno)

                if (
                  child?.kind === "symlink" && chosen.replaceFinalSymlink !== true &&
                  chosen.followFinalSymlink !== false
                ) {
                  const resolved = yield* lookup(
                    yield* Effect.fromResult(preparePath(ownedPath(nameBytes(name)), op.operation, undefined)),
                    undefined,
                    op,
                    {
                      followFinalSymlink: true,
                      allowMissing: chosen.create === "ifMissing" || chosen.create === "exclusive"
                    },
                    parent
                  )

                  if (
                    resolved.parent === undefined || resolved.name === undefined || resolved.node?.kind === "directory"
                  ) {
                    return yield* op.fail("IsDirectory")
                  }

                  parent = resolved.parent
                  name = resolved.name
                  child = resolved.node
                }

                if (child === undefined && (chosen.create === undefined || chosen.create === "never")) {
                  return yield* op.fail("NotFound")
                }

                if (child !== undefined && chosen.create === "exclusive") return yield* op.fail("AlreadyExists")

                if (child?.kind === "directory") return yield* op.fail("IsDirectory")
                found = child
              }

              // A trailing slash asks for a directory, which a create cannot make.
              if (found === undefined && trailingSlash) return yield* entryOp.fail("IsDirectory")
              const replaced = found?.kind === "symlink" ? found : undefined

              if (replaced !== undefined && !chosen.replaceFinalSymlink) return yield* entryOp.fail("SymlinkLoop")

              if (chosen.access === "read") return yield* entryOp.fail("InvalidHandle")
              const file = found?.kind === "file" ? found : undefined

              if (file === undefined) {
                yield* authorize(parent, identity, WRITE | EXECUTE, entryOp)

                if (replaced !== undefined) yield* authorizeRemoval(parent, replaced, entryOp)

                yield* replaced === undefined ? reserveEntry(entryOp) : reserveInode(entryOp)
              } else {
                yield* authorize(file, identity, chosen.access === "readWrite" ? READ | WRITE : WRITE, entryOp)
              }

              const finalMode = chosen.finalMode === undefined ? undefined : yield* permittedMode(
                file?.metadata ?? { kind: "file", uid: identity.uid, gid: parent.metadata.gid },
                chosen.finalMode,
                entryOp
              )

              const previous = file?.data.length ?? 0
              const initial = chosen.truncate ? 0 : previous
              const position = chosen.append ? initial : 0
              const size = Math.max(initial, position + captured.length)

              if (size > maxFileBytes) return yield* entryOp.fail("FileTooLarge")
              const reclaimed = replaced !== undefined && replaced.metadata.nlink === 1 ? replaced.target.length : 0

              // Replacing a symbolic link frees its target bytes once this is its last link.
              yield* reserveBytes(entryOp, BigInt(size - previous) - BigInt(reclaimed))

              if (file !== undefined && !chosen.truncate && captured.length === 0 && chosen.finalMode === undefined) {
                return
              }

              let data = captured

              if (position !== 0 || size !== captured.length) {
                data = new Uint8Array(size)

                if (file !== undefined && !chosen.truncate) data.set(file.data)
                data.set(captured, position)
              }

              const now = yield* timestamp(op)
              const d = current()

              // Content and size are assigned below on the shared path that also covers an existing file.
              const node = file ?? newFile(parent, new Uint8Array(0), (chosen.mode ?? 0o666) & 0o777 & ~umask, now)

              const written: RegularFile = {
                ...node,
                data,
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
                publishEntry(replaced === undefined ? "Create" : "Update", parent.ino, name, written.ino)
              } else {
                d.put(written)
                publishNode(written.ino)
              }
            })
          )
        }),
        // SAFETY: the overloads pair an entry with entry options and a target with open options; the decoders below
        // reject the other shape, so one implementation serves both.
        open: Effect.fn("Caller.open")(function*(input: TargetInput | Entry, options: OpenOptions | OpenEntryOptions) {
          const op = OpContext.make("open")

          if (isEntry(input)) return yield* openEntry(input, options, op)
          const target = asTarget(input)

          if (Target.$is("Path")(target)) return yield* openPath(target, options, op)

          return yield* openNode(target, options, op)
        }) as Caller["open"],
        mkdir: Effect.fn("Caller.mkdir")(function*(input, options = {}) {
          const op = OpContext.make("mkdir")
          const prepared = yield* Effect.fromResult(prepareEntry(input, op))
          const optionsOp = preparedOp(prepared, op)
          const decoded = yield* decodeMkdirOptions(options).pipe(Effect.mapError((cause) => fail(optionsOp, cause)))
          const chosen = { ...decoded }

          if (chosen.exactMode && chosen.mode === undefined) return yield* optionsOp.fail("InvalidArgument")

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const request = { mode: chosen.mode ?? 0o777, exactMode: chosen.exactMode, times: chosen.times }

              const { child, directory } = chosen.recursive === true
                ? yield* makeDirectories(prepared, request, op)
                : yield* makeDirectory(yield* resolveEntry(prepared, op), request, op)

              return { reference: referenceFor(child), directory }
            })
          )
        }),
        symlink: Effect.fn("Caller.symlink")(function*(target, input, options = {}) {
          const op = OpContext.make("symlink")
          const targetOp = op.at(target)
          const prepared = yield* Effect.fromResult(prepareEntry(input, op))
          const optionsOp = preparedOp(prepared, op)
          const decoded = yield* decodeSymlinkOptions(options).pipe(Effect.mapError((cause) => fail(optionsOp, cause)))
          const rawTarget = inputBytes(target)

          if (Result.isFailure(rawTarget)) return yield* targetOp.fail(rawTarget.failure)

          if (rawTarget.success.includes(0)) return yield* targetOp.fail("InvalidArgument")
          const targetBytes = new Uint8Array(rawTarget.success)
          const chosen = { ...decoded }

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const entry = yield* resolveEntry(prepared, op)
              const { child, directory } = yield* makeSymlink(entry, targetBytes, chosen.times, op)

              return { reference: referenceFor(child), directory }
            })
          )
        }),
        link: Effect.fn("Caller.link")(function*(sourceInput, input) {
          const op = OpContext.make("link")
          const source = asTarget(sourceInput)
          const prepared = yield* Effect.fromResult(prepareEntry(input, op))

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              // A path source follows a final symbolic link only when its target says so.
              const resolved = yield* resolveTarget(source, op, { followFinalSymlink: false })
              const node = resolved.node

              if (node.kind === "directory") return yield* resolved.op.fail("IsDirectory")

              if (node.metadata.nlink === 0) return yield* resolved.op.fail("StaleReference")
              const entry = yield* resolveEntry(prepared, op)
              const directory = yield* linkNode(node, entry, op)

              return { reference: referenceFor(node.ino), directory }
            })
          )
        }),
        unlink: Effect.fn("Caller.unlink")(function*(input) {
          return yield* entryVerb("unlink", input, unlinkEntry)
        }),
        rmdir: Effect.fn("Caller.rmdir")(function*(input) {
          return yield* entryVerb("rmdir", input, rmdirEntry)
        }),
        // SAFETY: the overloads differ only in whether `force` may leave nothing removed; one body serves both.
        remove: Effect.fn("Caller.remove")(function*(input: EntryInput, options?: RemoveOptions) {
          const op = OpContext.make("remove")
          const prepared = yield* Effect.fromResult(prepareEntry(input, op))

          const chosen = yield* decodeRemoveOptions(options ?? {}).pipe(
            Effect.mapError((cause) => fail(preparedOp(prepared, op), cause))
          )

          const once = coordinated(op, Effect.flatMap(resolveEntry(prepared, op), (entry) => removeEntry(entry, op)))

          // `force` forgives only the target itself going missing, never an entry below it.
          const target = <A>(effect: Effect.Effect<A, FsFailure>) =>
            chosen.force === true
              ? Effect.catchIf(effect, (error) => error.code === "NotFound", () => Effect.undefined)
              : effect

          const removed = yield* Effect.result(target(once))

          if (Result.isSuccess(removed)) return removed.success

          if (chosen.recursive !== true || removed.failure.code !== "NotEmpty") return yield* removed.failure
          yield* emptyDirectory(prepared, op, chosen.force === true)

          return yield* target(once)
        }) as Caller["remove"],
        rename: Effect.fn("Caller.rename")(function*(fromInput, toInput) {
          const op = OpContext.make("rename")
          // Both inputs prepare before either resolves, so a malformed destination outranks a missing source.
          const from = yield* Effect.fromResult(prepareEntry(fromInput, op))
          const to = yield* Effect.fromResult(prepareEntry(toInput, op))

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const source = yield* resolveEntry(from, op)
              const destination = yield* resolveEntry(to, op)

              return yield* renameEntry(source, destination, op)
            })
          )
        }),
        chmod: Effect.fn("Caller.chmod")(function*(input, mode) {
          const op = OpContext.make("chmod")
          const target = asTarget(input)

          if (!isMode(mode)) return yield* op.fail("InvalidArgument")
          yield* changeAttributes(() => asResolvedNode(target, op), { mode }, op)
        }),
        chown: Effect.fn("Caller.chown")(function*(input, owner) {
          const op = OpContext.make("chown")
          const target = asTarget(input)
          const decoded = yield* decodeOwnerUpdate(owner).pipe(Effect.mapError((cause) => fail(op, cause)))
          yield* changeAttributes(() => asResolvedNode(target, op), { owner: decoded }, op)
        }),
        utimes: Effect.fn("Caller.utimes")(function*(input, times) {
          const op = OpContext.make("utimes")
          const target = asTarget(input)
          const decoded = yield* decodeTimes(times).pipe(Effect.mapError((cause) => fail(op, cause)))
          yield* changeAttributes(() => asResolvedNode(target, op), { times: decoded }, op)
        }),
        // A negative length fails before the target resolves, as truncate(2) rejects it before the lookup.
        truncate: Effect.fn("Caller.truncate")(function*(input, length) {
          const op = OpContext.make("truncate")
          const target = asTarget(input)

          if (!isLength(length)) return yield* op.fail("InvalidArgument")
          yield* changeAttributes(() => asResolvedNode(target, op), { size: length }, op)
        }),
        // Every attribute validates before the target resolves, and a failure names the attribute in `field`.
        setattr: Effect.fn("Caller.setattr")(function*(input, attributes) {
          const op = OpContext.make("setattr")
          const target = asTarget(input)

          // A caller outside TypeScript can pass anything, so a non-object fails typed rather than as a defect;
          // the check reads a widened copy so the attributes keep their type below.
          const raw: unknown = attributes

          if (!Predicate.isObject(raw)) return yield* fail(op)
          const unknown = Object.keys(attributes).find((key) => !SETATTR_FIELDS.includes(key))

          if (unknown !== undefined) return yield* fail(op, undefined, unknown)

          if (attributes.size !== undefined && !isLength(attributes.size)) return yield* fail(op, undefined, "size")

          if (attributes.mode !== undefined && !isMode(attributes.mode)) return yield* fail(op, undefined, "mode")

          const owner = attributes.owner === undefined
            ? undefined
            : yield* decodeOwnerUpdate(attributes.owner).pipe(Effect.mapError((cause) => fail(op, cause, "owner")))

          const times = attributes.times === undefined
            ? undefined
            : yield* decodeTimes(attributes.times).pipe(Effect.mapError((cause) => fail(op, cause, "times")))

          const expected = attributes.expected === undefined
            ? undefined
            : yield* decodeExpected(attributes.expected).pipe(Effect.mapError((cause) => fail(op, cause, "expected")))

          yield* changeAttributes(
            () => asResolvedNode(target, op),
            { size: attributes.size, mode: attributes.mode, owner, times, expected },
            op
          )
        }),
        withDirectory: Effect.fn("Caller.withDirectory")(function*(input) {
          const acquired = yield* acquireDirectory(input, OpContext.make("withDirectory"))

          return createCaller(acquired, identity, umask)
        }),
        openDirectory: Effect.fn("Caller.openDirectory")(function*(input) {
          const acquired = yield* acquireDirectory(input, OpContext.make("openDirectory"))
          const statOp = OpContext.make("stat")

          const handle: DirectoryHandle = Object.freeze({
            [DirectoryHandleId]: true as const,
            stat: coordinatedRead(
              statOp,
              Effect.suspend(() => {
                const node = acquired.ino === undefined ? undefined : view(acquired.ino)

                return node === undefined
                  ? Effect.fail(statOp.fail("InvalidHandle"))
                  : Effect.succeed(withMetadata(node))
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

      return caller
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
      watch: Effect.fn("Volume.watch")(function*(options?: WatchOptions) {
        const op = OpContext.make("watch")

        const decoded = yield* Effect.fromResult(
          decodeConfiguration(WatchOptions, options === undefined ? {} : options, "watch")
        )

        const recursive = decoded.recursive ?? true
        const scope = decoded.scope

        const seams = yield* VolumeTestSeams

        // The scope is resolved while the registration holds the volume, so no change lands between the check and
        // the subscription.
        const select = Effect.andThen(
          checkAvailable("watch"),
          scope === undefined
            ? Effect.succeed(recursive ? volumeSelection : scopedSelection(ROOT_INO, false))
            : Effect.map(scopeRoot(scope, op), (root) => scopedSelection(root, recursive))
        )

        const stream = yield* admit(op, watchHub.subscribe(select, seams.afterSubscribe))

        return Stream.map(stream, (event) => event.change)
      }),
      snapshot: coordinatedRead(OpContext.make("snapshot"), Effect.sync(() => Image.make(state))).pipe(
        Effect.withSpan("Volume.snapshot")
      ),
      referenceKey: Effect.fn("Volume.referenceKey")(function*(reference: ObjectReference) {
        const op = OpContext.make("referenceKey")

        return yield* coordinatedRead(
          op,
          Effect.suspend(() => {
            const known = Predicate.isObject(reference) ? objectReferences.get(reference) : undefined

            if (known === undefined) return Effect.fail(op.fail("InvalidReference"))

            if (known.volume !== volumeIdentity) return Effect.fail(op.fail("ForeignReference"))

            if (!addressable(known.ino)) return Effect.fail(op.fail("StaleReference"))

            const ino = BigInt(known.ino)

            return Effect.succeed({ identity: identityBytes.slice(), epoch: epochBytes.slice(), ino, tag: keyTag(ino) })
          })
        )
      }),
      resolveReferenceKey: Effect.fn("Volume.resolveReferenceKey")(function*(key: ReferenceKey) {
        const op = OpContext.make("resolveReferenceKey")

        return yield* coordinatedRead(
          op,
          Effect.suspend(() => {
            if (!Schema.is(ReferenceKey)(key)) return Effect.fail(op.fail("InvalidReference"))

            // Another epoch numbered its objects on its own, so its key is another volume's even under this identity.
            if (!sameBytes(key.identity, identityBytes) || !sameBytes(key.epoch, epochBytes)) {
              return Effect.fail(op.fail("ForeignReference"))
            }

            // Checked before the inode is looked up, so a guessed key learns nothing about which numbers are in use.
            if (!sameTag(key.tag, keyTag(key.ino))) return Effect.fail(op.fail("InvalidReference"))

            const ino = Ino(Number(key.ino))

            return addressable(ino) ? Effect.succeed(referenceFor(ino)) : Effect.fail(op.fail("StaleReference"))
          })
        )
      }),

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
    makeVolume(VolumeSource.Empty(), options, undefined, LiveImage.encode),
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
  const restored = yield* LiveImage.decode(image, maxImageBytes)
  // The image prepared for the candidate the store is about to see; prepare and commit run in sequence under
  // every permit, so one slot carries it between them.
  let prepared: Uint8Array | undefined
  const { limits: stored } = restored
  const commitOp = OpContext.make("commit")

  const limits: VolumeLimits = {
    maxEntries: stored.maxEntries,
    maxBytes: stored.maxBytes === undefined ? undefined : ByteSize.bytes(stored.maxBytes),
    maxFileBytes: ByteSize.bytes(stored.maxFileBytes ?? MAX_FILE_BYTES),
    maxPathBytes: stored.maxPathBytes === undefined ? undefined : ByteSize.bytes(stored.maxPathBytes),
    maxPendingOperations: 64,
    maxWatchEvents: 256
  }

  const { volume, shutdown } = yield* makeVolume(
    VolumeSource.Live({ restored }),
    undefined,
    {
      prepare: (candidate) =>
        LiveImage.encode(candidate, restored, limits).pipe(
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
export const fromSnapshot = Effect.fn("VirtualFileSystem.fromSnapshot")(
  function*(snapshot: Snapshot, options?: VolumeOptions) {
    return (yield* makeVolume(VolumeSource.Restored({ value: yield* Image.valueOf(snapshot) }), options)).volume
  },
  Effect.mapError((error) => retargetFailure("fromSnapshot", error))
)

// An overlay is a volume started from its base's value, plus a fold of that value against the current one.
/** @internal */
export const makeOverlay = Effect.fn("VirtualFileSystem.makeOverlay")(
  function*(base: Snapshot, options?: VolumeOptions) {
    const value = yield* Image.valueOf(base)

    const made = yield* Effect.mapError(
      makeVolume(VolumeSource.Restored({ value }), options),
      (error) => retargetFailure("makeOverlay", error)
    )

    const baseObservation = yield* observeChanges(value)

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
