import { S3Client } from "@aws-sdk/client-s3"
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { R2DemoConfig } from "./config.js"

export const makeR2Client = Effect.fn("R2Demo.makeClient")(function*(config: R2DemoConfig) {
  const s3 = yield* Effect.acquireRelease(
    Effect.sync(() =>
      new S3Client({
        region: "auto",
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: Redacted.value(config.accessKeyId),
          secretAccessKey: Redacted.value(config.secretAccessKey)
        },
        forcePathStyle: true,
        // An SDK retry could make a lost write reply look like a confirmed result.
        maxAttempts: 1
      })
    ),
    (client) => Effect.sync(() => client.destroy())
  )

  // The HTTP fault drops a successful conditional PUT reply before the SDK sees it.
  let lostHttpReply = false
  let successfulConditionalWrites = 0

  const faultS3 = config.loseHttpReplyOnce
    ? yield* Effect.acquireRelease(
      Effect.sync(() =>
        new S3Client({
          region: "auto",
          endpoint: config.endpoint,
          credentials: {
            accessKeyId: Redacted.value(config.accessKeyId),
            secretAccessKey: Redacted.value(config.secretAccessKey)
          },
          forcePathStyle: true,
          maxAttempts: 1,
          requestHandler: {
            // oxlint-disable-next-line effecttsgo/async-function -- AWS SDK request handlers use promises.
            handle: async (
              request: Parameters<typeof s3.config.requestHandler.handle>[0],
              options: Parameters<typeof s3.config.requestHandler.handle>[1]
            ) => {
              const result = await s3.config.requestHandler.handle(request, options)
              const conditional = Object.keys(request.headers).some((name) => name.toLowerCase() === "if-match")

              if (
                request.method === "PUT" && conditional && !lostHttpReply &&
                result.response.statusCode >= 200 && result.response.statusCode < 300
              ) {
                successfulConditionalWrites++

                if (successfulConditionalWrites > config.httpFaultSkipWrites) {
                  lostHttpReply = true
                  throw new Error("test fault: lost successful R2 HTTP response")
                }
              }

              return result
            },
            // The base client's handler owns the connection and is released with s3.
            destroy: () => {}
          }
        })
      ),
      (client) => Effect.sync(() => client.destroy())
    )
    : s3

  const remote = R2LiveImageStore.fromS3(faultS3, config.bucket)
  let lostReply = false

  // This fault drops the reply after the R2 adapter accepts a conditional write.
  const client: R2LiveImageStore.R2Client = config.loseR2ReplyOnce
    ? {
      read: remote.read,
      write: (key, image, generation, digest, condition) =>
        Effect.flatMap(remote.write(key, image, generation, digest, condition), (result) => {
          if (!lostReply && "ifMatch" in condition && result !== null) {
            lostReply = true

            return Effect.fail(
              new Vfs.VfsError({
                code: "Storage",
                operation: "R2Client",
                cause: new Error("test fault: R2 accepted a write but its reply was lost")
              })
            )
          }

          return Effect.succeed(result)
        })
    }
    : remote

  return client
})
