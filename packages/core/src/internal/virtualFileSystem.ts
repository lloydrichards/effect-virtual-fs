/**
 * Community volume assembly over the shared private filesystem engine.
 * IDs, authenticated keys, snapshots, overlays, storage encoders and watch delivery stay here.
 * @internal
 */
import * as ByteSize from "effect/ByteSize"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { BytePath } from "../BytePath.js"
import { CallerId, type RootCallerOptions } from "../Caller.js"
import type { CommitOutcome } from "../LiveVolume.js"
import type { Snapshot } from "../Snapshot.js"
import { make as makeError, VfsError } from "../VfsError.js"
import type { Caller, FsFailure, ObjectReference, OverlayVolume, Volume, VolumeOptions } from "../VirtualFileSystem.js"
import {
  OverlayChange,
  OverlayChangesOptions,
  ReferenceKey,
  type VolumeDurability,
  VolumeId,
  VolumeIdentity,
  VolumeIncarnation
} from "../Volume.js"
import { CallerWatchOptions, WatchOptions } from "../Watch.js"
import { sameBytes } from "./bytes.js"
import * as CallerWatch from "./callerWatch.js"
import type { Installation, WatchEvent } from "./callerWatch.js"
import * as Engine from "./engine.js"
import { imageFailure, retargetFailure } from "./errors.js"
import { KeySecret, VolumeEpoch } from "./hex128.js"
import { hmacSha256, sameTag } from "./hmac.js"
import * as Image from "./image.js"
import * as LiveImage from "./liveImage.js"
import * as MetadataDomain from "./metadata.js"
import { compareOverlay, type ObservationEntry, type RawOverlayChange } from "./overlayDiff.js"

import { Errors, Paths, State, VolumeTestSeams } from "./engine.js"
import * as Limits from "./volumeLimits.js"
import { reachableValue, storedMetadata } from "./volumeState.js"
import * as WatchHub from "./watchHub.js"

const { argumentFailure, decodeConfiguration, OpContext } = Errors

const { joinPath, nameBytes, ownedPath, ROOT_PATH, SLASH_BYTE, SLASH_HEX } = Paths

const { emptyState, getNode, Ino, ROOT_INO, WALK_YIELD_INTERVAL } = State

type Ino = State.Ino

type Node = State.Node

type VolumeState = State.VolumeState

/** @internal */
export type CommitProvider<State> = Engine.CommitProvider<State>

/** @internal */
export const memoryCommitProvider = Engine.memoryCommitProvider

const isTimestamp = Schema.is(MetadataDomain.Timestamp)

type VolumeSource =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Live"; readonly restored: LiveImage.Restored }
  | { readonly _tag: "Restored"; readonly value: VolumeState }

/** @internal */
export const VolumeSource = Data.taggedEnum<VolumeSource>()

const RescanChange = Schema.TaggedStruct("Rescan", { path: BytePath })

const RemoveChange = Schema.TaggedStruct("Remove", { path: BytePath })

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
  // TODO: (#304) Use SecureRandom for construction once its service is released; retain 16-byte IDs.
  const crypto = yield* Crypto.Crypto

  return Hex.encode(yield* crypto.randomBytes(16))
}).pipe(Effect.orDie)

/** @internal */
export const makeVolume = Effect.fnUntraced(function*(
  source: VolumeSource,
  commitProvider: CommitProvider<VolumeState>,
  options?: VolumeOptions,
  durability: VolumeDurability = "memory-only"
) {
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

  let state: VolumeState | undefined
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

  let watchHub: WatchHub.WatchHub<WatchEvent, Installation, FsFailure>
  const { maxWatchEvents, ...basicLimits } = limits

  const engine = yield* Engine.makeEngine({
    limits: basicLimits,
    initialTime,
    initialState: state,
    commitProvider,
    installed: (events, installation) => watchHub.publishUnsafe(events, installation)
  })

  watchHub = yield* WatchHub.make<WatchEvent, Installation, FsFailure>(engine.coordinate, maxWatchEvents)

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

  const scopeRoot = engine.watchRoot

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

  const captureState = engine.capture(
    "capture",
    Effect.fnUntraced(function*(captured) {
      const snapshot = Image.make(captured)
      yield* (yield* VolumeTestSeams).betweenSnapshotAndSummary

      return { snapshot, observation: yield* observeChanges(captured) }
    })
  )

  const keyTag = (ino: bigint): Uint8Array => {
    const message = new Uint8Array(40)
    message.set(identityBytes)
    message.set(epochBytes, 16)
    new DataView(message.buffer).setBigUint64(32, ino)

    return hmacSha256(keySecretBytes, message).subarray(0, 16)
  }

  const wrapContext = (context: Engine.EngineContext): Caller =>
    Object.freeze({
      ...context.operations,
      [CallerId]: true as const,
      limits,
      watch: Effect.fnUntraced(function*(input, options) {
        const op = OpContext.make("watch")
        const decoded = yield* Effect.fromResult(decodeConfiguration(CallerWatchOptions, options ?? {}, "watch"))
        const seams = yield* VolumeTestSeams
        const select = Effect.map(context.selectWatch(input, decoded), CallerWatch.make)

        return Stream.map(yield* engine.admit(op, watchHub.subscribe(select, seams.afterSubscribe)), (event) =>
          event.change)
      }),
      withRoot: Effect.fnUntraced(function*(input) {
        return wrapContext(yield* context.withRoot(input))
      }),
      withDirectory: Effect.fnUntraced(function*(input) {
        return wrapContext(yield* context.withDirectory(input))
      })
    })

  const volume: Volume = Object.freeze({
    [VolumeId]: true as const,
    durability,
    identity,
    incarnation,
    limits,
    usage: engine.usage,
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
        engine.checkAvailable("watch"),
        scope === undefined
          ? Effect.succeed(recursive ? volumeSelection : scopedSelection(ROOT_INO, false))
          : Effect.map(scopeRoot(scope, op), (root) => scopedSelection(root, recursive))
      )

      const stream = yield* engine.admit(op, watchHub.subscribe(select, seams.afterSubscribe))

      return Stream.map(stream, (event) => event.change)
    }),
    snapshot: engine.capture("snapshot", (state) => Effect.succeed(Image.make(state))),
    referenceKey: Effect.fnUntraced(function*(reference: ObjectReference) {
      const op = OpContext.make("referenceKey")

      const ino = BigInt(yield* engine.referenceInode(reference, op))

      return { identity: identityBytes.slice(), epoch: epochBytes.slice(), ino, tag: keyTag(ino) }
    }),
    resolveReferenceKey: Effect.fnUntraced(function*(key: ReferenceKey) {
      const op = OpContext.make("resolveReferenceKey")

      if (!Schema.is(ReferenceKey)(key)) return yield* op.fail("InvalidReference")

      if (!sameBytes(key.identity, identityBytes) || !sameBytes(key.epoch, epochBytes)) {
        return yield* op.fail("ForeignReference")
      }

      if (!sameTag(key.tag, keyTag(key.ino))) return yield* op.fail("InvalidReference")

      return yield* engine.objectFor(Ino(Number(key.ino)), op)
    }),

    caller: Effect.fnUntraced(function*(options?: RootCallerOptions) {
      return wrapContext(yield* engine.context(options))
    })
  })

  const observe = Object.freeze({
    changes: engine.capture("changes", observeChanges),
    capture: captureState
  })

  return Object.freeze({ volume, shutdown: engine.shutdown, observe })
})

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
