import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import type { ReadWriteBucketClient } from "alchemy/Cloudflare/R2"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import * as Effect from "effect/Effect"
import type { NotebookR2Client } from "./notebook.js"

const storageError = (cause: unknown) => new Vfs.VfsError({ code: "Storage", operation: "AlchemyStore", cause })

const quote = (etag: string) => `"${etag.replace(/^"|"$/g, "")}"`

const unquote = (etag: string) => etag.replace(/^"|"$/g, "")

/**
 * Adapt an Alchemy native Worker R2 binding to notebook image operations.
 *
 * Call this inside the Worker's Effect runtime, after obtaining a client from
 * `Cloudflare.R2.ReadWriteBucket` with `ReadWriteBucketBinding` provided.
 * Alchemy's HTTP and local R2 clients do not forward conditional writes and
 * custom metadata, so they cannot be used for a live image.
 */
export const fromAlchemy = (
  bucket: ReadWriteBucketClient
): Effect.Effect<NotebookR2Client, never, RuntimeContext> =>
  Effect.gen(function*() {
    const context = yield* Effect.context<RuntimeContext>()

    return {
      read: (key) =>
        bucket.get(key).pipe(
          Effect.provide(context),
          Effect.mapError(storageError),
          Effect.flatMap((object) => {
            if (object === null) return Effect.succeed(null)

            if (!("bytes" in object)) {
              return new Vfs.VfsError({ code: "Storage", operation: "AlchemyStore", cause: "R2 object has no body" })
            }

            if (!object.etag) {
              return new Vfs.VfsError({ code: "Storage", operation: "AlchemyStore", cause: "R2 object has no ETag" })
            }

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
        // The live store uses conditional writes to reject competing writers.
        // R2 reports a failed condition as null, distinct from a storage error.
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

            if (!object.etag) {
              return new Vfs.VfsError({ code: "Storage", operation: "AlchemyStore", cause: "R2 response has no ETag" })
            }

            return Effect.succeed({ etag: quote(object.etag) })
          })
        ),
      remove: (key) => bucket.delete(key).pipe(Effect.provide(context), Effect.mapError(storageError))
    } satisfies NotebookR2Client
  })
