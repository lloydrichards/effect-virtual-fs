import * as Arr from "effect/Array"
import * as ByteSize from "effect/ByteSize"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Exit from "effect/Exit"
import * as Match from "effect/Match"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import { BytePath } from "../BytePath.js"
import {
  CallerId,
  type Identity,
  MkdirOptions,
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
import type { CommitOutcome } from "../LiveVolume.js"
import { type Metadata, Mode, OwnerUpdate, Times, type TimeUpdate } from "../Metadata.js"
import type { Snapshot } from "../Snapshot.js"
import { type Entry, type EntryInput, isEntry, Target, type TargetInput } from "../Target.js"
import { type FsFailure, make as makeError } from "../VfsError.js"
import type {
  Caller,
  Change,
  DirectoryChange,
  DirectoryHandle,
  FileHandle,
  ObjectReference,
  OpenEntryResult,
  OverlayVolume,
  PathInput,
  Volume,
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
  type VolumeOptions
} from "../Volume.js"
import { WatchOptions } from "../Watch.js"
import { sameBytes } from "./bytes.js"
import * as DirectoryEntries from "./directoryEntries.js"
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
  inputBytes,
  isAttachedBytes,
  isDotComponent,
  joinPath,
  nameBytes,
  ownedPath,
  ROOT_PATH,
  SLASH_BYTE,
  SLASH_HEX
} from "./path.js"
import * as Resolution from "./resolution.js"
import type { PreparedEntry } from "./resolution.js"
import { VolumeTestSeams } from "./testSeams.js"
import * as TokenRegistry from "./tokenRegistry.js"
import type { DirectoryReference, FileReference } from "./tokenRegistry.js"
import { makeTurnstile } from "./turnstile.js"
import * as Limits from "./volumeLimits.js"
import {
  byEntryName,
  type Directory,
  directoryMetadata,
  emptyState,
  getNode,
  Ino,
  type Link,
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

const EXECUTE = 0o1
const WRITE = 0o2
const READ = 0o4
const ANY_EXECUTE = 0o111
const SET_ID_BITS = 0o6000
const STICKY_BIT = 0o1000
const RELATIME_INTERVAL_NS = 86_400_000_000_000n // relatime, as Linux mounts by default: a read refreshes an access time at least this old, 24 hours.

/** @internal */
export interface CommitProvider<State> {
  readonly mode: "memory" | "durable"
  readonly commit: (candidate: State) => Effect.Effect<CommitOutcome, FsFailure & { readonly code: "StorageRejected" }>
  readonly shutdown: Effect.Effect<void>
}

/** @internal */
export const memoryCommitProvider: CommitProvider<VolumeState> = Object.freeze({
  mode: "memory",
  commit: () => Effect.succeed("committed" as const),
  shutdown: Effect.void
})

interface ClassifiedCommit {
  readonly available: boolean
  readonly failure: FsFailure | undefined
}

// An unknown commit outcome stops the volume; definite rejection stops it only during cleanup.
const offerCommit = <State>(
  provider: CommitProvider<State>,
  operation: string,
  candidate: State,
  cleanup: boolean
): Effect.Effect<ClassifiedCommit> =>
  Effect.map(
    Effect.exit(Effect.suspend(() => provider.commit(candidate))),
    (committed): ClassifiedCommit => {
      // TODO(#186): Preserve the cause of a provider defect or interruption.
      if (Exit.isFailure(committed)) {
        if (Cause.hasDies(committed.cause) || Cause.hasInterrupts(committed.cause)) {
          return { available: false, failure: fsFailure("OutcomeUnknown", operation) }
        }

        const failure = Cause.findErrorOption(committed.cause)

        return Option.isSome(failure)
          ? { available: !cleanup, failure: failure.value }
          : { available: false, failure: fsFailure("OutcomeUnknown", operation) }
      }

      if (committed.value === "rejected") {
        return { available: !cleanup, failure: fsFailure("StorageRejected", operation) }
      }

      if (committed.value === "unknown") {
        return { available: false, failure: fsFailure("OutcomeUnknown", operation) }
      }

      return { available: true, failure: undefined }
    }
  )

const WALK_CHUNK_ENTRIES = 128
const MAX_FILE_OFFSET = 0x7fffffffffffffffn

const isMode = Schema.is(Mode)

const isNatural = Schema.is(Schema.Natural)

const isLength = Schema.is(SetattrOptions.fields.size.schema)

const inGroup = Resolution.inGroup

const isTimestamp = Schema.is(MetadataDomain.Timestamp)

const isSeekMode = Schema.is(SeekMode)

const decodeOwnerUpdate = Schema.decodeEffect(OwnerUpdate, { onExcessProperty: "error" })

const decodeTimes = Schema.decodeEffect(Times, { onExcessProperty: "error" })

const decodeExpected = Schema.decodeEffect(SetattrOptions.fields.expected.schema, { onExcessProperty: "error" })

const SETATTR_FIELDS: ReadonlyArray<string> = Object.keys(SetattrOptions.fields)

type Attributes = { readonly [K in keyof SetattrOptions]?: SetattrOptions[K] | undefined }

const timeAt = (update: TimeUpdate | undefined, value: bigint, now: bigint) =>
  update === undefined ? value : Match.value(update).pipe(
    Match.discriminator("kind")("omit", () => value),
    Match.discriminator("kind")("now", () => now),
    Match.discriminator("kind")("value", ({ nanoseconds }) => nanoseconds),
    Match.exhaustive
  )

const decodeWriteFileOptions = Schema.decodeEffect(WriteFileOptions, { onExcessProperty: "error" })

const decodeOpenOptions = Schema.decodeEffect(OpenOptions, { onExcessProperty: "error" })

const decodeMkdirOptions = Schema.decodeEffect(MkdirOptions, { onExcessProperty: "error" })

const decodeSymlinkOptions = Schema.decodeEffect(SymlinkOptions, { onExcessProperty: "error" })

const decodeWalkOptions = Schema.decodeEffect(WalkOptions, { onExcessProperty: "error" })

const decodeRemoveOptions = Schema.decodeEffect(RemoveOptions, { onExcessProperty: "error" })

const decodeOpenEntryOptions = Schema.decodeEffect(OpenEntryOptions, { onExcessProperty: "error" })

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

interface Accessed<A> {
  readonly value: A
  readonly access: Access | undefined
}

const refreshDue = <A>(read: Accessed<A>): read is Accessed<A> & { readonly access: Access } =>
  read.access !== undefined && accessDue(read.access.node.metadata, read.access.now)

interface WalkFrame {
  readonly ino: Ino
  readonly kind: Node["kind"]
  readonly name: Uint8Array
  readonly key: string
  readonly path: Uint8Array
  readonly parent: Ino
  readonly up: WalkFrame | undefined
  readonly depth: number
  readonly bytes: bigint
  readonly reference: ObjectReference
  readonly directory: ObjectReference
  readonly listed: boolean
}

interface WalkPlan<E = never> {
  readonly order: "pre" | "post"
  readonly limit: (
    frame: WalkFrame,
    progress: { readonly entries: number; readonly bytes: bigint },
    phase: "entry" | "directory"
  ) => E | undefined
}

interface ResolvedEntry {
  readonly parent: Ino
  readonly name: string | undefined
  readonly trailingSlash: boolean
  readonly addressing: "path" | "entry"
  readonly op: OpContext
}

interface ResolvedNode {
  readonly ino: Ino
  readonly op: OpContext
}

// One change gets one draft service. Its MutableRef contains the candidate and all
// actions that may become visible only after the candidate is installed.
interface DraftState {
  readonly owner: InodeTable.Owner
  readonly pending: Map<Ino, Node | undefined>
  readonly opens: ReadonlyMap<Ino, number> | undefined
  readonly nextInode: Ino
  readonly changed: boolean
  readonly finished: VolumeState | undefined
  readonly entries: number
  readonly usedBytes: bigint
  readonly events: Array<(installed: VolumeState) => Iterable<WatchEvent>>
  readonly after: Array<() => void>
  readonly removed: Array<Ino>
}

interface DraftOperations {
  readonly revision: bigint
  readonly get: (ino: Ino) => Effect.Effect<Node | undefined>
  readonly put: (node: Node) => Effect.Effect<void>
  readonly putQuiet: (node: Node) => Effect.Effect<void>
  readonly unchanged: Effect.Effect<boolean>
  readonly remove: (ino: Ino) => Effect.Effect<void>
  readonly allocate: Effect.Effect<Ino>
  readonly canAllocate: Effect.Effect<boolean>
  readonly openCount: (ino: Ino) => Effect.Effect<number>
  readonly retain: (ino: Ino) => Effect.Effect<void>
  readonly release: (ino: Ino) => Effect.Effect<number>
  readonly entries: Effect.Effect<number>
  readonly addEntries: (amount: number) => Effect.Effect<void>
  readonly usedBytes: Effect.Effect<bigint>
  readonly addUsedBytes: (amount: bigint) => Effect.Effect<void>
  readonly publish: (event: (installed: VolumeState) => Iterable<WatchEvent>) => Effect.Effect<void>
  readonly afterInstall: (action: () => void) => Effect.Effect<void>
  readonly finish: Effect.Effect<VolumeState>
  readonly actions: Effect.Effect<Pick<DraftState, "events" | "after" | "removed">>
}

class Draft extends Context.Service<Draft, DraftOperations>()("@effect-vfs/core/internal/virtualFileSystem/Draft", {
  make: Effect.fnUntraced(function*(base: VolumeState) {
    const revision = base.revision + 1n

    const cell = MutableRef.make<DraftState>({
      owner: Symbol(),
      pending: new Map(),
      opens: undefined,
      nextInode: base.nextInode,
      changed: false,
      finished: undefined,
      entries: base.entries,
      usedBytes: base.usedBytes,
      events: [],
      after: [],
      removed: []
    })

    const get = (ino: Ino) =>
      Effect.sync(() => {
        const draft = MutableRef.get(cell)

        return draft.pending.has(ino) ? draft.pending.get(ino) : InodeTable.get(base.inodes, ino)
      })

    const openCount = (ino: Ino) => Effect.sync(() => MutableRef.get(cell).opens?.get(ino) ?? base.open.get(ino) ?? 0)

    const put = (node: Node, changed: boolean) =>
      Effect.sync(() => {
        MutableRef.update(cell, (draft) => {
          // This map belongs only to this transition. Copying it on every inode write makes recursive changes quadratic.
          draft.pending.set(node.ino, changed ? { ...node, revision } : node)

          return { ...draft, changed: draft.changed || changed }
        })
      })

    return {
      revision,
      get,
      put: (node: Node) => put(node, true),
      putQuiet: (node: Node) => put(node, false),
      unchanged: Effect.sync(() => {
        const draft = MutableRef.get(cell)

        return draft.pending.size === 0 && draft.opens === undefined && draft.nextInode === base.nextInode &&
          draft.entries === base.entries && draft.usedBytes === base.usedBytes
      }),
      remove: (ino: Ino) =>
        Effect.sync(() => {
          const draft = MutableRef.get(cell)
          draft.pending.set(ino, undefined)
          draft.removed.push(ino)
        }),
      allocate: Effect.sync(() => {
        const next = MutableRef.get(cell).nextInode
        MutableRef.update(cell, (draft) => ({ ...draft, nextInode: Ino(next + 1) }))

        return next
      }),
      canAllocate: Effect.sync(() => MutableRef.get(cell).nextInode < Number.MAX_SAFE_INTEGER),
      openCount,
      retain: (ino: Ino) =>
        Effect.sync(() => {
          const count = MutableRef.get(cell).opens?.get(ino) ?? base.open.get(ino) ?? 0
          MutableRef.update(cell, (draft) => ({ ...draft, opens: new Map(draft.opens).set(ino, count + 1) }))
        }),
      release: (ino: Ino) =>
        Effect.sync(() => {
          const count = (MutableRef.get(cell).opens?.get(ino) ?? base.open.get(ino) ?? 0) - 1
          MutableRef.update(cell, (draft) => ({ ...draft, opens: new Map(draft.opens).set(ino, Math.max(0, count)) }))

          return count
        }),
      entries: Effect.sync(() => MutableRef.get(cell).entries),
      addEntries: (amount: number) =>
        Effect.sync(() => {
          MutableRef.update(cell, (draft) => ({ ...draft, entries: draft.entries + amount }))
        }),
      usedBytes: Effect.sync(() => MutableRef.get(cell).usedBytes),
      addUsedBytes: (amount: bigint) =>
        Effect.sync(() => {
          MutableRef.update(cell, (draft) => ({ ...draft, usedBytes: draft.usedBytes + amount }))
        }),
      publish: (event: (installed: VolumeState) => Iterable<WatchEvent>) =>
        Effect.sync(() => {
          MutableRef.get(cell).events.push(event)
        }),
      afterInstall: (action: () => void) =>
        Effect.sync(() => {
          MutableRef.get(cell).after.push(action)
        }),
      finish: Effect.sync(() => {
        const draft = MutableRef.get(cell)

        if (draft.finished !== undefined) return draft.finished
        let inodes = base.inodes

        for (const [ino, node] of draft.pending) inodes = InodeTable.set(inodes, ino, node, draft.owner)
        let open = base.open

        if (draft.opens !== undefined) {
          const next = new Map(base.open)

          for (const [ino, count] of draft.opens) {
            if (count > 0) next.set(ino, count)
            else next.delete(ino)
          }

          open = next
        }

        const finished: VolumeState = {
          inodes,
          open,
          nextInode: draft.nextInode,
          revision: draft.changed ? revision : base.revision,
          entries: draft.entries,
          usedBytes: draft.usedBytes
        }

        MutableRef.update(cell, (current) => ({ ...current, finished }))

        return finished
      }),
      actions: Effect.sync(() => {
        const { events, after, removed } = MutableRef.get(cell)

        return { events, after, removed }
      })
    }
  })
}) {}

const withMetadata = (node: Node): Metadata => ({ ...node.metadata, revision: node.revision })

const withEntries = (directory: Directory, entries: ReadonlyMap<string, Ino>): Directory => ({ ...directory, entries })

const withoutLink = (links: ReadonlyArray<Link>, parent: Ino, name: string): ReadonlyArray<Link> => {
  const index = links.findIndex((link) => link.parent === parent && link.name === name)

  return index < 0 ? links : [...links.slice(0, index), ...links.slice(index + 1)]
}

type VolumeSource =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Live"; readonly restored: LiveImage.Restored }
  | { readonly _tag: "Restored"; readonly value: VolumeState }

/** @internal */
export const VolumeSource = Data.taggedEnum<VolumeSource>()

const UpdateChange = Schema.TaggedStruct("Update", { path: BytePath })

const RescanChange = Schema.TaggedStruct("Rescan", { path: BytePath })

const RemoveChange = Schema.TaggedStruct("Remove", { path: BytePath })

interface WatchEvent {
  readonly change: Change
  readonly parent: Ino
  readonly ino: Ino
}

interface Installation {
  readonly before: VolumeState
  readonly after: VolumeState
}

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

const randomHex128 = Effect.gen(function*() {
  const crypto = yield* Crypto.Crypto

  return Hex.encode(yield* crypto.randomBytes(16))
}).pipe(Effect.orDie)

/** @internal */
export const makeVolume = Effect.fnUntraced(
  function*(
    source: VolumeSource,
    commitProvider: CommitProvider<VolumeState>,
    options?: VolumeOptions,
    durability: VolumeDurability = "memory-only"
  ) {
    const services = yield* Effect.context<Crypto.Crypto>()
    // These accessors run inside synchronous transition callbacks. The runner is reached only when an invariant fails.
    const dieInvariant = (message: string): never => Effect.runSyncWith(services)(Effect.die(message))
    const live = Predicate.isTagged("Live")(source) ? source.restored : undefined
    const decoded = yield* Effect.fromResult(Limits.configuration(options))
    const requested = decoded.limits
    const limits = live === undefined ? requested : yield* Effect.fromResult(Limits.fromStored(live.limits, requested))

    const identity = live?.identity ?? (decoded.identity === undefined
      ? VolumeIdentity.make(yield* randomHex128)
      : decoded.identity)

    const incarnation = VolumeIncarnation.make(yield* randomHex128)
    const epoch = live === undefined ? VolumeEpoch.make(yield* randomHex128) : live.epoch
    const keySecret = live === undefined ? KeySecret.make(yield* randomHex128) : live.keySecret
    const identityBytes = Result.getOrThrow(Hex.decode(identity))
    const epochBytes = Result.getOrThrow(Hex.decode(epoch))
    const keySecretBytes = Result.getOrThrow(Hex.decode(keySecret))
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
    const directoryHolds = new Map<Ino, number>()

    const maxPendingOperations = limits.maxPendingOperations
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

    let state = emptyState(initialTime)
    const maxFileBytes = Number(ByteSize.toBigInt(limits.maxFileBytes))

    if (Predicate.isTagged("Restored")(source)) {
      const restored = yield* reachableValue(source.value)

      if (restored.largestFile > maxFileBytes) {
        return yield* imageFailure("snapshot", "LimitExceeded", { field: "maxFileBytes" })
      }

      if (
        (limits.maxEntries !== undefined && restored.state.entries > limits.maxEntries) ||
        (limits.maxBytes !== undefined && restored.state.usedBytes > ByteSize.toBigInt(limits.maxBytes))
      ) {
        return yield* imageFailure("snapshot", "LimitExceeded", { field: "volume" })
      }

      state = restored.state
    }

    if (live !== undefined) state = live.value

    const view = (ino: Ino): Effect.Effect<Node | undefined> =>
      Effect.flatMap(
        Effect.serviceOption(Draft),
        (draft) => Option.isSome(draft) ? draft.value.get(ino) : Effect.sync(() => getNode(state, ino))
      )

    const registry = TokenRegistry.make(volumeIdentity, view)
    const referenceFor = registry.referenceFor
    const makeFileReference = registry.file
    const makeDirectoryReference = registry.directory

    let available = true

    const checkAvailable = (operation: string) =>
      Effect.suspend(() => available ? Effect.void : Effect.fail(fsFailure("VolumeUnavailable", operation)))

    const watchCoordinate: WatchHub.Coordinator = (effect) => changing(effect)

    const watchHub = yield* WatchHub.make<WatchEvent, Installation, FsFailure>(
      watchCoordinate,
      limits.maxWatchEvents
    )

    const install = Effect.fnUntraced(function*(finished: DraftOperations) {
      const before = state
      state = yield* finished.finish
      const actions = yield* finished.actions

      for (const ino of actions.removed) registry.forget(ino)

      for (const apply of actions.after) apply()

      const after = state

      watchHub.publishUnsafe(() => actions.events.flatMap((events) => Array.from(events(after))), { before, after })
    })

    const transition = Effect.fnUntraced(function*<A, E, R>(change: Effect.Effect<A, E, R>) {
      const current = yield* Draft.make(state)
      const value = yield* Effect.provideService(change, Draft, current)

      return [value, current] as const
    })

    // Cleanup releases local ownership even when storage refuses; that divergence disables the volume.
    const committed = Effect.fnUntraced(function*(
      op: OpContext,
      finished: DraftOperations,
      cleanup: boolean
    ) {
      if ((yield* finished.unchanged) || (cleanup && !available)) return yield* install(finished)
      const next = yield* finished.finish
      const answer = yield* offerCommit(commitProvider, op.operation, next, cleanup)

      if (!answer.available) available = false

      if (answer.failure !== undefined) {
        if (cleanup) yield* install(finished)

        return yield* answer.failure
      }

      yield* install(finished)
    })

    const applyCleanup = Effect.fnUntraced(function*(
      change: (draft: DraftOperations) => Effect.Effect<void, never, Draft>
    ) {
      const current = yield* Draft.make(state)
      yield* Effect.provideService(change(current), Draft, current)
      yield* committed(OpContext.make("close"), current, true)
    })

    const annotateFailure = (error: VfsError) =>
      Effect.annotateCurrentSpan({ operation: error.operation, code: error.code })

    // Permit waits stay interruptible. Memory transitions are masked; durable transitions remain
    // interruptible until the candidate is ready. Every provider commit and installation is masked.
    const coordinated = <A, E, R>(
      op: OpContext,
      effect: Effect.Effect<A, E, R>,
      cleanup = false
    ) =>
      admit(
        op,
        changing(Effect.uninterruptibleMask((restore) => {
          const staged = transition(Effect.andThen(checkAvailable(op.operation), effect))

          return Effect.flatMap(
            commitProvider.mode === "memory" ? staged : restore(staged),
            ([value, finished]) => Effect.as(committed(op, finished, cleanup), value)
          )
        }))
      ).pipe(Effect.tapError((error) => Schema.is(VfsError)(error) ? annotateFailure(error) : Effect.void))

    const coordinatedRead = <A, E, R>(op: OpContext, effect: Effect.Effect<A, E, R>) =>
      admit(op, observing(Effect.andThen(checkAvailable(op.operation), effect))).pipe(
        Effect.tapError((error) => Schema.is(VfsError)(error) ? annotateFailure(error) : Effect.void)
      )

    const refreshAccess = Effect.fnUntraced(function*<A>(read: Accessed<A>) {
      if (refreshDue(read)) {
        const { node, now } = read.access
        const draft = yield* Draft
        yield* draft.putQuiet({ ...node, metadata: { ...node.metadata, atimeNs: now } })
      }

      return read.value
    })

    // A read that may refresh an access time. It observes under one permit, so reads run beside each other, and
    // only when the access time is due does it run again as a change. The change repeats every check and the rule,
    // since another read may have refreshed the time meanwhile, and its result is the one returned.
    const accessing = <A, E, R>(op: OpContext, read: Effect.Effect<Accessed<A>, E, R>) =>
      Effect.flatMap(
        coordinatedRead(op, read),
        (observed) =>
          refreshDue(observed)
            ? coordinated(op, Effect.flatMap(read, refreshAccess))
            : Effect.succeed(observed.value)
      )

    const coordinatedCleanup = <A, E, R>(effect: Effect.Effect<A, E, R>) => changing(Effect.uninterruptible(effect))

    const shutdown = commitProvider.mode === "memory" ? commitProvider.shutdown : changing(Effect.uninterruptible(
      Effect.andThen(
        Effect.sync(() => {
          available = false
        }),
        commitProvider.shutdown
      )
    ))

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

    const pathOfCurrent = Effect.fnUntraced(function*(ino: Ino) {
      const names: Array<string> = []
      const first = yield* view(ino)

      if (first?.kind !== "directory" || first.metadata.nlink === 0) return undefined
      let node: Directory = first

      while (node.ino !== ROOT_INO) {
        names.push(node.name)
        const parent: Node | undefined = yield* view(node.parent)

        if (parent?.kind !== "directory" || parent.metadata.nlink === 0) return undefined
        node = parent
      }

      return SLASH_HEX + names.reverse().join(SLASH_HEX)
    })

    const entryPath = (prefix: string, name: string) =>
      ownedPath(nameBytes(prefix + (prefix === SLASH_HEX ? "" : SLASH_HEX) + name))

    const publishEntry = (_tag: Exclude<Change["_tag"], "Rescan">, parent: Ino, name: string, ino: Ino) =>
      Effect.flatMap(Draft, (draft) =>
        draft.publish((installed) => {
          const prefix = pathOf((at) => getNode(installed, at), parent)

          return prefix === undefined ? [] : [{ change: { _tag, path: entryPath(prefix, name) }, parent, ino }]
        }))

    const publishNode = Effect.fnUntraced(function*(ino: Ino) {
      const draft = yield* Draft
      const target = yield* draft.get(ino)

      if (target === undefined) return

      if (target.kind === "directory") {
        yield* draft.publish((installed) => {
          const directory = getNode(installed, ino)
          const path = pathOf((at) => getNode(installed, at), ino)

          return path === undefined || directory?.kind !== "directory"
            ? []
            : [{ change: UpdateChange.make({ path: ownedPath(nameBytes(path)) }), parent: directory.parent, ino }]
        })

        return
      }

      const links = target.links
      yield* draft.publish((installed) => {
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
    })

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

    const scopeRoot = Effect.fnUntraced(function*(scope: ObjectReference, op: OpContext) {
      const node = yield* TokenRegistry.nodeOrFail(yield* registry.resolve(scope, "reference"), "reference", op)

      return node.metadata.nlink === 0 ? yield* op.fail("StaleReference") : node.ino
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

    const keyTag = (ino: bigint): Uint8Array => {
      const message = new Uint8Array(40)
      message.set(identityBytes)
      message.set(epochBytes, 16)
      new DataView(message.buffer).setBigUint64(32, ino)

      return hmacSha256(keySecretBytes, message).subarray(0, 16)
    }

    const holdDirectory = (ino: Ino) => {
      directoryHolds.set(ino, (directoryHolds.get(ino) ?? 0) + 1)
    }

    const unholdDirectory = Effect.fnUntraced(function*(ino: Ino) {
      const count = (directoryHolds.get(ino) ?? 1) - 1

      if (count > 0) {
        directoryHolds.set(ino, count)

        return
      }

      directoryHolds.delete(ino)
      const node = getNode(state, ino)

      if (node?.kind === "directory" && node.metadata.nlink === 0) {
        yield* applyCleanup((d) => d.remove(ino))
      }
    })

    const releaseDirectory = (reference: DirectoryReference) =>
      TokenRegistry.release(reference, unholdDirectory, (action) => Effect.sync(action))

    const finalizeDirectory = (reference: DirectoryReference) => {
      const close = coordinatedCleanup(releaseDirectory(reference))

      return TokenRegistry.finalize(reference, close, Effect.ignore(close))
    }

    const closeReleasedScope = TokenRegistry.closeReleasedScope

    const permitted = Resolution.permitted
    const authorize = Resolution.authorize

    const reclaim = Effect.fnUntraced(function*(d: DraftOperations, ino: Ino) {
      const node = yield* d.get(ino)

      if (node === undefined) return

      if (node.kind === "file") {
        if (node.links.length > 0 || (yield* d.openCount(ino)) > 0) return
        yield* d.addUsedBytes(-BigInt(node.data.length))
      } else if (node.kind === "symlink") {
        if (node.links.length > 0) return
        yield* d.addUsedBytes(-BigInt(node.target.length))
      } else if (node.metadata.nlink > 0 || directoryHolds.has(ino)) return
      yield* d.remove(ino)
    })

    const atEntryLimit = Effect.gen(function*() {
      const draft = yield* Draft

      return limits.maxEntries !== undefined && (yield* draft.entries) >= limits.maxEntries
    })

    const reserveEntry = Effect.fnUntraced(function*(op: OpContext) {
      const draft = yield* Draft

      if ((yield* atEntryLimit) || !(yield* draft.canAllocate)) return yield* op.fail("NoSpace")
    })

    const reserveInode = (op: OpContext) =>
      Effect.flatMap(
        Draft,
        (draft) =>
          Effect.flatMap(draft.canAllocate, (available) => available ? Effect.void : Effect.fail(op.fail("NoSpace")))
      )

    const reserveBytes = Effect.fnUntraced(function*(op: OpContext, bytes: bigint) {
      if (limits.maxBytes === undefined) return
      const draft = yield* Draft

      if (bytes > ByteSize.toBigInt(limits.maxBytes) - (yield* draft.usedBytes)) {
        return yield* op.fail("NoSpace")
      }
    })

    const attach = Effect.fnUntraced(function*(parent: Directory, name: string, child: Node, now: bigint) {
      const d = yield* Draft
      yield* d.put(withEntries(
        {
          ...parent,
          metadata: {
            ...parent.metadata,
            nlink: parent.metadata.nlink + (child.kind === "directory" ? 1 : 0),
            mtimeNs: now,
            ctimeNs: now
          }
        },
        DirectoryEntries.set(parent.entries, name, child.ino)
      ))

      if (child.kind === "directory") yield* d.put({ ...child, parent: parent.ino, name })
      else {
        yield* d.put({
          ...child,
          links: [...child.links, { parent: parent.ino, name }],
          metadata: { ...child.metadata, nlink: child.links.length + 1, ctimeNs: now }
        })
      }
    })

    const detach = Effect.fnUntraced(function*(child: Node, parent: Ino, name: string, now: bigint) {
      const d = yield* Draft

      if (child.kind === "directory") {
        yield* d.put({ ...child, metadata: { ...child.metadata, nlink: 0, ctimeNs: now } })
      } else {
        const links = withoutLink(child.links, parent, name)
        yield* d.put({ ...child, links, metadata: { ...child.metadata, nlink: links.length, ctimeNs: now } })
      }

      yield* reclaim(d, child.ino)
    })

    const releaseFileInode = Effect.fnUntraced(function*(ino: Ino) {
      const d = yield* Draft
      yield* d.release(ino)
      yield* reclaim(d, ino)
    })

    const releaseFile = (ref: FileReference) =>
      TokenRegistry.release(ref, releaseFileInode, (action) => Effect.sync(action))

    const releaseOpenFile = (ref: FileReference) =>
      Effect.ignore(
        coordinatedCleanup(Effect.suspend(() =>
          TokenRegistry.inode(ref) === undefined ? Effect.void : applyCleanup(() => releaseFile(ref))
        ))
      )

    // Admission refusal leaves the handle open. Every admitted close shares the registry release,
    // and a storage failure still completes cleanup while only explicit close reports the failure.
    const closeFile = (ref: FileReference, op: OpContext, check: Effect.Effect<unknown, FsFailure>) =>
      coordinated(
        op,
        Effect.andThen(
          check,
          TokenRegistry.release(
            ref,
            releaseFileInode,
            (action) => Effect.flatMap(Draft, (draft) => draft.afterInstall(action))
          )
        ),
        true
      ).pipe(Effect.tapError((error) => error.code === "VolumeBusy" ? Effect.void : releaseOpenFile(ref)))

    const finalizeFile = (ref: FileReference) =>
      TokenRegistry.finalize(ref, closeFile(ref, OpContext.make("close"), Effect.void), releaseOpenFile(ref))

    const acquireHandle = TokenRegistry.acquire

    const bindFile = (ref: FileReference, ino: Ino) =>
      Effect.flatMap(Draft, (draft) => draft.afterInstall(() => TokenRegistry.publish(ref, ino)))

    const replaceContent = Effect.fnUntraced(function*(
      file: RegularFile,
      data: Uint8Array,
      now: bigint,
      publish = true
    ) {
      const d = yield* Draft
      yield* d.addUsedBytes(BigInt(data.length - file.data.length))
      yield* d.put({
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

      if (publish) yield* publishNode(file.ino)
    })

    const resizeAt = Effect.fnUntraced(function*(file: RegularFile, length: bigint, now: bigint, op: OpContext) {
      if (length > BigInt(maxFileBytes)) return yield* op.fail("FileTooLarge")
      const size = Number(length)

      yield* reserveBytes(op, BigInt(size - file.data.length))

      const data = new Uint8Array(size)
      data.set(file.data.subarray(0, size))
      yield* replaceContent(file, data, now, false)
    })

    const resize = Effect.fnUntraced(function*(file: RegularFile, length: bigint, op: OpContext) {
      if (!isLength(length)) return yield* op.fail("InvalidArgument")

      yield* resizeAt(file, length, yield* timestamp(op), op)
      yield* publishNode(file.ino)
    })

    const fileHandle = (ref: FileReference): FileHandle => {
      const get = Effect.fnUntraced(function*(op: OpContext, access?: "read" | "write") {
        const ino = TokenRegistry.inode(ref)
        const node = ino === undefined ? undefined : yield* view(ino)

        if (
          node?.kind !== "file" || (access === "read" && ref.access === "write") ||
          (access === "write" && ref.access === "read")
        ) return yield* op.fail("InvalidHandle")

        return node
      })

      const read = (maximum: number, position?: bigint) => {
        const op = OpContext.make(position === undefined ? "read" : "pread")
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
          Effect.gen(function*() {
            const { bytes, eof, next } = yield* refreshAccess(yield* body)
            const draft = yield* Draft
            yield* draft.afterInstall(() => {
              ref.offset = next
            })

            return { bytes, eof }
          })
        )
      }

      const write = Effect.fnUntraced(function*(input: Uint8Array, position?: bigint) {
        const op = OpContext.make(position === undefined ? "write" : "pwrite")
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

            const draft = yield* Draft

            const free = limits.maxBytes === undefined
              ? BigInt(maxFileBytes)
              : ByteSize.toBigInt(limits.maxBytes) - (yield* draft.usedBytes)

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
            yield* replaceContent(file, data, now)

            if (position === undefined) {
              const next = offset + BigInt(count)
              yield* draft.afterInstall(() => {
                ref.offset = next
              })
            }

            return count
          })
        )
      })

      const statOp = OpContext.make("stat")
      const syncOp = OpContext.make("sync")
      const closeOp = OpContext.make("close")

      const handle: FileHandle = Object.freeze({
        [FileHandleId]: true as const,
        read: Effect.fnUntraced(function*(maximum: number) {
          return (yield* read(maximum)).bytes
        }),
        pread: Effect.fnUntraced(function*(maximum: number, offset: bigint) {
          return yield* read(maximum, offset)
        }),
        write: Effect.fnUntraced(function*(bytes: Uint8Array) {
          return yield* write(bytes)
        }),
        pwrite: Effect.fnUntraced(function*(bytes: Uint8Array, offset: bigint) {
          return yield* write(bytes, offset)
        }),
        seek: Effect.fnUntraced(function*(offset: bigint, mode: SeekMode) {
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
        truncate: Effect.fnUntraced(function*(length: bigint) {
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
        ),
        sync: coordinatedRead(syncOp, Effect.suspend(() => Effect.asVoid(get(syncOp)))),
        close: closeFile(ref, closeOp, Effect.suspend(() => get(closeOp))).pipe(
          Effect.ensuring(closeReleasedScope(ref))
        )
      })

      registry.registerFile(handle, ref)

      return handle
    }

    const createCaller = (reference: DirectoryReference, identity: Identity, umask: number): Caller => {
      const resolver = Resolution.make({
        caller: reference,
        get: view,
        identity,
        maxPathBytes: limits.maxPathBytes,
        registry
      })

      const prepare = resolver.prepare
      const prepareEntry = resolver.prepareEntry
      const entryName = Resolution.entryName

      const resolveTarget = (
        target: Target,
        op: OpContext,
        options?: Omit<Resolution.NodeMode, "kind" | "createMissing">
      ) => resolver.resolve(target, { kind: "Node", ...options }, op)

      const resolveDirectory = resolver.directory

      const resolveEntry = (prepared: PreparedEntry, op: OpContext) =>
        resolver.resolve(prepared, { kind: "Parent" }, op)

      const referencedNode = (target: ObjectReference, op: OpContext) =>
        Effect.map(resolveTarget(Target.Reference({ reference: target }), op), (resolved) => resolved.node)

      const directoryNow = Effect.fnUntraced(function*(ino: Ino) {
        const node = yield* view(ino)

        if (node?.kind !== "directory") {
          return dieInvariant("Directory left the inode table during a transition")
        }

        return node
      })

      const nodeNow = Effect.fnUntraced(function*(ino: Ino) {
        const node = yield* view(ino)

        if (node === undefined) return dieInvariant("Inode left the table during a transition")

        return node
      })

      const creationTimes = (times: Times | undefined, now: bigint) => ({
        atimeNs: times?.access.kind === "value" ? times.access.nanoseconds : now,
        mtimeNs: times?.modification.kind === "value" ? times.modification.nanoseconds : now
      })

      const newDirectory = Effect.fnUntraced(function*(parent: Directory, mode: number, now: bigint, times?: Times) {
        const draft = yield* Draft
        const ino = yield* draft.allocate

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
        } satisfies Directory
      })

      const newFile = Effect.fnUntraced(function*(
        parent: Directory,
        data: RegularFile["data"],
        mode: number,
        now: bigint,
        owner?: OwnerUpdate,
        times?: Times
      ) {
        const draft = yield* Draft
        const ino = yield* draft.allocate

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
        } satisfies RegularFile
      })

      const newSymlink = Effect.fnUntraced(
        function*(parent: Directory, target: Uint8Array, now: bigint, times?: Times) {
          const draft = yield* Draft
          const ino = yield* draft.allocate

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
          } satisfies SymbolicLink
        }
      )

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
            const node = yield* nodeNow(resolved.ino)

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
            const sized = yield* nodeNow(resolved.ino)
            const gid = owner?.gid ?? sized.metadata.gid
            const cleared = chowned && sized.kind === "file" ? sized.metadata.mode & ~SET_ID_BITS : sized.metadata.mode

            if (chowned || mode !== undefined || timed) {
              yield* (yield* Draft).put({
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

            yield* publishNode(node.ino)
          })
        )
      }

      const authorizeRemoval = (parent: Directory, child: Node, op: OpContext) =>
        (parent.metadata.mode & STICKY_BIT) !== 0 && !identity.privileged &&
          identity.uid !== parent.metadata.uid && identity.uid !== child.metadata.uid
          ? Effect.fail(op.fail("NotPermitted"))
          : Effect.void

      const claimName = Effect.fnUntraced(function*(
        entry: ResolvedEntry,
        trailingSlash: "allowed" | "rejected" = "allowed"
      ) {
        const parent = yield* directoryNow(entry.parent)

        if (isDotComponent(entry.name)) {
          return yield* entry.op.fail(entry.addressing === "entry" ? "InvalidArgument" : "AlreadyExists")
        }

        yield* authorize(parent, identity, EXECUTE, entry.op)

        if (parent.entries.has(entry.name)) return yield* entry.op.fail("AlreadyExists")

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
        const parent = yield* directoryNow(entry.parent)
        const before = parent.revision
        const now = yield* timestamp(op)

        const mode = request.exactMode
          ? yield* permittedMode({ kind: "directory", uid: identity.uid, gid: parent.metadata.gid }, request.mode, op)
          : (request.mode & 0o777 & ~umask) | (request.mode & STICKY_BIT)

        const child = yield* newDirectory(parent, mode, now, request.times)

        yield* attach(parent, name, child, now)
        const draft = yield* Draft
        yield* draft.addEntries(1)
        yield* publishEntry("Create", parent.ino, name, child.ino)

        return { child: child.ino, directory: { before, after: draft.revision } }
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
        const revisionsBefore = new Map<Ino, bigint>()

        if (prepared.kind === "entry") {
          const entry = yield* resolveEntry(prepared, op)
          const made = yield* Effect.result(makeDirectory(entry, request, op))

          if (Result.isSuccess(made)) return made.success

          const existingIno = entry.name === undefined
            ? undefined
            : (yield* directoryNow(entry.parent)).entries.get(entry.name)

          node = existingIno === undefined ? undefined : (yield* view(existingIno))

          if (made.failure.code !== "AlreadyExists" || node?.kind !== "directory") return yield* made.failure
        } else {
          entryOp = op.at(prepared.path.input)

          const resolved = yield* resolver.resolve(
            Target.Path(
              prepared.base === undefined
                ? { path: prepared.path.input }
                : { path: prepared.path.input, relativeTo: prepared.base }
            ),
            {
              kind: "Node",
              createMissing: (parent, name, final) =>
                Effect.flatMap(
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
            },
            op
          )

          node = resolved.node
        }

        if (node?.kind !== "directory") return yield* entryOp.fail("AlreadyExists")
        const after = (yield* directoryNow(node.parent)).revision

        return { child: node.ino, directory: { before: revisionsBefore.get(node.parent) ?? after, after } }
      })

      const linkNode = Effect.fnUntraced(
        function*(node: Exclude<Node, Directory>, entry: ResolvedEntry, op: OpContext) {
          const name = yield* claimName(entry, "rejected")
          yield* reserveEntry(entry.op)
          const parent = yield* directoryNow(entry.parent)
          const before = parent.revision
          const now = yield* timestamp(op)
          yield* attach(parent, name, node, now)
          const draft = yield* Draft
          yield* draft.addEntries(1)
          yield* publishEntry("Create", parent.ino, name, node.ino)

          return { before, after: draft.revision }
        }
      )

      const makeSymlink = Effect.fnUntraced(function*(
        entry: ResolvedEntry,
        target: Uint8Array,
        times: Times | undefined,
        op: OpContext
      ) {
        const name = yield* claimName(entry, "rejected")
        yield* reserveEntry(entry.op)
        yield* reserveBytes(entry.op, BigInt(target.length))
        const parent = yield* directoryNow(entry.parent)
        const before = parent.revision
        const now = yield* timestamp(op)
        const child = yield* newSymlink(parent, target, now, times)

        yield* attach(parent, name, child, now)
        const draft = yield* Draft
        yield* draft.addEntries(1)
        yield* draft.addUsedBytes(BigInt(target.length))
        yield* publishEntry("Create", parent.ino, name, child.ino)

        return { child: child.ino, directory: { before, after: draft.revision } }
      })

      const removeChild = Effect.fnUntraced(function*(parent: Directory, name: string, child: Node, op: OpContext) {
        const before = parent.revision
        const now = yield* timestamp(op)
        const d = yield* Draft
        yield* d.put(withEntries(
          {
            ...parent,
            metadata: {
              ...parent.metadata,
              nlink: parent.metadata.nlink - (child.kind === "directory" ? 1 : 0),
              mtimeNs: now,
              ctimeNs: now
            }
          },
          DirectoryEntries.remove(parent.entries, name)
        ))
        yield* publishEntry("Remove", parent.ino, name, child.ino)
        yield* detach(child, parent.ino, name, now)
        yield* d.addEntries(-1)

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
        const parent = yield* directoryNow(entry.parent)

        if (isDotComponent(entry.name)) {
          return yield* entry.op.fail(entry.addressing === "entry" ? "InvalidArgument" : dotNameCode)
        }

        yield* authorize(parent, identity, EXECUTE, entry.op)
        const childIno = parent.entries.get(entry.name)
        const child = childIno === undefined ? undefined : (yield* view(childIno))

        if (child === undefined) return yield* entry.op.fail("NotFound")
        const rejected = beforeWrite?.(child)

        if (rejected !== undefined) return yield* rejected
        yield* authorize(parent, identity, WRITE, entry.op)

        return { parent, name: entry.name, child }
      })

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

      const rmdirEntry = Effect.fnUntraced(function*(entry: ResolvedEntry, op: OpContext) {
        const { child, name, parent } = yield* removalTarget(entry, "InvalidArgument")
        yield* authorizeRemoval(parent, child, entry.op)

        if (child.kind !== "directory") return yield* entry.op.fail("NotDirectory")

        if (child.entries.size > 0) return yield* entry.op.fail("NotEmpty")

        return yield* removeChild(parent, name, child, op)
      })

      const renameEntry = Effect.fnUntraced(
        function*(source: ResolvedEntry, destination: ResolvedEntry, op: OpContext) {
          const sourceDirectory = yield* directoryNow(source.parent)
          const destinationDirectory = yield* directoryNow(destination.parent)
          const sameDirectory = source.parent === destination.parent
          const sourceName = source.name
          const destinationName = destination.name

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
          const child = childIno === undefined ? undefined : (yield* view(childIno))

          if (child === undefined) return yield* source.op.fail("NotFound")
          const replacedIno = destinationDirectory.entries.get(destinationName)
          const replaced = replacedIno === undefined ? undefined : (yield* view(replacedIno))

          // A trailing slash on either side asks for a directory; a missing slashed destination is fine when the
          // source is one, as Linux allows.
          if ((source.trailingSlash || destination.trailingSlash) && child.kind !== "directory") {
            return yield* (source.trailingSlash ? source.op : destination.op).fail("NotDirectory")
          }

          if (destination.trailingSlash && replaced !== undefined && replaced.kind !== "directory") {
            return yield* destination.op.fail("NotDirectory")
          }

          const result = Effect.fnUntraced(function*() {
            return sameDirectory
              ? {
                _tag: "SameDirectory" as const,
                directory: { before: sourceBefore, after: (yield* directoryNow(source.parent)).revision }
              }
              : {
                _tag: "DifferentDirectories" as const,
                sourceDirectory: { before: sourceBefore, after: (yield* directoryNow(source.parent)).revision },
                destinationDirectory: {
                  before: destinationBefore,
                  after: (yield* directoryNow(destination.parent)).revision
                }
              }
          })

          for (let ancestor = destinationDirectory;; ancestor = yield* directoryNow(ancestor.parent)) {
            if (ancestor.ino === child.ino) return yield* destination.op.fail("InvalidArgument")

            if (ancestor.ino === ROOT_INO) break
          }

          if (child.ino === replaced?.ino) return yield* result()
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
          const d = yield* Draft

          yield* publishEntry("Remove", sourceDirectory.ino, sourceName, child.ino)
          yield* d.put(withEntries(
            {
              ...sourceDirectory,
              metadata: {
                ...sourceDirectory.metadata,
                nlink: sourceDirectory.metadata.nlink - (child.kind === "directory" ? 1 : 0),
                mtimeNs: now,
                ctimeNs: now
              }
            },
            DirectoryEntries.remove(sourceDirectory.entries, sourceName)
          ))

          const destinationNow = yield* directoryNow(destination.parent)
          yield* d.put(withEntries(
            {
              ...destinationNow,
              metadata: {
                ...destinationNow.metadata,
                nlink: destinationNow.metadata.nlink + (child.kind === "directory" && replaced === undefined ? 1 : 0),
                mtimeNs: now,
                ctimeNs: now
              }
            },
            DirectoryEntries.set(destinationNow.entries, destinationName, child.ino)
          ))

          const moved = yield* nodeNow(child.ino)

          if (moved.kind === "directory") {
            yield* d.put({
              ...moved,
              parent: destination.parent,
              name: destinationName,
              metadata: { ...moved.metadata, ctimeNs: now }
            })
          } else {
            yield* d.put({
              ...moved,
              links: [
                ...withoutLink(moved.links, source.parent, sourceName),
                { parent: destination.parent, name: destinationName }
              ],
              metadata: { ...moved.metadata, ctimeNs: now }
            })
          }

          if (replaced !== undefined) {
            yield* detach(yield* nodeNow(replaced.ino), destination.parent, destinationName, now)
            yield* d.addEntries(-1)
          }

          yield* publishEntry("Create", destination.parent, destinationName, child.ino)

          return yield* result()
        }
      )

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

      type NamedEntry = ResolvedEntry & { readonly name: string }

      const openFile = Effect.fnUntraced(function*(
        entry: NamedEntry,
        found: Node | undefined,
        request: OpenRequest,
        acquired: FileReference,
        op: OpContext
      ) {
        const { name } = entry
        const parent = yield* directoryNow(entry.parent)
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

          file = yield* newFile(parent, new Uint8Array(Number(size)), mode, now, owner, request.times)
          yield* attach(parent, name, file, now)
          const draft = yield* Draft
          yield* draft.addEntries(1)
          yield* draft.addUsedBytes(size)
          created = true
          yield* publishEntry("Create", parent.ino, name, file.ino)
        } else {
          if (file.kind === "symlink") return yield* entry.op.fail("SymlinkLoop")

          if (file.kind !== "file") return yield* entry.op.fail("IsDirectory")
          yield* openExisting(file, request, entry.op, op)
        }

        yield* (yield* Draft).retain(file.ino)
        yield* bindFile(acquired, file.ino)

        return { ino: file.ino, created, directory: { before, after: (yield* directoryNow(entry.parent)).revision } }
      })

      const releasePending = (opened: () => Ino | undefined) => () =>
        Effect.gen(function*() {
          const ino = opened()

          if (ino === undefined) return
          yield* releaseFileInode(ino)
        })

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

      const asResolvedNode = (target: Target, op: OpContext, options?: { readonly followFinalSymlink?: boolean }) =>
        Effect.map(
          resolveTarget(target, op, options),
          (resolved): ResolvedNode => ({ ino: resolved.node.ino, op: resolved.op })
        )

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
            TokenRegistry.publish(acquired, directory.node.ino)

            return acquired
          }),
          // Nothing to undo here: the finalizer that follows an interrupted acquisition releases the hold under
          // every permit, where a detached directory may leave the table.
          () => Effect.void,
          finalizeDirectory(acquired)
        )
      })

      const fail = (op: OpContext, cause?: unknown, field?: string) =>
        op.fail("InvalidArgument", field === undefined ? { cause } : { cause, field })

      const preparedOp = (prepared: PreparedEntry, op: OpContext) =>
        prepared.kind === "path" ? op.at(prepared.path.input) : op

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

                const resolved = yield* resolver.resolve({ kind: "path", path, base: target.relativeTo }, {
                  kind: "OrCreate",
                  create: chosen.create ?? "never",
                  finalSymlink: follow ? "follow" : "preserve"
                }, op)

                const { parent, name } = resolved

                if (resolved.kind === "missing" && path.trailingSlash) return yield* pathOp.fail("IsDirectory")
                yield* authorize(parent, identity, EXECUTE, pathOp)
                const file = resolved.kind === "existing" ? resolved.node : undefined

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
              const draft = yield* Draft
              yield* draft.retain(node.ino)
              yield* bindFile(acquired, node.ino)
              opened(node.ino)

              return fileHandle(acquired)
            })
        )
      })

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
        const acquired = makeFileReference(chosen.access, chosen.append ?? false)
        const expected = chosen.expected

        return yield* acquireOpenedFile(
          acquired,
          op,
          (opened) =>
            Effect.gen(function*() {
              const resolved = yield* resolver.resolve({ kind: "entry", directory: entry.directory, name }, {
                kind: "OrCreate",
                create: chosen.create ?? "never",
                finalSymlink: chosen.followFinalSymlink !== false ? "follow" : "preserve",
                beforeFollow: Effect.fnUntraced(function*(_, direct) {
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
                })
              }, op)

              const file = resolved.kind === "existing" ? resolved.node : undefined
              const mutationParent = resolved.kind === "missing" ? resolved.parent.ino : resolved.origin.parent.ino
              const mutationName = resolved.kind === "missing" ? resolved.name : resolved.origin.name

              const result = yield* openFile(
                { parent: mutationParent, name: mutationName, trailingSlash: false, addressing: "entry", op },
                file,
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

      const walkChildren = Effect.fnUntraced(function*(
        directory: Directory,
        path: Uint8Array,
        depth: number,
        up: WalkFrame | undefined
      ) {
        const listed = referenceFor(directory.ino)
        const frames: Array<WalkFrame> = []

        for (const [name, childIno] of Arr.sort(directory.entries, byEntryName)) {
          const child = yield* view(childIno)

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
      })

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

      const pathAnchor = (target: Target, root: Directory, op: OpContext): Effect.Effect<WalkFrame | undefined> => {
        if (!Target.$is("Path")(target)) return Effect.undefined
        const prepared = prepare(target.path, op)

        if (Result.isFailure(prepared)) return Effect.undefined

        return resolveEntry({ kind: "path", path: prepared.success, base: target.relativeTo }, op).pipe(
          Effect.flatMap((entry) =>
            Effect.map(view(entry.parent), (parent) => {
              return entry.name !== undefined && parent?.kind === "directory" &&
                  parent.entries.get(entry.name) === root.ino
                ? anchorFrame(parent, entry.name, root)
                : undefined
            })
          ),
          Effect.catch(() => Effect.undefined)
        )
      }

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
          let node: Node | undefined = yield* view((chain.at(-1) ?? frame).parent)

          for (let index = chain.length - 1; index >= 0; index--) {
            const link = chain[index]

            if (link === undefined || node?.kind !== "directory" || node.metadata.nlink === 0) return undefined
            yield* authorize(node, identity, EXECUTE, at)
            node = node.entries.get(link.key) === link.ino ? (yield* view(link.ino)) : undefined
          }

          return node
        })

      // Walks the tree below the directory `first` lists, depth first. Every later directory is read in its own
      // observation, so a walk holds one permit at a time and never a handle; it writes nothing, so it refreshes no
      // access time. Each directory is reached by name, so it needs search permission on the directories above it,
      // and one that left the tree after it was listed has nothing to walk. A directory past `maxDepth` is never
      // read. `locate` names an entry's path in a failure, and `listable` authorizes reading a directory. Entries
      // gathered before a failure are handed on before the failure is.
      const walkFrames = <E extends WalkFailure = never>(
        op: OpContext,
        first: Effect.Effect<Array<WalkFrame>, FsFailure>,
        plan: WalkPlan<E>,
        locate: (path: Uint8Array) => PathInput,
        listable: (directory: Directory, at: OpContext) => Effect.Effect<void, FsFailure>
      ): Stream.Stream<WalkFrame, FsFailure | E> =>
        Stream.suspend(() => {
          let pending: Array<WalkFrame> | undefined
          let entries = 0
          let bytes = 0n
          let failure: FsFailure | E | undefined

          const list = (frame: WalkFrame) =>
            coordinatedRead(
              op,
              Effect.suspend(() => {
                if (TokenRegistry.inode(reference) === undefined) return Effect.fail(op.fail("ClosedCaller"))
                const at = op.at(locate(frame.path))

                return Effect.flatMap(reachFrame(frame, at), (node) =>
                  node?.kind !== "directory" || node.metadata.nlink === 0
                    ? Effect.succeed([])
                    : Effect.andThen(listable(node, at), walkChildren(node, frame.path, frame.depth, frame)))
              })
            )

          const admit = (frame: WalkFrame): E | undefined => {
            entries++
            bytes += frame.bytes

            return plan.limit(frame, { entries, bytes }, "entry")
          }

          const step = Effect.gen(function*() {
            // Preserve the generic limit error E; yielding the error directly widens it to WalkFailure.
            // oxlint-disable-next-line effecttsgo/unnecessary-fail-yieldable-error -- E must stay narrow for unbounded removal.
            if (failure !== undefined) return yield* Effect.fail(failure)

            if (pending === undefined) pending = (yield* first).reverse()
            const out: Array<WalkFrame> = []

            const stop = (error: FsFailure | E) => {
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
                const rejected = plan.limit(frame, { entries, bytes }, "directory")

                if (rejected !== undefined) return yield* stop(rejected)

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

        let anchor: WalkFrame | undefined
        let targetAt = preparedOp(prepared, op)

        const first = coordinatedRead(
          op,
          Effect.gen(function*() {
            const entry = yield* resolveEntry(prepared, op)
            const parent = yield* directoryNow(entry.parent)
            yield* authorize(parent, identity, EXECUTE, entry.op)
            const childIno = entry.name === undefined ? undefined : parent.entries.get(entry.name)
            const child = childIno === undefined ? undefined : (yield* view(childIno))

            if (entry.name === undefined || child === undefined) return yield* entry.op.fail("NotFound")

            if (child.kind !== "directory") return []
            yield* listable(child, entry.op)
            anchor = anchorFrame(parent, entry.name, child)
            targetAt = entry.op

            return yield* walkChildren(child, new Uint8Array(0), 0, anchor)
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
              Effect.gen(function*() {
                if (anchor !== undefined && !holds(yield* view(anchor.parent), anchor)) {
                  return yield* (force ? Effect.void : Effect.fail(targetAt.fail("NotFound")))
                }

                return yield* Effect.flatMap(
                  frame.up === undefined ? view(frame.parent) : reachFrame(frame.up, at),
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

        const plan: WalkPlan = { order: "post", limit: () => undefined }

        return yield* Stream.runForEach(walkFrames(op, first, plan, locate, listable), removeFrame)
      })

      const rootOp = OpContext.make("root")

      const entryVerb = Effect.fnUntraced(function*<A>(
        operation: string,
        input: EntryInput,
        body: (entry: ResolvedEntry, op: OpContext) => Effect.Effect<A, FsFailure, Draft>
      ) {
        const op = OpContext.make(operation)
        const prepared = yield* Effect.fromResult(prepareEntry(input, op))

        return yield* coordinated(op, Effect.flatMap(resolveEntry(prepared, op), (entry) => body(entry, op)))
      })

      const openDispatch = Effect.fnUntraced(
        function*(input: TargetInput | Entry, options: OpenOptions | OpenEntryOptions) {
          const op = OpContext.make("open")

          if (isEntry(input)) return yield* openEntry(input, options, op)
          const target = asTarget(input)

          if (Target.$is("Path")(target)) return yield* openPath(target, options, op)

          return yield* openNode(target, options, op)
        }
      )

      function open(
        input: Target | PathInput | ObjectReference | FileHandle,
        options: OpenOptions
      ): Effect.Effect<FileHandle, FsFailure, Scope.Scope>
      function open(input: Entry, options: OpenEntryOptions): Effect.Effect<OpenEntryResult, FsFailure, Scope.Scope>
      function open(
        input: TargetInput | Entry,
        options: OpenOptions | OpenEntryOptions
      ): Effect.Effect<FileHandle | OpenEntryResult, FsFailure, Scope.Scope> {
        return openDispatch(input, options)
      }

      const removeDispatch = Effect.fnUntraced(function*(input: EntryInput, options?: RemoveOptions) {
        const op = OpContext.make("remove")
        const prepared = yield* Effect.fromResult(prepareEntry(input, op))

        const chosen = yield* decodeRemoveOptions(options ?? {}).pipe(
          Effect.mapError((cause) => fail(preparedOp(prepared, op), cause))
        )

        const once = coordinated(op, Effect.flatMap(resolveEntry(prepared, op), (entry) => removeEntry(entry, op)))

        const target = <A>(effect: Effect.Effect<A, FsFailure>) =>
          chosen.force === true
            ? Effect.catchIf(effect, (error) => error.code === "NotFound", () => Effect.undefined)
            : effect

        const removed = yield* Effect.result(target(once))

        if (Result.isSuccess(removed)) return removed.success

        if (chosen.recursive !== true || removed.failure.code !== "NotEmpty") return yield* removed.failure
        yield* emptyDirectory(prepared, op, chosen.force === true)

        return yield* target(once)
      })

      function remove(
        input: EntryInput,
        options?: RemoveOptions & { readonly force?: false }
      ): Effect.Effect<DirectoryChange, FsFailure>
      function remove(input: EntryInput, options: RemoveOptions): Effect.Effect<DirectoryChange | undefined, FsFailure>
      function remove(
        input: EntryInput,
        options?: RemoveOptions
      ): Effect.Effect<DirectoryChange | undefined, FsFailure> {
        return removeDispatch(input, options)
      }

      const caller: Caller = Object.freeze({
        [CallerId]: true as const,
        root: coordinatedRead(
          rootOp,
          Effect.suspend(() =>
            TokenRegistry.inode(reference) === undefined
              ? Effect.fail(rootOp.fail("ClosedCaller"))
              : Effect.succeed(referenceFor(ROOT_INO))
          )
        ),
        lookup: Effect.fnUntraced(function*(input) {
          const op = OpContext.make("lookup")
          const prepared = yield* Effect.fromResult(prepareEntry(input, op))

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const entry = yield* resolveEntry(prepared, op)
              const directory = yield* directoryNow(entry.parent)

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
        parent: Effect.fnUntraced(function*(input) {
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
        stat: Effect.fnUntraced(function*(input) {
          const op = OpContext.make("stat")
          const target = asTarget(input)

          return yield* coordinatedRead(
            op,
            Effect.map(resolveTarget(target, op), (resolved) => withMetadata(resolved.node))
          )
        }),
        readDirectory: Effect.fnUntraced(function*(input) {
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

                return yield* walkChildren(
                  directory.node,
                  new Uint8Array(0),
                  0,
                  yield* pathAnchor(target, directory.node, op)
                )
              })
            )

            const exceeded = (frame: WalkFrame, field: keyof WalkOptions): WalkFailure =>
              makeError({ code: "LimitExceeded", operation: op.operation, field, path: errorPath(locate(frame.path)) })

            const maxBytes = chosen.maxBytes === undefined ? undefined : ByteSize.toBigInt(chosen.maxBytes)

            const plan: WalkPlan<WalkFailure> = {
              order: chosen.order ?? "pre",
              limit: (frame, progress, phase) => {
                if (chosen.maxDepth !== undefined && frame.depth > chosen.maxDepth) return exceeded(frame, "maxDepth")

                if (phase === "directory") return undefined

                if (chosen.maxEntries !== undefined && progress.entries > chosen.maxEntries) {
                  return exceeded(frame, "maxEntries")
                }

                return maxBytes !== undefined && progress.bytes > maxBytes ? exceeded(frame, "maxBytes") : undefined
              }
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
          }))
        },
        readLink: Effect.fnUntraced(function*(input) {
          const op = OpContext.make("readLink")
          const target = asTarget(input)

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const resolved = yield* resolveTarget(target, op, { followFinalSymlink: false, final: true })

              if (resolved.node.kind !== "symlink") return yield* resolved.op.fail("InvalidArgument")

              return new Uint8Array(resolved.node.target)
            })
          )
        }),
        realPath: Effect.fnUntraced(function*(input) {
          const op = OpContext.make("realPath")
          const target = asTarget(input)

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              if (Target.$is("Path")(target)) {
                const pathOp = op.at(target.path)
                const result = yield* resolveTarget(target, op, { final: true })

                const directory = result.node.kind === "directory"
                  ? result.node
                  : result.kind === "entry"
                  ? result.parent
                  : undefined

                const prefix = directory === undefined ? SLASH_HEX : yield* pathOfCurrent(directory.ino)

                if (prefix === undefined) return yield* pathOp.fail("NotFound")

                if (result.node.kind === "directory" || result.kind === "node") return ownedPath(nameBytes(prefix))

                return ownedPath(nameBytes(prefix + (prefix === SLASH_HEX ? "" : SLASH_HEX) + result.name))
              }

              const resolved = yield* resolveTarget(target, op)
              const path = yield* pathOfCurrent(resolved.node.ino)

              if (path === undefined) return yield* resolved.op.fail("NotFound")

              return ownedPath(nameBytes(path))
            })
          )
        }),
        access: Effect.fnUntraced(function*(input, bits = 0) {
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

                if (bit === EXECUTE && node.kind === "file" && (node.metadata.mode & ANY_EXECUTE) === 0) continue

                if (identity.privileged || (permitted(node, identity) & bit) !== 0) granted |= bit
              }

              return granted
            })
          )
        }),
        readFile: Effect.fnUntraced(function*(input) {
          const op = OpContext.make("readFile")
          const target = asTarget(input)

          return yield* accessing(
            op,
            Effect.gen(function*() {
              const resolved = yield* resolveTarget(target, op)
              const node = resolved.node

              if (node.kind === "symlink") return yield* resolved.op.fail("SymlinkLoop")

              if (node.kind !== "file") return yield* resolved.op.fail("IsDirectory")
              yield* authorize(node, identity, READ, resolved.op)
              const data = new Uint8Array(node.data)

              return { value: data, access: { node, now: yield* timestamp(op) } }
            })
          )
        }),
        writeFile: Effect.fnUntraced(function*(input, bytes, options) {
          const op = OpContext.make("writeFile")

          const prepared = yield* Effect.fromResult(prepareEntry(input, op))
          const optionsOp = preparedOp(prepared, op)

          if (!isAttachedBytes(bytes)) return yield* optionsOp.fail("InvalidArgument")
          const captured = new Uint8Array(bytes)
          const chosen = yield* decodeWriteFileOptions(options).pipe(Effect.mapError((cause) => fail(optionsOp, cause)))

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const resolved = yield* resolver.resolve(prepared, {
                kind: "OrCreate",
                create: chosen.create ?? "never",
                finalSymlink: chosen.replaceFinalSymlink !== true && chosen.followFinalSymlink !== false
                  ? "follow"
                  : "preserve",
                entryExclusive: "afterSymlink"
              }, op)

              const { parent, name, trailingSlash, op: entryOp } = resolved
              const found = resolved.kind === "existing" ? resolved.node : undefined

              if (found?.kind === "directory" || (found === undefined && trailingSlash)) {
                return yield* entryOp.fail("IsDirectory")
              }

              const replaced = found?.kind === "symlink" ? found : undefined

              if (replaced !== undefined && !chosen.replaceFinalSymlink) return yield* entryOp.fail("SymlinkLoop")

              if (chosen.access === "read") return yield* entryOp.fail("InvalidHandle")
              const file = found?.kind === "file" ? found : undefined

              if (file === undefined) {
                yield* authorize(parent, identity, WRITE | EXECUTE, entryOp)

                if (replaced !== undefined) yield* authorizeRemoval(parent, replaced, entryOp)

                yield* (replaced === undefined ? reserveEntry(entryOp) : reserveInode(entryOp))
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
              const d = yield* Draft

              const node = file ??
                (yield* newFile(parent, new Uint8Array(0), (chosen.mode ?? 0o666) & 0o777 & ~umask, now))

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

              yield* d.addUsedBytes(BigInt(size - previous))

              if (file === undefined) {
                if (replaced !== undefined) yield* detach(replaced, parent.ino, name, now)

                yield* attach(yield* directoryNow(parent.ino), name, written, now)

                if (replaced === undefined) yield* d.addEntries(1)
                yield* publishEntry(replaced === undefined ? "Create" : "Update", parent.ino, name, written.ino)
              } else {
                yield* d.put(written)
                yield* publishNode(written.ino)
              }
            })
          )
        }),
        open,
        mkdir: Effect.fnUntraced(function*(input, options = {}) {
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
        symlink: Effect.fnUntraced(function*(target, input, options = {}) {
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
        link: Effect.fnUntraced(function*(sourceInput, input) {
          const op = OpContext.make("link")
          const source = asTarget(sourceInput)
          const prepared = yield* Effect.fromResult(prepareEntry(input, op))

          return yield* coordinated(
            op,
            Effect.gen(function*() {
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
        unlink: Effect.fnUntraced(function*(input) {
          return yield* entryVerb("unlink", input, unlinkEntry)
        }),
        rmdir: Effect.fnUntraced(function*(input) {
          return yield* entryVerb("rmdir", input, rmdirEntry)
        }),
        remove,
        rename: Effect.fnUntraced(function*(fromInput, toInput) {
          const op = OpContext.make("rename")
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
        chmod: Effect.fnUntraced(function*(input, mode) {
          const op = OpContext.make("chmod")
          const target = asTarget(input)

          if (!isMode(mode)) return yield* op.fail("InvalidArgument")
          yield* changeAttributes(() => asResolvedNode(target, op), { mode }, op)
        }),
        chown: Effect.fnUntraced(function*(input, owner) {
          const op = OpContext.make("chown")
          const target = asTarget(input)
          const decoded = yield* decodeOwnerUpdate(owner).pipe(Effect.mapError((cause) => fail(op, cause)))
          yield* changeAttributes(() => asResolvedNode(target, op), { owner: decoded }, op)
        }),
        utimes: Effect.fnUntraced(function*(input, times) {
          const op = OpContext.make("utimes")
          const target = asTarget(input)
          const decoded = yield* decodeTimes(times).pipe(Effect.mapError((cause) => fail(op, cause)))
          yield* changeAttributes(() => asResolvedNode(target, op), { times: decoded }, op)
        }),
        // A negative length fails before the target resolves, as truncate(2) rejects it before the lookup.
        truncate: Effect.fnUntraced(function*(input, length) {
          const op = OpContext.make("truncate")
          const target = asTarget(input)

          if (!isLength(length)) return yield* op.fail("InvalidArgument")
          yield* changeAttributes(() => asResolvedNode(target, op), { size: length }, op)
        }),
        setattr: Effect.fnUntraced(function*(input, attributes) {
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
        withDirectory: Effect.fnUntraced(function*(input) {
          const acquired = yield* acquireDirectory(input, OpContext.make("withDirectory"))

          return createCaller(acquired, identity, umask)
        }),
        openDirectory: Effect.fnUntraced(function*(input) {
          const acquired = yield* acquireDirectory(input, OpContext.make("openDirectory"))
          const statOp = OpContext.make("stat")

          const handle: DirectoryHandle = Object.freeze({
            [DirectoryHandleId]: true as const,
            stat: coordinatedRead(
              statOp,
              Effect.gen(function*() {
                const ino = TokenRegistry.inode(acquired)
                const node = ino === undefined ? undefined : yield* view(ino)

                return yield* (node === undefined
                  ? Effect.fail(statOp.fail("InvalidHandle"))
                  : Effect.succeed(withMetadata(node)))
              })
            ),
            close: coordinatedCleanup(Effect.suspend(() => {
              if (TokenRegistry.inode(acquired) === undefined) {
                return Effect.fail(OpContext.make("close").fail("InvalidHandle"))
              }

              return releaseDirectory(acquired)
            })).pipe(Effect.ensuring(closeReleasedScope(acquired)))
          })

          registry.registerDirectory(handle, acquired)

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
      ),
      watch: Effect.fnUntraced(function*(options?: WatchOptions) {
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
      snapshot: coordinatedRead(OpContext.make("snapshot"), Effect.sync(() => Image.make(state))),
      referenceKey: Effect.fnUntraced(function*(reference: ObjectReference) {
        const op = OpContext.make("referenceKey")

        return yield* coordinatedRead(
          op,
          Effect.gen(function*() {
            const node = yield* TokenRegistry.nodeOrFail(
              yield* registry.resolve(reference, "reference"),
              "reference",
              op
            )

            const ino = BigInt(node.ino)

            return { identity: identityBytes.slice(), epoch: epochBytes.slice(), ino, tag: keyTag(ino) }
          })
        )
      }),
      resolveReferenceKey: Effect.fnUntraced(function*(key: ReferenceKey) {
        const op = OpContext.make("resolveReferenceKey")

        return yield* coordinatedRead(
          op,
          Effect.gen(function*() {
            if (!Schema.is(ReferenceKey)(key)) return yield* op.fail("InvalidReference")

            // Another epoch numbered its objects on its own, so its key is another volume's even under this identity.
            if (!sameBytes(key.identity, identityBytes) || !sameBytes(key.epoch, epochBytes)) {
              return yield* op.fail("ForeignReference")
            }

            // Checked before the inode is looked up, so a guessed key learns nothing about which numbers are in use.
            if (!sameTag(key.tag, keyTag(key.ino))) return yield* op.fail("InvalidReference")

            const ino = Ino(Number(key.ino))

            yield* TokenRegistry.nodeOrFail(yield* registry.resolveInode(ino), "reference", op)

            return referenceFor(ino)
          })
        )
      }),

      caller: Effect.fnUntraced(function*(options?: RootCallerOptions) {
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

    const observe = Object.freeze({
      changes: coordinatedRead(OpContext.make("changes"), Effect.suspend(() => observeChanges(state))),
      capture: coordinatedRead(OpContext.make("capture"), captureState())
    })

    return Object.freeze({ volume, shutdown, observe })
  }
)

/** @internal */
export const make = Effect.fnUntraced(function*(options?: VolumeOptions) {
  return (yield* makeVolume(VolumeSource.Empty(), memoryCommitProvider, options).pipe(
    Effect.catchIf((error) => Schema.is(VfsError)(error) && error.code !== "InvalidArgument", Effect.die)
  )).volume
})

/** @internal */
export const prepareEmptyLiveImage = Effect.fnUntraced(function*(options?: VolumeOptions) {
  const decoded = yield* Effect.fromResult(Limits.configuration(options, "prepareEmptyImage"))
  const limits = decoded.limits
  const identity = decoded.identity ?? VolumeIdentity.make(yield* randomHex128)
  const epoch = VolumeEpoch.make(yield* randomHex128)
  const keySecret = KeySecret.make(yield* randomHex128)
  const now = yield* Clock.currentTimeNanos

  if (!isTimestamp(now)) return yield* argumentFailure("prepareEmptyImage", "clock.currentTimeNanos")

  return yield* LiveImage.encode(emptyState(now), { identity, epoch, keySecret }, limits).pipe(
    Effect.mapError((error) => retargetFailure("prepareEmptyImage", error))
  )
})

/** @internal */
export const openImageVolume = Effect.fnUntraced(function*(
  image: Uint8Array,
  maxImageBytes: ByteSize.ByteSize,
  commit: (image: Uint8Array) => Effect.Effect<CommitOutcome>,
  durability: VolumeDurability = "memory-only",
  options?: VolumeOptions
) {
  const restored = yield* LiveImage.decode(image, maxImageBytes)
  const requested = yield* Effect.fromResult(Limits.fromOptions(options, "openImage"))
  const limits = yield* Effect.fromResult(Limits.fromStored(restored.limits, requested))

  const provider: CommitProvider<VolumeState> = {
    mode: "durable",
    shutdown: Effect.void,
    commit: (candidate) =>
      LiveImage.encode(candidate, restored, limits).pipe(
        Effect.mapError((cause) => makeError({ code: "StorageRejected", operation: "commit", cause })),
        Effect.flatMap((bytes) =>
          ByteSize.isGreaterThan(ByteSize.bytes(bytes.length), maxImageBytes)
            ? Effect.fail(makeError({ code: "StorageRejected", operation: "commit" }))
            : commit(bytes)
        )
      )
  }

  const { volume, shutdown } = yield* makeVolume(VolumeSource.Live({ restored }), provider, options, durability)

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
export const fromSnapshot = Effect.fnUntraced(
  function*(snapshot: Snapshot, options?: VolumeOptions) {
    return (yield* makeVolume(
      VolumeSource.Restored({ value: yield* Image.valueOf(snapshot) }),
      memoryCommitProvider,
      options
    )).volume
  },
  Effect.mapError((error) => retargetFailure("fromSnapshot", error))
)

/** @internal */
export const makeOverlay = Effect.fnUntraced(
  function*(base: Snapshot, options?: VolumeOptions) {
    const value = yield* Image.valueOf(base)

    const made = yield* Effect.mapError(
      makeVolume(VolumeSource.Restored({ value }), memoryCommitProvider, options),
      (error) => retargetFailure("makeOverlay", error)
    )

    const baseObservation = yield* observeChanges(value)

    const overlay: OverlayVolume = Object.freeze({
      ...made.volume,
      changes: Effect.fnUntraced(function*(options?: OverlayChangesOptions) {
        const selected = yield* changeOptions(options)
        const current = yield* made.observe.changes

        return publicChanges(compareOverlay(baseObservation, current, selected.includeTimestamps ?? false))
      }),
      capture: Effect.fnUntraced(function*(options?: OverlayChangesOptions) {
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
