import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { fromAlchemy } from "./from-alchemy.js"
import { Notebook, NotebookR2, NotebookService } from "./notebook.js"

// The R2 bucket used to store notebook images.
export const imageBucket = Cloudflare.R2.Bucket("NotebookImages")

const Reply = Schema.TaggedUnion({
  Error: { error: Schema.String },
  Deleted: { deleted: Schema.Literal(true) },
  CreationFailed: {
    error: Schema.Literal("creation failed"),
    id: Schema.String,
    cleanup: Schema.Literals(["removed", "retry-delete"])
  },
  Notebook: Notebook.fields
})

type Reply = typeof Reply.Type

const encodeReply = Schema.encodeEffect(Schema.fromJsonString(Reply))

const json = Effect.fnUntraced(function*(body: Reply, status = 200) {
  return HttpServerResponse.text(yield* encodeReply(body).pipe(Effect.orDie), {
    status,
    headers: { "content-type": "application/json" }
  })
})

export default Cloudflare.Worker(
  "NotebookWorker",
  { main: import.meta.url },
  Effect.gen(function*() {
    const token = yield* Config.Redacted("NOTEBOOK_TOKEN")
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(imageBucket)

    const MainLive = NotebookService.Live.pipe(
      Layer.provide(Layer.merge(BrowserCrypto.layer, Layer.effect(NotebookR2, fromAlchemy(bucket))))
    )

    return {
      fetch: Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest

        // Authenticate before opening a volume or touching the bucket.
        if (request.headers["authorization"] !== `Bearer ${Redacted.value(token)}`) {
          return yield* json(Reply.cases.Error.make({ error: "unauthorized" }), 401)
        }

        const notebooks = yield* NotebookService

        const match = /^\/notebooks\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
          request.url
        )

        const notebookId = match?.[1]

        return yield* Match.value({ url: request.url, method: request.method, notebookId }).pipe(
          Match.when(
            { url: "/notebooks", method: "POST" },
            Effect.fnUntraced(function*() {
              const result = yield* notebooks.create

              return yield* Result.match(result, {
                onSuccess: (notebook) => json(Reply.cases.Notebook.make(notebook), 201),
                onFailure: ({ id, cleanup }) =>
                  json(Reply.cases.CreationFailed.make({ error: "creation failed", id, cleanup }), 500)
              })
            })
          ),
          Match.when(
            { method: "GET", notebookId: Match.string },
            Effect.fnUntraced(function*({ notebookId }) {
              const result = yield* notebooks.read(notebookId)

              if (result === null) {
                return yield* json(Reply.cases.Error.make({ error: "not found" }), 404)
              }

              return yield* json(Reply.cases.Notebook.make(result))
            })
          ),
          Match.when(
            { method: "DELETE", notebookId: Match.string },
            Effect.fnUntraced(function*({ notebookId }) {
              yield* notebooks.remove(notebookId)

              return yield* json(Reply.cases.Deleted.make({ deleted: true }))
            })
          ),
          Match.orElse(() => json(Reply.cases.Error.make({ error: "not found" }), 404))
        )
      }).pipe(
        Effect.provide(MainLive),
        Effect.catch(() => json(Reply.cases.Error.make({ error: "operation failed" }), 500))
      )
    }
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding))
)
