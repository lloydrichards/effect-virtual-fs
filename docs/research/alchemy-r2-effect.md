# Alchemy, Effect, and an R2-backed VFS example

Researched 2026-09-21 against Alchemy's current v2 documentation. Its older `v1.alchemy.run` examples use a different API and should not be copied into a new app.

## What Alchemy contributes

Infrastructure as code means that a TypeScript program declares cloud resources and their connections. Alchemy's `Stack` gathers that desired state; `alchemy plan` shows changes, and `alchemy deploy` provisions or updates them. Resource declarations are Effects, so they compose with the repo's Effect style. A Worker can receive a typed R2 binding from the same stack. [Resources](https://alchemy.run/infrastructure-as-code/resource/), [CLI](https://alchemy.run/cli/), [Workers](https://alchemy.run/cloudflare/compute/workers/)

The current minimal shape is:

```ts
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

export const Bucket = Cloudflare.R2.Bucket("Bucket")
export const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  env: { Bucket }
})

export default Alchemy.Stack(
  "VfsDemo",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function*() {
    const worker = yield* Worker
    return { url: worker.url }
  })
)
```

In a plain async handler, `Cloudflare.InferEnv<typeof Worker>` types `env.Bucket` as a native `R2Bucket`. In an Effect Worker, `Cloudflare.R2.ReadWriteBucket(Bucket)` gives an Effect client and `Cloudflare.R2.ReadWriteBucketBinding` supplies the native binding layer. The choice depends on whether the VFS adapter runs in a Cloudflare Worker or in a local Bun process. [Workers](https://alchemy.run/cloudflare/compute/workers/), [R2](https://alchemy.run/cloudflare/data/r2/), [Bindings](https://alchemy.run/infrastructure-as-effects/binding/)

## Fit with this repository

The existing `R2LiveImageStore.fromS3` is a good **local/Bun** path. It uses S3 credentials and endpoint to supply `R2Client`. An Alchemy-managed Worker gets an R2 binding instead. The demo now includes `src/from-alchemy.ts`, a small adapter over the native Effect binding that preserves generation and digest metadata, ETags, and conditional writes. The adapter has in-memory binding tests. On 2026-09-21, a deployed Worker passed native R2 read, write, conditional update, metadata, and cleanup checks. With a bucket-scoped S3 key, the real-bucket interoperability test also passed in both directions: native write to `fromS3` read, then `fromS3` conditional write to native read. The test rejected a stale native write and left no objects under its test prefix. Merely binding the bucket does not turn the existing S3 adapter into Worker code. Local source: [`packages/persistence/src/R2LiveImageStore.ts`](../../packages/persistence/src/R2LiveImageStore.ts). The native binding's read/write API is illustrated in [Alchemy's R2 guide](https://alchemy.run/cloudflare/data/r2/).

The demo now uses the native Alchemy R2 binding for its full VFS flow in a Worker. A `POST` creates a fresh live image and publishes a file; a later `GET` reopens the image from R2, and `DELETE` removes it. Each image has one writer. The separate S3 path remains available for local applications, but the Worker demo needs no S3 credentials. On 2026-09-21 the deployed Worker passed the create, reopen, delete, unauthorized, and missing-image checks against real R2.

## Running and credentials

Alchemy's current CLI supports `plan`, `deploy`, `dev`, and `destroy`, and accepts `--env-file`. `alchemy dev` uses a different default stage from `alchemy deploy`, avoiding accidental replacement of the deployed stage. A Cloudflare profile or `CLOUDFLARE_API_TOKEN` authorizes the provisioning API; the R2 S3 access-key pair from the prior test authorizes object traffic and is not by itself a deploy credential. An R2 object token scoped to one bucket may therefore be insufficient to create a Worker or a new bucket. [CLI](https://alchemy.run/cli/), [Stages](https://alchemy.run/environments/stages/), [Cloudflare auth](https://alchemy.run/cloudflare/tutorial/part-5/)

By default Alchemy generates a new bucket name. To reuse an existing bucket, pin its physical name and explicitly adopt it; adoption makes the stack manage that bucket and its lifecycle, so a dedicated demo bucket is safer. `destroy` cannot delete a nonempty R2 bucket by default; `forceDestroy` explicitly permits emptying it, while `RemovalPolicy.retain()` keeps it. [R2](https://alchemy.run/cloudflare/data/r2/), [Migration/adoption](https://alchemy.run/migrating-from-v1/)
