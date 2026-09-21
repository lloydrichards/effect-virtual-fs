/**
 * Experimental whole-image R2 storage for one externally owned live volume.
 * Each mutation replaces one object with an ETag condition. R2's concurrent
 * same-key write limit and the absence of a reader lease make this unsuitable for a
 * public writable NFS export without further qualification.
 *
 * @since 0.5.0
 */
import { GetObjectCommand, PutObjectCommand, type S3Client, S3ServiceException } from "@aws-sdk/client-s3"
import { LiveVolume } from "@effect-vfs/core"
import { ByteSize, Crypto, Effect, Exit, Layer } from "effect"

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
 */
export interface R2Client {
  readonly read: (key: string) => Effect.Effect<ObjectRecord | null, LiveVolume.LiveVolumeError>
  readonly write: (
    key: string,
    bytes: Uint8Array,
    generation: string,
    digest: string,
    condition: { readonly ifMatch: string } | { readonly ifNoneMatch: "*" }
  ) => Effect.Effect<{ readonly etag: string } | null, LiveVolume.LiveVolumeError>
}

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
 */
export const fromS3 = (client: S3Client, bucket: string): R2Client => ({
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
      catch: (cause) => new LiveVolume.LiveVolumeError({ code: "Storage", cause })
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
      catch: (cause) => new LiveVolume.LiveVolumeError({ code: "Storage", cause })
    })
})

/** Configuration for one experimental R2-backed image.
 *
 * @example
 * ```ts
 * import type { Options } from "@effect-vfs/persistence/R2LiveImageStore"
 * import { Effect, ByteSize } from "effect"
 *
 * const client = {
 *   read: (_key: string) => Effect.succeed(null),
 *   write: () => Effect.succeed(null)
 * }
 * const options: Options = {
 *   client,
 *   key: "effect-vfs-nfs-test/live-image",
 *   maxImageBytes: ByteSize.mebibytes(16)
 * }
 * ```
 *
 * @since 0.5.0
 */
export interface Options {
  readonly client: R2Client
  readonly key: string
  readonly maxImageBytes: ByteSize.ByteSize
}

const fail = (code: LiveVolume.LiveVolumeError["code"], cause?: unknown) =>
  new LiveVolume.LiveVolumeError({ code, cause })

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * A single-key experimental store. The application must ensure one live owner;
 * ETag conditions detect stale writes but cannot prevent stale reads.
 *
 * @example
 * ```ts
 * import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
 * import { ByteSize, Effect } from "effect"
 *
 * const client: R2LiveImageStore.R2Client = {
 *   read: () => Effect.succeed(null),
 *   write: () => Effect.succeed(null)
 * }
 * const store = R2LiveImageStore.layer({
 *   client,
 *   key: "effect-vfs-nfs-test/live-image",
 *   maxImageBytes: ByteSize.mebibytes(16)
 * })
 * ```
 *
 * @since 0.5.0
 */
export const layer = (options: Options) =>
  Layer.effect(
    LiveVolume.LiveImageStore,
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const maxImage = ByteSize.toBigInt(options.maxImageBytes)

      if (options.key.length === 0 || maxImage <= 0n) return yield* fail("InvalidConfiguration")

      let generation: number | undefined
      let etag: string | undefined
      let available = true

      const digest = (image: Uint8Array) => Effect.map(crypto.digest("SHA-256", image), hex)

      const validate = Effect.fnUntraced(function*(record: ObjectRecord) {
        if (
          record.etag === "" || BigInt(record.bytes.length) > maxImage ||
          record.generation === undefined || !/^(0|[1-9][0-9]*)$/.test(record.generation) ||
          record.digest === undefined || !/^[0-9a-f]{64}$/.test(record.digest)
        ) return yield* fail("CorruptStore")

        const parsed = Number(record.generation)

        if (!Number.isSafeInteger(parsed)) return yield* fail("CorruptStore")
        const actual = yield* digest(record.bytes).pipe(Effect.mapError((cause) => fail("Storage", cause)))

        if (actual !== record.digest) return yield* fail("CorruptStore")
        generation = parsed
        etag = record.etag

        return new Uint8Array(record.bytes)
      })

      return LiveVolume.LiveImageStore.of({
        loadOrCreate: Effect.fnUntraced(function*(initial: Uint8Array) {
          if (!available) return yield* fail("Storage")

          if (generation !== undefined) return yield* fail("Ownership")

          const existing = yield* options.client.read(options.key).pipe(
            Effect.mapError((cause) => fail("Storage", cause))
          )

          if (existing !== null) return yield* validate(existing)

          if (BigInt(initial.length) > maxImage) return yield* fail("InvalidConfiguration")

          const hash = yield* digest(initial).pipe(Effect.mapError((cause) => fail("Storage", cause)))

          const created = yield* options.client.write(options.key, initial, "0", hash, { ifNoneMatch: "*" }).pipe(
            Effect.mapError((cause) => fail("Storage", cause))
          )

          if (created === null) {
            const winner = yield* options.client.read(options.key).pipe(
              Effect.mapError((cause) => fail("Storage", cause))
            )

            if (winner === null) return yield* fail("Storage")

            return yield* validate(winner)
          }

          if (created.etag === "") return yield* fail("Storage")
          generation = 0
          etag = created.etag

          return new Uint8Array(initial)
        }),
        commit: Effect.fnUntraced(function*(image: Uint8Array) {
          if (!available || generation === undefined || etag === undefined) return "unknown" as const

          if (BigInt(image.length) > maxImage || generation === Number.MAX_SAFE_INTEGER) return "rejected" as const

          const hashed = yield* Effect.exit(digest(image))

          if (Exit.isFailure(hashed)) return "rejected" as const

          const written = yield* Effect.exit(options.client.write(
            options.key,
            image,
            String(generation + 1),
            hashed.value,
            { ifMatch: etag }
          ))

          if (Exit.isFailure(written) || written.value === null || written.value.etag === "") {
            available = false

            return "unknown" as const
          }

          generation++
          etag = written.value.etag

          return "committed" as const
        })
      })
    })
  )
