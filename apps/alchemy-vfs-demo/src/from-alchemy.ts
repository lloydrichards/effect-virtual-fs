import { LiveVolume } from "@effect-vfs/core"
import type { R2Client } from "@effect-vfs/persistence/R2LiveImageStore"
import type { ReadWriteBucketClient } from "alchemy/Cloudflare/R2"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import * as Effect from "effect/Effect"

const storageError = (cause: unknown) => new LiveVolume.LiveVolumeError({ code: "Storage", cause })

const quote = (etag: string) => `"${etag.replace(/^"|"$/g, "")}"`

const unquote = (etag: string) => etag.replace(/^"|"$/g, "")

/**
 * Adapt an Alchemy native Worker R2 binding to the live image store.
 *
 * Call this inside the Worker's Effect runtime, after obtaining a client from
 * `Cloudflare.R2.ReadWriteBucket` with `ReadWriteBucketBinding` provided.
 * Alchemy's HTTP and local R2 clients do not forward conditional writes and
 * custom metadata, so they cannot be used for a live image.
 */
export const fromNativeBinding = (bucket: ReadWriteBucketClient): Effect.Effect<R2Client, never, RuntimeContext> =>
  Effect.gen(function*() {
    const context = yield* Effect.context<RuntimeContext>()

    return {
      read: (key) =>
        bucket.get(key).pipe(
          Effect.provide(context),
          Effect.mapError(storageError),
          Effect.flatMap((object) => {
            if (object === null) return Effect.succeed(null)

            if (!("bytes" in object)) return Effect.fail(storageError(new Error("R2 object has no body")))

            if (!object.etag) return Effect.fail(storageError(new Error("R2 object has no ETag")))

            return object.bytes().pipe(
              Effect.mapError(storageError),
              Effect.map((bytes) => ({
                bytes,
                etag: quote(object.etag),
                generation: object.customMetadata?.["generation"],
                digest: object.customMetadata?.["digest"]
              }))
            )
          })
        ),
      write: (key, bytes, generation, digest, condition) =>
        bucket.put(key, bytes, {
          customMetadata: { generation, digest },
          onlyIf: "ifMatch" in condition
            ? { etagMatches: unquote(condition.ifMatch) }
            : { etagDoesNotMatch: "*" }
        }).pipe(
          Effect.provide(context),
          Effect.mapError(storageError),
          Effect.flatMap((object) => {
            if (object === null) return Effect.succeed(null)

            if (!object.etag) return Effect.fail(storageError(new Error("R2 response has no ETag")))

            return Effect.succeed({ etag: quote(object.etag) })
          })
        )
    } satisfies R2Client
  })
