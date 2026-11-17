/**
 * AWS SDK transport for the R2 image store.
 *
 * @since 0.12.0
 */
import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  type S3Client,
  S3ServiceException
} from "@aws-sdk/client-s3"
import { Data, Effect } from "effect"
import { dual } from "effect/Function"
import * as Protocol from "./internal/liveImageProtocol.js"
import { storeFailures } from "./internal/storeSupport.js"
import type { R2Client } from "./R2Store.js"

const transport = storeFailures("R2LiveImageStore.fromS3")

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
 * import { fromS3 } from "@effect-vfs/persistence/R2S3Transport"
 *
 * const s3 = new S3Client({
 *   region: "auto",
 *   endpoint: "https://ACCOUNT_ID.r2.cloudflarestorage.com",
 *   credentials: { accessKeyId: "ACCESS_KEY_ID", secretAccessKey: "SECRET_ACCESS_KEY" }
 * })
 * const client = fromS3(s3, "test-bucket")
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
