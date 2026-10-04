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
import { Context, Deferred, Duration, Effect, Layer, MutableHashMap, Option, RcMap, Schema } from "effect"
import * as ByteSize from "effect/ByteSize"
import type * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import type * as Scope from "effect/Scope"
import { argumentFailure, decodeConfiguration, retargetFailure } from "./internal/errors.js"
import * as Model from "./internal/virtualFileSystem.js"
import * as Limits from "./internal/volumeLimits.js"
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
 * Requires `Crypto.Crypto` to mint a new volume or incarnation.
 *
 * @category constructors
 * @since 0.4.0
 */
export const open: (options: Options) => Effect.Effect<
  Volume,
  VfsError,
  LiveImageStore | Scope.Scope | Crypto.Crypto
> = Effect.fn("LiveVolume.open")(function*(options: Options) {
  const store = yield* LiveImageStore

  const { decoded, initial } = yield* Effect.gen(function*() {
    const decoded = yield* Effect.fromResult(Limits.configuration(options.volume, "LiveVolume.open"))
    const initial = yield* prepareEmptyImage(decoded.options)

    return { decoded, initial }
  }).pipe(
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

  const requested = decoded.limits

  const session = yield* Model.openImageVolume(
    image,
    options.maxImageBytes,
    store.commit,
    store.durability ?? "memory-only",
    decoded.options
  ).pipe(
    Effect.mapError((cause) => new VfsError({ code: "CorruptStore", operation: "LiveVolume.open", cause }))
  )

  yield* Effect.addFinalizer(() => session.shutdown)
  const volume = session.volume

  if (!Limits.compatible(volume.limits, requested, volume.identity, decoded.identity)) {
    return yield* new VfsError({ code: "IncompatibleStore", operation: "LiveVolume.open" })
  }

  return volume
})

/**
 * Scoped access to live volumes shared by canonical storage identity.
 * Each `get` retains its volume until the borrowing scope closes. Keep that
 * scope open until its callers and handles finish using the volume.
 *
 * @category models
 * @since 0.9.0
 */
export interface Registry<K, E = never> {
  readonly get: (key: K) => Effect.Effect<Volume, E | VfsError | Cause.ExceededCapacityError, Scope.Scope>
}

/**
 * Store Layers are built independently for each acquired entry. The same volume
 * configuration applies to every key. Keys use Effect's equality rules and must
 * identify canonical storage locations; different aliases can create competing
 * owners. Coordinate ownership across processes outside this registry.
 *
 * @category models
 * @since 0.9.0
 */
export interface RegistryOptions<K, E = never, R = never> {
  readonly store: (key: K) => Layer.Layer<LiveImageStore, E, R>
  readonly volume: Options
  /** Positive integer entry limit. Omission means unlimited; idle entries count. */
  readonly capacity?: number
  /** Retain unused entries for this duration. Omission releases them immediately. */
  readonly idleTimeToLive?: Duration.Input
}

const RegistryCapacity = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * Lazily share one live volume and its store per key through `RcMap`. Concurrent
 * borrowers share acquisition. Reusing an idle entry avoids rebuilding its store
 * and decoding its image, while retaining its memory and storage locks.
 *
 * The registry's owning scope must outlive all borrowers. Closing it shuts down
 * every volume, including borrowed ones, before releasing their store Layers.
 * Capacity exhaustion fails with `Cause.ExceededCapacityError`; it does not evict
 * idle entries. Acquisition failures remain shared until the entry is released.
 *
 * Invalidation is intentionally unavailable: acquiring a replacement while an
 * existing borrower remains would violate exclusive store ownership. Canonicalize
 * keys before borrowing and use one registry for each set of backing stores.
 *
 * @example
 * ```ts
 * import { LiveVolume } from "@effect-vfs/core"
 * import { ByteSize, Effect, Layer } from "effect"
 *
 * declare const storeFor: (key: string) => Layer.Layer<LiveVolume.LiveImageStore>
 *
 * const program = Effect.gen(function*() {
 *   const registry = yield* LiveVolume.makeRegistry({
 *     store: storeFor,
 *     volume: { maxImageBytes: ByteSize.megabytes(1), volume: {} },
 *     capacity: 8,
 *     idleTimeToLive: "5 seconds"
 *   })
 *   return yield* Effect.scoped(Effect.gen(function*() {
 *     const volume = yield* registry.get("workspace")
 *     return yield* (yield* volume.caller()).readFile("/plan.md")
 *   }))
 * })
 * ```
 *
 * @category constructors
 * @since 0.9.0
 */
export const makeRegistry: <K, E, R>(options: RegistryOptions<K, E, R>) => Effect.Effect<
  Registry<K, E>,
  ArgumentFailure,
  R | Crypto.Crypto | Scope.Scope
> = Effect.fn("LiveVolume.makeRegistry")(function*<K, E, R>(options: RegistryOptions<K, E, R>) {
  const capacity = options.capacity === undefined
    ? Infinity
    : yield* Effect.fromResult(decodeConfiguration(RegistryCapacity, options.capacity, "LiveVolume.makeRegistry")).pipe(
      Effect.mapError((cause) => argumentFailure("LiveVolume.makeRegistry", "capacity", cause))
    )

  const idleTimeToLive = Duration.fromInput(options.idleTimeToLive ?? 0)

  if (Option.isNone(idleTimeToLive)) return yield* argumentFailure("LiveVolume.makeRegistry", "idleTimeToLive")

  const store = options.store
  const volume: Options = { maxImageBytes: options.volume.maxImageBytes, volume: { ...options.volume.volume } }

  const retiring = MutableHashMap.empty<K, Deferred.Deferred<void>>()

  const volumes = yield* RcMap.make({
    lookup: Effect.fn("LiveVolume.Registry.open")(function*(key: K) {
      // RcMap removes an entry before its asynchronous finalizers finish. Keep
      // equal keys waiting until both the volume and its store have shut down.
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          let previous = MutableHashMap.get(retiring, key)
          while (Option.isSome(previous)) {
            yield* restore(Deferred.await(previous.value))
            previous = MutableHashMap.get(retiring, key)
          }
          const released = yield* Deferred.make<void>()
          MutableHashMap.set(retiring, key, released)
          // Registered first, this runs after the store and volume finalizers.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function*() {
              MutableHashMap.remove(retiring, key)
              yield* Deferred.succeed(released, undefined)
            })
          )
        })
      )
      // A parent Layer memo must not keep a retired store alive or share its
      // mutable ownership state with a different volume entry.
      const services = yield* Layer.build(Layer.fresh(store(key)))

      return yield* open(volume).pipe(
        Effect.provideService(LiveImageStore, Context.get(services, LiveImageStore))
      )
    }),
    capacity,
    idleTimeToLive: idleTimeToLive.value
  })

  return { get: (key: K) => RcMap.get(volumes, key) }
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
 * Requires `Crypto.Crypto` for secure volume identifiers and reference keys.
 *
 * @category constructors
 * @since 0.4.0
 */
export const prepareEmptyImage: (options?: VolumeOptions) => Effect.Effect<
  Uint8Array,
  VfsError,
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
  VfsError,
  Crypto.Crypto
> = Model.openImageVolume
