/** Existing core constructors over the sole Effect virtual filesystem runtime. @internal */
import * as ByteSize from "effect/ByteSize"
import * as Clock from "effect/Clock"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Schema from "effect/Schema"
import type { CommitOutcome } from "../LiveVolume.js"
import type { Snapshot } from "../Snapshot.js"
import { type ImageFailure, make as makeError, VfsError } from "../VfsError.js"
import type { OverlayVolume, VolumeOptions } from "../VirtualFileSystem.js"
import { type VolumeDurability, VolumeIdentity } from "../Volume.js"
import { retargetFailure } from "./errors.js"
import { KeySecret, VolumeEpoch } from "./hex128.js"
import * as Image from "./image.js"
import * as LiveImage from "./liveImage.js"
import * as MetadataDomain from "./metadata.js"
import { type CommitProvider as Provider, Errors, memoryCommitProvider, State } from "./model.js"
import * as Runtime from "./runtime.js"
import * as Limits from "./volumeLimits.js"

export type CommitProvider<A> = Provider<A>

export { memoryCommitProvider } from "./model.js"

type VolumeState = State.VolumeState

type VolumeSource =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Live"; readonly restored: LiveImage.Restored }
  | { readonly _tag: "Restored"; readonly value: VolumeState }

export const VolumeSource = Data.taggedEnum<VolumeSource>()

const { argumentFailure } = Errors

const { emptyState } = State

const isTimestamp = Schema.is(MetadataDomain.Timestamp)

const randomHex128 = Effect.gen(function*() {
  const crypto = yield* SecureRandom.SecureRandom

  return Hex.encode(yield* crypto.randomBytes(16))
})

export const makeVolume = Runtime.makeVolume

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

export const makeOverlay = (
  _base: Snapshot,
  _options?: VolumeOptions
): Effect.Effect<OverlayVolume, ImageFailure, SecureRandom.SecureRandom> => Runtime.blocked("overlayCopyOnWrite")
