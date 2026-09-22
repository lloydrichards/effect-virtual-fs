import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

import NotebookWorker, { imageBucket } from "./src/notebook-worker.js"

export default Alchemy.Stack(
  "EffectVfsNotebook",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function*() {
    const bucket = yield* imageBucket
    const worker = yield* NotebookWorker

    return { bucketName: bucket.bucketName, url: worker.url }
  })
)
