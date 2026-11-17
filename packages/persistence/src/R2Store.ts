/**
 * Transport-independent image storage for one externally owned R2 object.
 *
 * @since 0.12.0
 */
import { LiveVolume, type VfsError, type VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Context, Effect, Fiber, Layer, Scope } from "effect"
import type * as ByteSize from "effect/ByteSize"
import type * as Digest from "effect/crypto/Digest"
import * as Protocol from "./internal/liveImageProtocol.js"
import { storeFailures } from "./internal/storeSupport.js"

/** A complete R2 image plus the metadata needed to validate and fence it.
 *
 * @example
 * ```ts
 * import type { ObjectRecord } from "@effect-vfs/persistence/R2Store"
 *
 * const record: ObjectRecord = {
 *   bytes: new Uint8Array(),
 *   etag: '"version-1"',
 *   generation: "0",
 *   digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
 * }
 * ```
 *
 * @since 0.5.0
 * @category models
 */
export interface ObjectRecord {
  readonly bytes: Uint8Array
  readonly etag: string
  readonly generation: string | undefined
  readonly digest: string | undefined
}

/** Transport operations required by the live-image adapter.
 *
 * @example
 * ```ts
 * import type { R2Client } from "@effect-vfs/persistence/R2Store"
 *
 * type ReadObject = R2Client["read"]
 * ```
 *
 * @since 0.5.0
 * @category models
 */
export interface R2Client {
  /** Materializes an object without a transport limit. Prefer readBounded when available. */
  readonly read: (key: string) => Effect.Effect<ObjectRecord | null, Vfs.VfsError>
  /**
   * Optional transport limit. Count bytes as they arrive and fail with
   * `CorruptStore` after releasing an oversized body.
   */
  readonly readBounded?: (
    key: string,
    maxImageBytes: ByteSize.ByteSize
  ) => Effect.Effect<ObjectRecord | null, Vfs.VfsError>
  readonly write: (
    key: string,
    bytes: Uint8Array,
    generation: string,
    digest: string,
    condition: { readonly ifMatch: string } | { readonly ifNoneMatch: "*" }
  ) => Effect.Effect<{ readonly etag: string } | null, Vfs.VfsError>
}

/**
 * Supplies the borrowed R2 transport used by live-image stores. Share a client
 * across distinct object keys while keeping each store owner separately scoped.
 * The store does not close the supplied transport.
 *
 * @example
 * ```ts
 * import { Client, type R2Client } from "@effect-vfs/persistence/R2Store"
 * import { Layer } from "effect"
 *
 * const provideClient = (client: R2Client) => Layer.succeed(Client, client)
 * ```
 *
 * @since 0.12.0
 * @category services
 */
export class Client extends Context.Service<Client, R2Client>()("@effect-vfs/persistence/R2LiveImageStore/Client") {}

const opening = storeFailures("R2LiveImageStore.layer")

const loading = storeFailures("R2LiveImageStore.loadOrCreate")

/** Configuration for one experimental R2-backed image.
 *
 * @example
 * ```ts
 * import type { Options } from "@effect-vfs/persistence/R2Store"
 * import { ByteSize } from "effect"
 *
 * const options: Options = {
 *   key: "effect-vfs-nfs-test/live-image",
 *   maxImageBytes: ByteSize.mebibytes(16)
 * }
 * ```
 *
 * @since 0.5.0
 * @category models
 */
export interface Options {
  readonly key: string
  readonly maxImageBytes: ByteSize.ByteSize
  /** Assert R2's documented synchronous durable-write contract for a verified R2 endpoint and single owner. */
  readonly durability?: "survives-power-loss"
}

/**
 * A single-key experimental store. It passes the image limit to the transport's
 * `readBounded` operation when one is supplied. With a legacy client, the
 * store checks the limit after `read` returns.
 *
 * The application must ensure one live owner;
 * ETag conditions detect stale writes but cannot prevent stale reads.
 *
 * A store scope waits for pending transport operations to settle before
 * releasing ownership. A caller can stop waiting without aborting a transport
 * request. If a write fails with an uncertain remote outcome, keep the key
 * offline until reconciliation establishes that the request cannot still
 * change the object and confirms the stored image.
 *
 * @example
 * ```ts
 * import { Client, layer, type R2Client } from "@effect-vfs/persistence/R2Store"
 * import { ByteSize, Layer } from "effect"
 *
 * const makeStore = (client: R2Client) =>
 *   layer({
 *     key: "workspace-123",
 *     maxImageBytes: ByteSize.mebibytes(4)
 *   }).pipe(Layer.provide(Layer.succeed(Client, client)))
 * ```
 *
 * @since 0.5.0
 * @category layers
 */
export const layer = (
  options: Options
): Layer.Layer<LiveVolume.LiveImageStore, VfsError.ArgumentFailure, Client | Digest.Digest> =>
  Layer.effect(
    LiveVolume.LiveImageStore,
    Effect.gen(function*() {
      if (options.key.length === 0) return yield* opening.invalid("options")
      const { maxImageBytes } = options
      const maxImage = yield* Protocol.imageLimit(maxImageBytes, opening, "options")
      const client = yield* Client
      const scope = yield* Scope.Scope

      // The scope drains the transport even if the caller stops waiting.
      const run = Effect.fnUntraced(function*<A, E>(request: Effect.Effect<A, E>) {
        const pending = yield* Effect.forkIn(Effect.uninterruptible(request), scope)

        return yield* Fiber.join(pending)
      })

      const protocol = yield* Protocol.make({
        maxImage,
        loading,
        durability: options.durability ?? "memory-only",
        storage: {
          read: run(Effect.suspend(() =>
            client.readBounded === undefined
              ? client.read(options.key).pipe(Effect.mapError((cause) => loading.fail("Storage", cause)))
              : client.readBounded(options.key, maxImageBytes).pipe(
                Effect.mapError((cause) =>
                  loading.fail(cause.code === "CorruptStore" ? "CorruptStore" : "Storage", cause)
                )
              )
          )).pipe(
            Effect.flatMap((record) => {
              if (record === null) return Effect.succeed(null)

              if (record.etag === "") return Effect.fail(loading.fail("CorruptStore"))

              return Effect.succeed({
                image: record.bytes,
                generation: record.generation,
                digest: record.digest,
                token: record.etag
              })
            })
          ),
          compareAndSwap: Effect.fnUntraced(function*(expected: string | undefined, next: Protocol.Image) {
            // The request can outlive the caller's ownership of its input bytes.
            const image = new Uint8Array(next.image)

            return yield* run(Effect.suspend(() =>
              client.write(
                options.key,
                image,
                String(next.generation),
                next.digest,
                expected === undefined ? { ifNoneMatch: "*" } : { ifMatch: expected }
              )
            )).pipe(Effect.match({
              onFailure: (cause) => Protocol.WriteResult.Unknown({ cause }),
              onSuccess: (written) => {
                if (written === null) return Protocol.WriteResult.Conflict()

                if (written.etag === "") return Protocol.WriteResult.Unknown({})

                return Protocol.WriteResult.Written({ token: written.etag })
              }
            }))
          })
        }
      })

      return protocol.store
    })
  )
