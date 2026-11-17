/** Existing core constructors over the sole Effect virtual filesystem runtime. @internal */
import * as ByteSize from "effect/ByteSize"
import * as Clock from "effect/Clock"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type { CommitOutcome } from "../LiveVolume.js"
import type { Snapshot } from "../Snapshot.js"
import { make as makeError, VfsError } from "../VfsError.js"
import type { OverlayVolume, VolumeOptions } from "../VirtualFileSystem.js"
import { OverlayChange, OverlayChangesOptions, type VolumeDurability, VolumeIdentity } from "../Volume.js"
import { retargetFailure } from "./errors.js"
import { KeySecret, VolumeEpoch } from "./hex128.js"
import * as Image from "./image.js"
import * as LiveImage from "./liveImage.js"
import * as MetadataDomain from "./metadata.js"
import {
  type CommitProvider as Provider,
  Errors,
  memoryCommitProvider,
  Paths,
  State,
  VolumeTestSeams
} from "./model.js"
import { compareOverlay, type ObservationEntry, type RawOverlayChange } from "./overlayDiff.js"
import { makeVolume } from "./runtime.js"
import * as Limits from "./volumeLimits.js"
import { storedMetadata } from "./volumeState.js"

export type CommitProvider<A> = Provider<A>

export { memoryCommitProvider } from "./model.js"

type VolumeState = State.VolumeState

type VolumeSource =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Live"; readonly restored: LiveImage.Restored }
  | { readonly _tag: "Restored"; readonly value: VolumeState }
  | { readonly _tag: "Overlay"; readonly value: VolumeState }

export const VolumeSource = Data.taggedEnum<VolumeSource>()

const { argumentFailure } = Errors

const { emptyState } = State

const isTimestamp = Schema.is(MetadataDomain.Timestamp)

const randomHex128 = Effect.gen(function*() {
  const crypto = yield* SecureRandom.SecureRandom

  return Hex.encode(yield* crypto.randomBytes(16))
})

export { makeVolume }

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
  const decoded = yield* Effect.fromResult(Limits.configuration(options, "openImage"))

  if (decoded.options.execution === "sync") return yield* argumentFailure("openImage", "execution")
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

const observeChanges = Effect.fnUntraced(function*(captured: VolumeState) {
  const observation: Array<ObservationEntry> = []
  const paths: Array<readonly [State.Ino, Uint8Array]> = [[State.ROOT_INO, Paths.ROOT_PATH]]

  for (let index = 0; index < paths.length; index++) {
    if (index % State.WALK_YIELD_INTERVAL === 0) yield* Effect.yieldNow
    const entry = paths[index]

    if (entry === undefined) continue
    const [ino, path] = entry
    const node = State.getNode(captured, ino)

    if (node === undefined) continue
    observation.push({
      path,
      lineage: String(node.ino),
      kind: node.kind,
      content: node.kind === "file" ? node.data : node.kind === "symlink" ? node.target : undefined,
      metadata: storedMetadata(node.metadata)
    })

    if (node.kind !== "directory") continue

    for (const [name, child] of node.entries) paths.push([child, Paths.joinPath(path, Paths.nameBytes(name))])
  }

  return observation
})

const publicChange = (change: RawOverlayChange): OverlayChange =>
  Predicate.isTagged("Renamed")(change)
    ? OverlayChange.make({ ...change, from: Paths.ownedPath(change.from), to: Paths.ownedPath(change.to) })
    : OverlayChange.make({ ...change, path: Paths.ownedPath(change.path) })

const publicChanges = (changes: ReadonlyArray<RawOverlayChange>): ReadonlyArray<OverlayChange> =>
  Object.freeze(changes.map(publicChange))

declare const MergeCaptureBrand: unique symbol

/** @internal */
export interface MergeCapture {
  readonly [MergeCaptureBrand]: true
}

interface MergeCaptureState {
  readonly base: Snapshot
  readonly target: Snapshot
}

const mergeCaptures = new WeakMap<MergeCapture, MergeCaptureState>()

const mergeObservers = new WeakMap<OverlayVolume, Effect.Effect<MergeCapture, VfsError>>()

/** @internal */
export const captureOverlayForMerge = Effect.fnUntraced(function*(overlay: OverlayVolume) {
  const capture = mergeObservers.get(overlay)

  if (capture === undefined) return yield* argumentFailure("captureOverlayForMerge", "overlay")

  return yield* capture
})

/** @internal */
export const getMergeCapture = (capture: MergeCapture) => mergeCaptures.get(capture)

const changeOptions = (options?: OverlayChangesOptions) => {
  return Effect.fromResult(
    Errors.decodeConfiguration(OverlayChangesOptions, options === undefined ? {} : options, "changes")
  )
}

export const makeOverlay = Effect.fnUntraced(function*(base: Snapshot, options?: VolumeOptions) {
  const value = yield* Image.valueOf(base)

  const { observeSnapshot, volume } = yield* makeVolume(VolumeSource.Overlay({ value }), memoryCommitProvider, options)
    .pipe(
      Effect.mapError((error) => retargetFailure("makeOverlay", error))
    )

  const before = yield* observeChanges(value)

  const summary = Effect.fnUntraced(function*(snapshot: Snapshot, includeTimestamps = false) {
    const after = yield* observeChanges(yield* Image.valueOf(snapshot))

    return publicChanges(compareOverlay(before, after, includeTimestamps))
  })

  const overlay: OverlayVolume = Object.freeze(Object.assign(volume, {
    changes: Effect.fnUntraced(function*(options?: OverlayChangesOptions) {
      const selected = yield* changeOptions(options)

      return yield* observeSnapshot((snapshot) => summary(snapshot, selected.includeTimestamps))
    }),
    capture: Effect.fnUntraced(function*(options?: OverlayChangesOptions) {
      const selected = yield* changeOptions(options)
      const seams = yield* VolumeTestSeams

      return yield* observeSnapshot((snapshot) =>
        Effect.andThen(seams.betweenSnapshotAndSummary, summary(snapshot, selected.includeTimestamps)).pipe(
          Effect.map((changes) => Object.freeze({ snapshot, changes }))
        )
      )
    })
  }))

  mergeObservers.set(
    overlay,
    observeSnapshot((target) =>
      Effect.sync(() => {
        // SAFETY: The private registry supplies the new token's authority before it can escape.
        const capture = Object.freeze({}) as MergeCapture
        mergeCaptures.set(capture, { base, target })

        return capture
      })
    )
  )

  return overlay
})
