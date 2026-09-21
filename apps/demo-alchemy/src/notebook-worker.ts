import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Redacted from "effect/Redacted"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { imageBucket } from "./bucket.js"
import { fromNativeBinding } from "./from-alchemy.js"
import { createWithCleanup, keyFor, type Notebook, readNotebook } from "./notebook.js"
import * as WorkerCrypto from "./worker-crypto.js"

type Reply = { readonly error: string } | { readonly deleted: true } | {
  readonly error: "creation failed"
  readonly id: string
  readonly cleanup: "removed" | "retry-delete"
} | Notebook

const json = (body: Reply, status = 200) =>
  HttpServerResponse.text(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export default Cloudflare.Worker(
  "NotebookWorker",
  { main: import.meta.url },
  Effect.gen(function*() {
    const token = yield* Config.Redacted("NOTEBOOK_TOKEN")
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(imageBucket)

    return {
      fetch: Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest

        // Authenticate before opening a volume or touching the bucket.
        if (request.headers["authorization"] !== `Bearer ${Redacted.value(token)}`) {
          return json({ error: "unauthorized" }, 401)
        }

        if (request.url === "/notebooks" && request.method === "POST") {
          const id = yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4))

          const client = yield* fromNativeBinding(bucket)
          const result = yield* createWithCleanup(client, id, bucket.delete(keyFor(id)))

          return Match.value(result).pipe(
            Match.tag("Created", ({ notebook }) => json(notebook, 201)),
            Match.tag("Failed", ({ id, cleanup }) => json({ error: "creation failed", id, cleanup }, 500)),
            Match.exhaustive
          )
        }

        const match = /^\/notebooks\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
          request.url
        )

        const notebookId = match?.[1]

        if (notebookId && request.method === "GET") {
          const client = yield* fromNativeBinding(bucket)
          const result = yield* readNotebook(client, notebookId)

          return result === null ? json({ error: "not found" }, 404) : json(result)
        }

        if (notebookId && request.method === "DELETE") {
          yield* bucket.delete(keyFor(notebookId))

          return json({ deleted: true })
        }

        return json({ error: "not found" }, 404)
      }).pipe(
        Effect.provide(WorkerCrypto.layer),
        Effect.orElseSucceed(() => json({ error: "operation failed" }, 500))
      )
    }
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding))
)
