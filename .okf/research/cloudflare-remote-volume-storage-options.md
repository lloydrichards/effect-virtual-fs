---
type: Research
title: Cloudflare remote volume storage options
description: Compares Durable Objects, D1, and R2 against the current live volume contract and a remotely accessible filesystem.
status: draft
tags: [cloudflare, persistence, nfs]
sources:
  - id: live-contract
    resource: ../../packages/core/src/LiveVolume.ts
    title: Live volume contract
  - id: do-storage
    resource: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
    title: Durable Object SQLite storage
  - id: do-rules
    resource: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
    title: Durable Object rules
  - id: do-limits
    resource: https://developers.cloudflare.com/durable-objects/platform/limits/
    title: Durable Object limits
  - id: d1-api
    resource: https://developers.cloudflare.com/d1/worker-api/d1-database/
    title: D1 database binding API
  - id: d1-limits
    resource: https://developers.cloudflare.com/d1/platform/limits/
    title: D1 limits
  - id: d1-replicas
    resource: https://developers.cloudflare.com/d1/best-practices/read-replication/
    title: D1 read replication
  - id: r2-api
    resource: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
    title: R2 Workers binding API
  - id: r2-consistency
    resource: https://developers.cloudflare.com/r2/reference/consistency/
    title: R2 consistency model
  - id: r2-limits
    resource: https://developers.cloudflare.com/r2/platform/limits/
    title: R2 limits
  - id: r2-durability
    resource: https://developers.cloudflare.com/r2/reference/durability/
    title: R2 durability
  - id: worker-protocols
    resource: https://developers.cloudflare.com/workers/reference/protocols/
    title: Workers supported protocols
generated: { by: codex/okf, at: 2026-09-21T08:57:26Z }
---

# Cloudflare remote volume storage options

## User goal and current boundary

The larger goal is a remote virtual filesystem deployable on Cloudflare, with storage chosen independently from how clients reach it. Today `LiveVolume.LiveImageStore` has `loadOrCreate` and whole-image `commit` methods; its documented contract assumes one exclusive owner, atomic image replacement, and explicit classification of uncertain commits. A storage adapter alone does not give multiple Workers a coherent writable `Volume`. See [the earlier Durable Object investigation](cloudflare-durable-object-live-image.md "refines").[^live-contract]

The client access route is separate. Cloudflare Workers accept HTTP and WebSocket traffic, but currently cannot accept inbound TCP sockets. A browser or TypeScript client can call a Worker or Durable Object remotely; an ordinary NFS mount still needs a TCP-speaking gateway outside the Worker runtime.[^worker-protocols]

## What each platform gives us

| Backing service              | Useful property                                                                                                                                                                            | Constraint for a live filesystem                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite-backed Durable Object | One named actor can keep a live volume in memory and use private, transactional, strongly consistent SQLite storage. Output gates hold responses until preceding writes are persisted.     | One object has a compute and storage ceiling; SQL BLOB/row and KV value limits are 2 MB. The in-memory volume must reopen after eviction. Request handlers can interleave across awaits, so the application must coordinate mutations. A DO can also use R2 or D1 for storage, but external I/O must be accounted for in commit and recovery semantics.[^do-storage][^do-rules][^do-limits] |
| D1 binding from a Worker     | SQL database with transactional `batch()` and multiple Workers able to reach it. A database processes queries one at a time.                                                               | The binding is a database interface, not a persistent in-memory volume owner. The current full image must fit the 2 MB BLOB/row limit. If read replicas are enabled, callers need Sessions/bookmarks for sequential reads; replicas may lag.[^d1-api][^d1-limits][^d1-replicas]                                                                                                             |
| R2 binding from a Worker     | Globally strong read-after-write consistency, objects much larger than a DO or D1 row, and conditional `put()` using an ETag. Cloudflare reports success after the write persists to disk. | R2 offers atomic operations on individual objects, not a multi-object filesystem transaction. Unconditional concurrent writes to one key are last-writer-wins; writes to the same key above one per second are rate limited. A Worker still needs a concurrency protocol and a way to keep its live cache fresh.[^r2-api][^r2-consistency][^r2-limits][^r2-durability]                      |

The 2 MB row limit makes a direct full-image port bounded for DO SQLite and D1. R2 can hold a much larger image, but writing that whole image on every file mutation would magnify latency, transfer, and same-key write pressure. Those are inferences from the present `commit(image)` contract and documented limits, not measured results.[^live-contract][^r2-limits]

## Architectural choices to test

1. **DO owns the volume; storage stays replaceable behind it.** Route all operations for one volume ID to one DO. Its first storage provider can be SQLite-backed DO storage; later options might include R2 for larger data or D1 for records. This preserves one live owner while making storage interchangeable, though each provider still needs an explicit atomicity and recovery contract. Cloudflare advises against holding `blockConcurrencyWhile()` across external R2 or D1 I/O; a prototype must instead prove mutation ordering and response timing.[^do-rules]
2. **Stateless Worker plus D1 or R2.** Each request reconstructs or operates on persisted state. This could work for a small prototype, but it needs a shared concurrency mechanism, stale-read policy, and ownership of any NFS session/open/lock state. R2 ETag conditions can protect one image object's generation; D1 transactional SQL can protect database records. Neither automatically supplies the current exclusive live-volume owner.[^live-contract][^r2-api][^d1-api]
3. **A gateway for native NFS.** After the Worker/DO filesystem API is clear, a separate TCP process can translate NFS requests to it. The gateway's persistent NFS state, response guarantees, and reconnect behavior need their own design. Storage provider choice does not remove this gateway requirement.[^worker-protocols]

The narrow first demonstration is two TypeScript clients calling one named remote workspace to create, read, and update files, then observing those files after the serving instance restarts. It should use a useful image-size and mutation rate, test competing writes and failure outcomes, and report the provider-specific durability evidence. This demonstrates the remote filesystem without requiring native NFS or assuming any one storage product is the final choice.

## Open questions

- Is the user-facing API a remote `Volume` or filesystem client, a transport-neutral operation service, or a simple application RPC? How are volume identity and authorization expressed?
- Does interchangeability mean swapping whole-image persistence providers under one DO owner, or should the public API accommodate record/page storage that avoids full-image commits?
- Which operations require one atomic commit, and which may be eventually observed? What guarantee can an acknowledged response honestly claim for each provider?
- What are measured image sizes, write rates, and reopen times for the proposed agent demo? These should decide whether DO SQLite, D1, or R2 is the best initial backend.
- If native NFS follows, what owns NFS sessions and how does the gateway avoid stale reads after restart or failover?

[^live-contract]: `LiveVolume.ts` defines the provider-neutral `LiveImageStore` service and `LiveVolume.open`.

[^do-storage]: [Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

[^do-rules]: [Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).

[^do-limits]: [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

[^d1-api]: [D1 database binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/).

[^d1-limits]: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

[^d1-replicas]: [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/).

[^r2-api]: [R2 Workers binding API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

[^r2-consistency]: [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/).

[^r2-limits]: [R2 limits](https://developers.cloudflare.com/r2/platform/limits/).

[^r2-durability]: [R2 durability](https://developers.cloudflare.com/r2/reference/durability/).

[^worker-protocols]: [Workers supported protocols](https://developers.cloudflare.com/workers/reference/protocols/).
