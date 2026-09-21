---
type: Research
title: Cloudflare Durable Object live image store
description: Feasibility and boundaries for backing a virtual volume with Durable Object SQLite storage.
status: draft
tags: [cloudflare, durable-objects, persistence, nfs]
sources:
  - id: cf-storage
    resource: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
    title: SQLite-backed Durable Object Storage
  - id: cf-limits
    resource: https://developers.cloudflare.com/durable-objects/platform/limits/
    title: Durable Objects limits
  - id: cf-lifecycle
    resource: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
    title: Lifecycle of a Durable Object
  - id: cf-tcp
    resource: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
    title: Workers TCP sockets
  - id: cf-spectrum
    resource: https://developers.cloudflare.com/spectrum/reference/configuration-options/
    title: Spectrum configuration options
  - id: cf-rules
    resource: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
    title: Durable Object rules
  - id: cf-overview
    resource: https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
    title: Durable Object overview
  - id: cf-alarms
    resource: https://developers.cloudflare.com/durable-objects/api/alarms/
    title: Durable Object alarms
  - id: workers-limits
    resource: https://developers.cloudflare.com/workers/platform/limits/
    title: Workers limits
  - id: alchemy-do
    resource: https://alchemy.run/cloudflare/compute/durable-objects/
    title: Alchemy Durable Objects
  - id: local-store
    resource: ../../packages/persistence/src/SqliteLiveImageStore.ts
    title: Existing SQLite live image store
  - id: live-contract
    resource: ../../packages/core/src/LiveVolume.ts
    title: Live image store contract
  - id: nfs-server
    resource: ../../packages/nfs/src/NfsServer.ts
    title: Public NFS server constructor
generated: { by: codex/okf, at: 2026-09-21T08:35:49Z }
---

# Cloudflare Durable Object live image store

## Finding

A SQLite-backed Durable Object (DO) can plausibly implement `LiveVolume.LiveImageStore` and give one named volume a persistent, serialized owner. It cannot, by itself, be mounted as a native NFS server. The Workers TCP socket API creates **outbound** connections; Worker and DO entry points are HTTP, RPC, and WebSocket. Cloudflare Spectrum passes TCP to an origin, while its Workers integration requires HTTP/HTTPS. Thus a standard NFS mount needs a separate TCP server or bridge that forwards operations to the DO. An HTTP or WebSocket client could skip that bridge, but would no longer be a native NFS mount. [Cloudflare TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), [Spectrum configuration](https://developers.cloudflare.com/spectrum/reference/configuration-options/), [DO overview](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/).

## Storage seam and shape

The repository's `SqliteLiveImageStore` implements `LiveVolume.LiveImageStore`, whose `loadOrCreate(initial)` returns an image and `commit(image)` reports `committed`, `rejected`, or `unknown`. It stores one complete serialized image BLOB plus generation and SHA-256 digest, replacing the BLOB at every commit. A DO adapter should implement the same contract inside the DO, with one DO ID per volume and a Worker or DO RPC method for authorized callers. It should not depend on Alchemy in the storage package: pass a narrow storage capability or build a Cloudflare-specific adapter; use Alchemy to define/deploy the DO and its binding. This extends the [live durable volume proposal](live-durable-volume.md "builds on"). [Cloudflare storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Alchemy DO integration](https://alchemy.run/cloudflare/compute/durable-objects/).

Cloudflare recommends SQLite-backed DOs for new classes. Their SQL API supports synchronous queries and `transactionSync`; `sql.exec()` does not accept `BEGIN` or `SAVEPOINT`. The DO's storage is private, transactional, and strongly consistent. Cloudflare documents input gates for read/write ordering and output gates that hold outgoing responses until writes are persisted. An adapter should use an explicit transaction for image/generation/digest replacement, await `storage.sync()` if it needs to settle pending writes before classifying an outcome, and test failure and retry behavior. A returned success may rely on Cloudflare's documented output-gate guarantee, but that is provider durability evidence, not proof of local `fsync` or an NFS `FILE_SYNC4` promise. [Cloudflare storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [DO rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).

The current whole-image BLOB cannot exceed **2 MB per SQL BLOB or row**. The DO itself can hold up to **10 GB paid / 1 GB free**, but this does not lift the row limit. Key/value values also have a combined key/value limit of 2 MB. Consequently, directly porting the SQLite store only supports images below that ceiling; the existing example `maxImageBytes: 4 MB` already exceeds it. Larger volumes need chunked image storage or, preferably, a DO-native page/record store with an atomic root/generation commit, plus bounded memory use. The current image API may make whole-image serialization and transfer costly even after chunking. [Cloudflare limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

SQLite-backed DO writes fail with `SQLITE_FULL` at the per-object storage cap; reads and deletes continue. Map a confirmed pre-commit capacity failure to `rejected`, and an ambiguous failure after attempting the commit to `unknown`, matching the contract's uncertainty model. SQL integer values exposed to JavaScript have 52-bit precision concerns, so generation bounds need care. [Cloudflare limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [Cloudflare storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Runtime and NFS implications

DO instances may hibernate or restart; in-memory volume state and NFS session/open/lock state must be rebuilt or persisted before serving requests. A DO can initialize persistent schema before events using `blockConcurrencyWhile()`. Alarms can wake it and execute at least once, but are not a substitute for request-driven NFS state. HTTP/RPC invocations have no fixed wall-time limit while the caller remains connected, subject to CPU and memory limits; an always-on TCP listener is still unavailable inside a DO. [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [DO rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).

The repository's `NfsServer` currently needs a local `Volume` and `SocketServer`. Two native-mount designs are possible, and each needs work beyond `CfLiveImageStore`:

- Run `NfsServer` in one TCP gateway and use the DO as its remote image commit store. This reuses the current NFS and core code, but the gateway must be the sole active volume owner. Generation checks can reject a competing write; they do not prevent a stale gateway from serving stale reads. Gateway restart loses volatile NFS state and requires remounting under the current profile.
- Run the authoritative volume inside the DO and make the TCP gateway forward NFS operations to it. This suits multiple gateways but requires a new remote volume/handle protocol or a split NFS dispatcher, plus explicit ownership of sessions, replay, opens, and locks across gateway and DO restarts. It is not a thin socket proxy.

A simpler demo is `agents -> typed Worker/DO RPC -> shared volume`, using the TypeScript VFS directly. It demonstrates coordinated durable filesystem state without claiming a mount. Alchemy's DO class and binding support could deploy either design; it is an integration option, not a required persistence dependency. [Alchemy DO integration](https://alchemy.run/cloudflare/compute/durable-objects/), [Cloudflare TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).

## Suggested investigation order

1. Prototype a `CfLiveImageStore` inside one DO with a deliberately small image cap below 2 MB. Verify create, restart/eviction reload, concurrent writes, capacity failure, and ambiguous commit classification against the `LiveImageStore` contract.
2. Measure serialized image size and commit cost under realistic agent workloads. Decide whether chunked images suffice or a page/record-oriented persistence interface is needed.
3. Build a Worker/DO RPC demo of two agents editing the same volume and resolving conflicts through the existing VFS semantics. Use Alchemy for deployment only after the runtime adapter works.
4. If native mounting remains the goal, prototype a separate NFS TCP gateway and test reconnection, state recovery, and write/commit response semantics end to end.
5. Treat Cloudflare's storage guarantee as evidence for the DO backend only. Public writable NFS durability still requires an explicit mapping from every NFS stable-write promise to a confirmed DO commit, plus failure-injection and recovery evidence for that deployed configuration.
