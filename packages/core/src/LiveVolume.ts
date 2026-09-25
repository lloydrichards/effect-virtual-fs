/**
 * Image boundary for a storage adapter that commits each live volume mutation.
 *
 * An adapter must preserve the supplied bytes atomically and classify each
 * commit as confirmed, definitely rejected, or uncertain. The opened volume
 * stays at `memory-only` unless the adapter explicitly supplies a qualified
 * durability tier.
 *
 * @since 0.4.0
 */
import { Context, Effect } from "effect"
import * as ByteSize from "effect/ByteSize"
import type * as Crypto from "effect/Crypto"
import type * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import { argumentFailure, retargetFailure } from "./internal/errors.js"
import * as Model from "./internal/virtualFileSystem.js"
import { type ArgumentFailure, type StoreFailure, VfsError } from "./VfsError.js"
import type { Volume, VolumeDurability, VolumeOptions } from "./VirtualFileSystem.js"

/**
 * A storage commit's observed outcome.
 *
 * @category models
 * @since 0.4.0
 */
export type CommitOutcome = "committed" | "rejected" | "unknown"

/**
 * One exclusively owned store. Its Layer holds the storage resource until the
 * volume has shut down. Providers must atomically replace each image and
 * classify ambiguous commits as `unknown`.
 *
 * @category services
 * @since 0.4.0
 */
export class LiveImageStore extends Context.Service<LiveImageStore, {
  /** Storage guarantee for successful commits; omission means memory-only. */
  readonly durability?: VolumeDurability
  readonly loadOrCreate: (initial: Uint8Array) => Effect.Effect<Uint8Array, StoreFailure | ArgumentFailure>
  readonly commit: (image: Uint8Array) => Effect.Effect<CommitOutcome>
}>()("@effect-vfs/core/LiveImageStore") {}

/**
 * Configuration shared by every live-image provider.
 *
 * @category models
 * @since 0.4.0
 */
export interface Options {
  readonly maxImageBytes: ByteSize.ByteSize
  readonly volume: VolumeOptions
}

/**
 * Open a live volume using the supplied store Layer. The caller owns a Scope;
 * the volume shuts down before that Layer releases its storage resource.
 *
 * @category constructors
 * @since 0.4.0
 */
export const open: (options: Options) => Effect.Effect<
  Volume,
  VfsError,
  LiveImageStore | Crypto.Crypto | Scope.Scope
> = Effect.fn("LiveVolume.open")(function*(options: Options) {
  const store = yield* LiveImageStore

  const initial = yield* prepareEmptyImage(options.volume).pipe(
    // Names the nested option that failed, such as `volume.maxEntries`.
    Effect.mapError((cause) => {
      const field = "field" in cause ? cause.field : undefined

      return argumentFailure("LiveVolume.open", field === undefined ? "volume" : `volume.${field}`, cause)
    })
  )

  if (BigInt(initial.length) > ByteSize.toBigInt(options.maxImageBytes)) {
    return yield* argumentFailure("LiveVolume.open", "maxImageBytes")
  }

  const image = yield* store.loadOrCreate(initial)

  const session = yield* openImage(image, options.maxImageBytes, store.commit, store.durability ?? "memory-only").pipe(
    Effect.mapError((cause) => new VfsError({ code: "CorruptStore", operation: "LiveVolume.open", cause }))
  )

  yield* Effect.addFinalizer(() => session.shutdown)
  const volume = session.volume

  if (
    volume.limits.maxEntries !== options.volume.maxEntries || volume.limits.maxBytes === undefined ||
    volume.limits.maxPathBytes === undefined || options.volume.maxBytes === undefined ||
    options.volume.maxFileBytes === undefined || options.volume.maxPathBytes === undefined ||
    ByteSize.toBigInt(volume.limits.maxBytes) !== ByteSize.toBigInt(options.volume.maxBytes) ||
    ByteSize.toBigInt(volume.limits.maxFileBytes) !== ByteSize.toBigInt(options.volume.maxFileBytes) ||
    ByteSize.toBigInt(volume.limits.maxPathBytes) !== ByteSize.toBigInt(options.volume.maxPathBytes) ||
    (options.volume.identity !== undefined && options.volume.identity !== volume.identity)
  ) {
    return yield* new VfsError({ code: "IncompatibleStore", operation: "LiveVolume.open" })
  }

  return volume
})

/**
 * A live volume and the shutdown action its storage adapter must run before
 * closing the underlying store.
 *
 * @example
 * ```ts
 * import type { ImageSession } from "@effect-vfs/core/LiveVolume"
 *
 * const shutdown = (session: ImageSession) => session.shutdown
 * ```
 *
 * @category models
 * @since 0.4.0
 */
export interface ImageSession {
  readonly volume: Volume
  readonly shutdown: Effect.Effect<void>
}

/**
 * Construct a versioned image for a new, empty volume.
 * Store this image before opening it for mutation.
 *
 * @category constructors
 * @since 0.4.0
 */
export const prepareEmptyImage: (options?: VolumeOptions) => Effect.Effect<
  Uint8Array,
  VfsError | PlatformError.PlatformError,
  Crypto.Crypto
> = (options) =>
  Effect.mapError(
    Model.prepareEmptyLiveImage(options),
    (error) => retargetFailure("LiveVolume.prepareEmptyImage", error)
  )

/**
 * Open a validated image and stage every mutation before calling `commit`.
 * The returned session contains the volume and a coordinated shutdown effect.
 * Run shutdown before releasing the storage connection. An uncertain commit
 * makes the volume unavailable until it is reopened.
 *
 * @category constructors
 * @since 0.4.0
 */
export const openImage: (
  image: Uint8Array,
  maxImageBytes: ByteSize.ByteSize,
  commit: (image: Uint8Array) => Effect.Effect<CommitOutcome>,
  durability?: VolumeDurability
) => Effect.Effect<
  ImageSession,
  VfsError | PlatformError.PlatformError,
  Crypto.Crypto
> = Model.openImageVolume
