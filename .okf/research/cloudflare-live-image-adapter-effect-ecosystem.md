---
type: Research
title: Effect integration choices for a Cloudflare live image store
description: Available Effect integrations and the custom work needed for R2, Durable Objects, or D1 live image persistence.
status: draft
tags: [effect, cloudflare, r2, durable-objects, d1, persistence]
sources:
  - id: live-contract
    resource: ../../packages/core/src/LiveVolume.ts
    title: LiveImageStore contract
  - id: writable-test-app
    resource: ../../apps/nfs-r2-writable-test/README.md
    title: Local R2-backed writable NFS test app
  - id: effect-manifest
    resource: ../../packages/core/package.json
    title: Repository Effect version
  - id: effect-packages
    resource: https://github.com/Effect-TS/effect/blob/main/README.md
    title: Effect v4 packages
  - id: effect-migration
    resource: https://github.com/Effect-TS/effect/blob/main/MIGRATION.md
    title: Effect v4 migration and package versioning
  - id: effect-cf
    resource: https://github.com/danieljvdm/effect-cf
    title: Third-party Effect Cloudflare bindings
  - id: effect-cf-manifest
    resource: https://github.com/danieljvdm/effect-cf/blob/main/packages/effect-cf/package.json
    title: effect-cf peer dependencies
  - id: effect-aws
    resource: https://github.com/floydspace/effect-aws
    title: Third-party Effect AWS S3 client
  - id: effect-aws-manifest
    resource: https://github.com/floydspace/effect-aws/blob/main/packages/client-s3/package.json
    title: Effect AWS S3 peer dependencies
  - id: effect-d1-code
    resource: https://github.com/Effect-TS/effect/blob/main/packages/sql/d1/src/D1Client.ts
    title: Effect D1 driver source
  - id: r2-workers
    resource: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
    title: R2 Workers binding API
  - id: r2-s3
    resource: https://developers.cloudflare.com/r2/api/s3/api/
    title: R2 S3 API compatibility
  - id: r2-limits
    resource: https://developers.cloudflare.com/r2/platform/limits/
    title: R2 limits
  - id: do-storage
    resource: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
    title: Durable Object SQLite storage API
  - id: do-limit
    resource: https://developers.cloudflare.com/durable-objects/platform/limits/
    title: Durable Object limits
  - id: do-transaction-issue
    resource: https://github.com/Effect-TS/effect-smol/issues/2216
    title: Resolved Effect Durable Object transaction issue
  - id: do-driver
    resource: https://github.com/Effect-TS/effect/blob/main/packages/sql/sqlite-do/src/SqliteClient.ts
    title: Current Effect Durable Object SQLite driver
  - id: alchemy-r2
    resource: https://alchemy.run/cloudflare/data/r2/
    title: Alchemy R2 provisioning and Effect runtime clients
  - id: alchemy-do
    resource: https://alchemy.run/cloudflare/compute/durable-objects/
    title: Alchemy Durable Object deployment and typed RPC
generated: { by: codex/okf, at: 2026-09-21T14:29:00Z }
---

# Effect integration choices for a Cloudflare live image store

The repository uses Effect `4.0.0-rc.114`. `LiveImageStore` is only two operations: `loadOrCreate(initial)` and `commit(image)`. Its provider must exclusively own the image, replace it atomically, and distinguish confirmed success, confirmed rejection, and an outcome that cannot be determined. This small seam makes a new provider feasible, but no storage client implements those semantics for this repository automatically. [Contract](../../packages/core/src/LiveVolume.ts), [manifest](../../packages/core/package.json).

## Existing packages

| Choice                            | Available integration                                                                                                                                                                                                                                                                                                                                                                                                                           | What remains custom                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2 from a Worker                  | Cloudflare's typed R2 bucket binding has `get`, `put`, conditional `put`, and metadata. The independent [`effect-cf`](https://github.com/danieljvdm/effect-cf) project offers Effect bindings for R2 and Durable Objects. Effect's official v4 package list contains no R2 driver or Cloudflare platform package.                                                                                                                               | Wrap binding operations in Effect, encode/decode and validate the complete image, map errors and uncertain responses, and prevent competing owners. Conditional `put` can fence an old image version, but the current `commit(image)` contract has no expected generation parameter. The binding is available inside a Cloudflare Worker, not directly in the repository's Bun-side TCP NFS server. |
| R2 from a Bun or Node NFS gateway | R2 exposes an S3-compatible HTTP API. The standard AWS SDK v3 S3 client can use it from the existing TCP server process. The independent [`@effect-aws/client-s3`](https://github.com/floydspace/effect-aws) wraps that SDK but declares `effect >=3.0.4 <4.0.0`, so it is incompatible with this repository's Effect v4 RC.                                                                                                                    | Configure the R2 endpoint and credentials, wrap AWS SDK v3 calls with Effect, verify actual `PutObject` conditional behavior through the chosen client, and implement the image and outcome logic. This route fits the present NFS runtime without moving the server into a Worker.                                                                                                                 |
| Durable Object SQLite             | First-party Effect v4 includes [`@effect/sql-sqlite-do`](https://github.com/Effect-TS/effect/blob/main/README.md). Cloudflare supplies the DO storage binding directly. The [current driver](https://github.com/Effect-TS/effect/blob/main/packages/sql/sqlite-do/src/SqliteClient.ts) supports `withTransaction` when passed `ctx.storage`; the earlier [transaction issue](https://github.com/Effect-TS/effect-smol/issues/2216) is resolved. | Implement the live-image schema, checksum, generation, ownership, and error mapping. A whole-image BLOB is capped by Cloudflare's 2 MB row/value limit. Test the driver's transaction path on the exact pinned RC before relying on it.                                                                                                                                                             |
| D1                                | First-party Effect v4 includes [`@effect/sql-d1`](https://github.com/Effect-TS/effect/blob/main/README.md), which takes a Workers `D1Database` binding. Its driver supports atomic `batch`, but not generic `withTransaction`.                                                                                                                                                                                                                  | Design the schema and commit protocol. D1 is a SQL client integration, not a live-image provider. The same 2 MB BLOB ceiling makes a single-row whole image unsuitable for larger volumes. A Bun-side NFS server would need a remote API or separate D1 HTTP client.                                                                                                                                |

Effect v4 packages are released at matching versions, so an official SQL package should be installed at the same RC as this repository before evaluation. Current `effect-cf` declares `effect ^4.0.0-rc.115`, excluding the repository's `rc.114`; it is a third-party option after a coordinated upgrade. Another third-party project, [`effectful-cloudflare`](https://github.com/nr1brolyfan/effectful-cloudflare), advertises R2, D1, and DO wrappers, but its compatibility has not been checked here. [Effect package list](https://github.com/Effect-TS/effect/blob/main/README.md), [v4 versioning](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md), [effect-cf manifest](https://github.com/danieljvdm/effect-cf/blob/main/packages/effect-cf/package.json), [Effect AWS S3 manifest](https://github.com/floydspace/effect-aws/blob/main/packages/client-s3/package.json), [D1 driver](https://github.com/Effect-TS/effect/blob/main/packages/sql/d1/src/D1Client.ts).

The official v4 source tree currently contains `@effect/sql-d1` and `@effect/sql-sqlite-do` at `4.0.0-rc.116`. The repository's `rc.114` has not been changed or typechecked with either package in this investigation; pin matching versions if available, or upgrade the repository coherently before adoption. [D1 manifest](https://github.com/Effect-TS/effect/blob/main/packages/sql/d1/package.json), [DO manifest](https://github.com/Effect-TS/effect/blob/main/packages/sql/sqlite-do/package.json).

## Alchemy

Alchemy now covers more than resource deployment. Its current R2 API provisions a bucket and supplies Effect-based `ReadBucket`, `WriteBucket`, and `ReadWriteBucket` capabilities. It also offers D1 bindings and typed Durable Object methods. Its `alchemy@2.0.0-beta.77` peer dependency accepts this repository's Effect `rc.114`. However, inspection of the installed `R2/WriteBucketHttp.ts` implementation found that it omits `onlyIf` and `customMetadata` from HTTP `put` requests, even though the `WriteBucketClient` interface accepts them. The Bun-hosted NFS process would use that HTTP path, so this version cannot safely perform the required conditional image replacement through Alchemy's R2 client. The Worker binding path is separate. Alchemy remains useful for provisioning or a future Durable Object coordinator; the current prototype uses the AWS S3 SDK for R2 transport. Neither client supplies this repository's `LiveImageStore` commit protocol, ownership, recovery, or NFS durability proof. [Alchemy R2](https://alchemy.run/cloudflare/data/r2/), [Alchemy Durable Objects](https://alchemy.run/cloudflare/compute/durable-objects/), [Cloudflare conditional R2 writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

## Practical first experiment

The first prototype uses the S3-compatible API. It records a generation and digest with the complete image, fences replacements with an ETag condition, and freezes the store after an uncertain commit. Fake-client tests cover reopening, a stale writer, corruption, and a lost response. On 2026-09-21, `bun run --filter @effect-vfs/persistence test:r2` passed against a real R2 bucket: create, create-only conflict rejection, conditional replacement, reopen of the committed image, stale ETag rejection, and test-object deletion all succeeded. The follow-up `test:r2:fault` run passed a simulated lost reply after R2 accepted the write, an HTTP-handler fault that discarded a successful response, a sequential stale-owner check, a concurrent two-writer race, and eight sequential commits to one key. The race acknowledged exactly one writer and reopened its image. The eight sequential commits each took roughly 200–300 ms and all succeeded. `test:r2:volume` passed through the public `LiveVolume` API across three fresh Bun processes: write a file, reopen and update it, then reopen and read the update. All test objects were deleted. These runs do not establish behavior under actual connection loss, physical power loss, larger images, or sustained NFS load. A durable coordinator such as one Durable Object per volume may be necessary. This is an experiment, not a release qualification. [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [live-image contract](../../packages/core/src/LiveVolume.ts).

Cloudflare documents a one-per-second limit for **concurrent** writes to the same object key and says higher-rate concurrent writes can return HTTP 429. The real-bucket probe accepted eight sequential small-image commits in roughly two seconds, so that published limit should not be read as a hard one-write-per-second ceiling for serialized commits. Larger images and realistic NFS mutation streams still need measurement. Generation-specific keys could spread contention but require an atomic, durable pointer or owner elsewhere; key rotation alone does not solve coordination. [R2 limits](https://developers.cloudflare.com/r2/platform/limits/).

**Rough engineering estimate (one engineer, existing core image format, one Bun NFS gateway, small volume, no public release claim):** 2–4 days for a working R2 adapter and local contract tests; 3–6 more days for remote integration, fault injection, restart recovery, and benchmark measurements; 1–3 additional weeks if concurrent write contention or multi-gateway ownership forces a DO coordinator or a redesigned image layout. These are planning estimates, not measured project velocity. Release qualification and operational setup are outside these ranges.

The basic adapter is small because the core supplies image serialization and staged mutation. The larger work is proving exclusive ownership, stale-writer fencing, recovery from ambiguous writes, size and throughput under whole-image replacement, and the stable-write guarantee through the NFS response path. A Durable Object can supply a serialized owner, but using it as the authoritative volume rather than a remote store changes the gateway design. [Existing Cloudflare feasibility note](cloudflare-durable-object-live-image.md "builds on").

A private local [writable NFS test app](../../apps/nfs-r2-writable-test/README.md) now composes the R2 provider with the staged internal NFS handler on loopback. It narrows `AUTH_SYS` claims to root or one configured local UID and a loopback peer. It requires an operator to run only one gateway for the image; this is not a distributed lease. On 2026-09-21 a native macOS NFSv4.1 mount passed write, `fsync`, rename, readback, and recovery after a clean unmount and fresh server process against a real R2 bucket. The first mount revealed that the internal NFS `ACCESS` reply omitted mapped-caller write grants; this was fixed and covered by a focused regression test. `ls -la` at the export root still reports a permission error for `..`, while a plain listing and the mutation test pass. These results do not qualify physical power-loss durability or unattended client recovery. The app does not change the public read-only NFS constructor or `Volume.durability`.
