/**
 * Experimental whole-image R2 storage for one externally owned live volume.
 * Each mutation replaces one object with an ETag condition. R2's concurrent
 * same-key write limit and the absence of a reader lease require a single
 * application-controlled gateway for the experimental writable NFS profile.
 *
 * @since 0.5.0
 */
import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  type S3Client,
  S3ServiceException
} from "@aws-sdk/client-s3"
import { LiveVolume, type VfsError, type VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Context, Data, Effect, Fiber, Layer, Scope } from "effect"
import type * as ByteSize from "effect/ByteSize"
import type * as Digest from "effect/crypto/Digest"
import { dual } from "effect/Function"
import * as Protocol from "./internal/liveImageProtocol.js"
import { storeFailures } from "./internal/storeSupport.js"

/** A complete R2 image plus the metadata needed to validate and fence it.
 *
 * @example
 * ```ts
 * import type { ObjectRecord } from "@effect-vfs/persistence/R2LiveImageStore"
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
 * import { S3Client } from "@aws-sdk/client-s3"
 * import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
 *
 * const s3 = new S3Client({
 *   region: "auto",
 *   endpoint: "https://ACCOUNT_ID.r2.cloudflarestorage.com",
 *   credentials: { accessKeyId: "ACCESS_KEY_ID", secretAccessKey: "SECRET_ACCESS_KEY" }
 * })
 * const client: R2LiveImageStore.R2Client = R2LiveImageStore.fromS3(s3, "test-bucket")
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
 * import { S3Client } from "@aws-sdk/client-s3"
 * import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
 * import { Layer } from "effect"
 *
 * const s3 = new S3Client({
 *   region: "auto",
 *   endpoint: "https://ACCOUNT_ID.r2.cloudflarestorage.com",
 *   credentials: { accessKeyId: "ACCESS_KEY_ID", secretAccessKey: "SECRET_ACCESS_KEY" }
 * })
 * const R2ClientLayer = Layer.succeed(
 *   R2LiveImageStore.Client,
 *   R2LiveImageStore.fromS3(s3, "workspace-images")
 * )
 * ```
 *
 * @since 0.12.0
 * @category services
 */
export class Client extends Context.Service<Client, R2Client>()("@effect-vfs/persistence/R2LiveImageStore/Client") {}

const transport = storeFailures("R2LiveImageStore.fromS3")

const opening = storeFailures("R2LiveImageStore.layer")

const loading = storeFailures("R2LiveImageStore.loadOrCreate")

class OversizedBody extends Data.TaggedError("OversizedBody")<{}> {}

type Body = NonNullable<GetObjectCommandOutput["Body"]>

// oxlint-disable-next-line effecttsgo/async-function -- The SDK provides native asynchronous byte streams.
const readBody = async (body: Body, contentLength: number | undefined, limit: number) => {
  if (contentLength !== undefined && contentLength > limit) {
    if ("destroy" in body) body.destroy()
    else if ("cancel" in body) await body.cancel().catch(() => undefined)

    throw new OversizedBody()
  }

  const stream = "stream" in body ? body.stream() : body
  let image = new Uint8Array()
  let length = 0

  // Exiting either native iterator early releases its body. Iterate the Node
  // response directly to avoid additional buffering in a Web Stream wrapper.
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("R2 body returned a non-byte chunk")

    if (chunk.byteLength > limit - length) throw new OversizedBody()
    const next = length + chunk.byteLength

    if (next > image.byteLength) {
      const grown = new Uint8Array(Math.min(limit, Math.max(next, image.byteLength * 2)))
      grown.set(image)
      image = grown
    }

    image.set(chunk, length)
    length = next
  }

  return image.subarray(0, length)
}

/** Use R2's S3-compatible API from a Bun or Node NFS server.
 *
 * A store using this client enforces its per-store limit while reading the body.
 * Direct calls to the client's legacy `read` still materialize the entire object.
 *
 * @example
 * ```ts
 * import { S3Client } from "@aws-sdk/client-s3"
 * import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
 *
 * const s3 = new S3Client({
 *   region: "auto",
 *   endpoint: "https://ACCOUNT_ID.r2.cloudflarestorage.com",
 *   credentials: { accessKeyId: "ACCESS_KEY_ID", secretAccessKey: "SECRET_ACCESS_KEY" }
 * })
 * const client = R2LiveImageStore.fromS3(s3, "test-bucket")
 * ```
 *
 * @since 0.5.0
 * @category constructors
 */
export const fromS3: {
  (bucket: string): (client: S3Client) => R2Client & Required<Pick<R2Client, "readBounded">>
  (client: S3Client, bucket: string): R2Client & Required<Pick<R2Client, "readBounded">>
} = dual(2, (client: S3Client, bucket: string) => {
  const read = (key: string, limit?: number) =>
    Effect.tryPromise({
      // oxlint-disable-next-line effecttsgo/async-function -- AWS SDK streams and requests use promises at this adapter boundary.
      try: async () => {
        try {
          const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))

          if (object.Body === undefined) throw new Error("R2 object has no body")

          return {
            bytes: limit === undefined
              ? await object.Body.transformToByteArray()
              : await readBody(object.Body, object.ContentLength, limit),
            etag: object.ETag ?? "",
            generation: object.Metadata?.["generation"],
            digest: object.Metadata?.["digest"]
          }
        } catch (error) {
          if (error instanceof S3ServiceException && error.name === "NoSuchKey") return null
          throw error
        }
      },
      catch: (cause) => transport.fail(cause instanceof OversizedBody ? "CorruptStore" : "Storage", cause)
    })

  return {
    read: (key) => read(key),
    readBounded: (key, maxImageBytes) =>
      Protocol.imageLimit(maxImageBytes, transport).pipe(
        Effect.flatMap((limit) => read(key, Number(limit)))
      ),
    write: (key, bytes, generation, digest, condition) =>
      Effect.tryPromise({
        // oxlint-disable-next-line effecttsgo/async-function -- AWS SDK requests use promises at this adapter boundary.
        try: async () => {
          try {
            const result = await client.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: bytes,
                Metadata: { generation, digest },
                ...("ifMatch" in condition ? { IfMatch: condition.ifMatch } : { IfNoneMatch: "*" })
              })
            )

            if (result.ETag === undefined || result.ETag === "") throw new Error("R2 response has no ETag")

            return { etag: result.ETag }
          } catch (error) {
            if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) return null
            throw error
          }
        },
        catch: (cause) => transport.fail("Storage", cause)
      })
  } satisfies R2Client
})

/** Configuration for one experimental R2-backed image.
 *
 * @example
 * ```ts
 * import type { Options } from "@effect-vfs/persistence/R2LiveImageStore"
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
 * releasing ownership. A caller can stop waiting without aborting an SDK
 * request. If a write fails with an uncertain remote outcome, keep the key
 * offline until reconciliation establishes that the request cannot still
 * change the object and confirms the stored image.
 *
 * @example
 * ```ts
 * import { S3Client } from "@aws-sdk/client-s3"
 * import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
 * import { ByteSize, Layer } from "effect"
 *
 * const s3 = new S3Client({
 *   region: "auto",
 *   endpoint: "https://ACCOUNT_ID.r2.cloudflarestorage.com",
 *   credentials: { accessKeyId: "ACCESS_KEY_ID", secretAccessKey: "SECRET_ACCESS_KEY" }
 * })
 * const R2ClientLayer = Layer.succeed(
 *   R2LiveImageStore.Client,
 *   R2LiveImageStore.fromS3(s3, "workspace-images")
 * )
 * const Store = R2LiveImageStore.layer({
 *   key: "workspace-123",
 *   maxImageBytes: ByteSize.mebibytes(4)
 * }).pipe(Layer.provide(R2ClientLayer))
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
