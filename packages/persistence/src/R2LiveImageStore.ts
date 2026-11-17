/**
 * Experimental whole-image R2 storage for one externally owned live volume.
 * Each mutation replaces one object with an ETag condition. R2's concurrent
 * same-key write limit and the absence of a reader lease require a single
 * application-controlled gateway for the experimental writable NFS profile.
 *
 * @since 0.5.0
 */
import { GetObjectCommand, PutObjectCommand, type S3Client, S3ServiceException } from "@aws-sdk/client-s3"
import { LiveVolume, type VfsError, type VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Context, Effect, Layer } from "effect"
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
  readonly read: (key: string) => Effect.Effect<ObjectRecord | null, Vfs.VfsError>
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

/** Use R2's S3-compatible API from a Bun or Node NFS server.
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
  (bucket: string): (client: S3Client) => R2Client
  (client: S3Client, bucket: string): R2Client
} = dual(2, (client: S3Client, bucket: string): R2Client => ({
  read: (key) =>
    Effect.tryPromise({
      // oxlint-disable-next-line effecttsgo/async-function -- AWS SDK streams and requests use promises at this adapter boundary.
      try: async () => {
        try {
          const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))

          if (object.Body === undefined) throw new Error("R2 object has no body")

          return {
            bytes: await object.Body.transformToByteArray(),
            etag: object.ETag ?? "",
            generation: object.Metadata?.["generation"],
            digest: object.Metadata?.["digest"]
          }
        } catch (error) {
          if (error instanceof S3ServiceException && error.name === "NoSuchKey") return null
          throw error
        }
      },
      catch: (cause) => transport.fail("Storage", cause)
    }),
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
}))

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
 * A single-key experimental store. The application must ensure one live owner;
 * ETag conditions detect stale writes but cannot prevent stale reads.
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
      const maxImage = yield* Protocol.imageLimit(options.maxImageBytes, opening, "options")
      const client = yield* Client

      const protocol = yield* Protocol.make({
        maxImage,
        loading,
        durability: options.durability ?? "memory-only",
        storage: {
          read: Effect.suspend(() => client.read(options.key)).pipe(
            Effect.mapError((cause) => loading.fail("Storage", cause)),
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
            return yield* client.write(
              options.key,
              next.image,
              String(next.generation),
              next.digest,
              expected === undefined ? { ifNoneMatch: "*" } : { ifMatch: expected }
            ).pipe(Effect.match({
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
