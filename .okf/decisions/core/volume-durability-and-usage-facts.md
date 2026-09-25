---
type: Decision
title: Volume durability and usage facts
description: Gives a volume a static durability tier, a per-volume incarnation token, readable limits, and a live usage query, and keeps export policy, checkpoint scheduling, and identity mapping in application composition.
status: stable
tags: [durability, capacity, limits, nfs, adapters]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/46
    title: Writable adapter and VFS capability boundary design issue
  - id: implementation-issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/97
    title: Volume durability and identity implementation issue
  - id: write-issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/127
    title: NFS WRITE and COMMIT verifier issue
  - id: capacity-issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/98
    title: Volume limits and live usage implementation issue
  - id: core
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Volume interface and handle sync documentation
  - id: engine
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Volume options, usage counters, and revision counter
  - id: checkpoints
    resource: ../../../packages/persistence/src/CheckpointStore.ts
    title: Explicit checkpoint storage
  - id: dispatcher
    resource: ../../../packages/nfs/src/internal/nfs4.ts
    title: Separate server and storage generations
  - id: evidence
    resource: ../../../packages/core/test/VolumeFacts.test.ts
    title: Volume durability and identity behavior tests
  - id: rfc8881
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: RFC 8881 NFSv4.1
  - id: exports
    resource: https://man7.org/linux/man-pages/man5/exports.5.html
    title: exports(5) sync and async options
  - id: knfsd
    resource: https://github.com/torvalds/linux/blob/master/fs/nfsd/vfs.c
    title: Linux nfsd write verifier reset
  - id: buildbarn
    resource: https://github.com/buildbarn/bb-remote-execution/tree/master/pkg/filesystem/virtual/nfsv4
    title: Buildbarn NFSv4 stability and verifier handling
  - id: sqlite
    resource: https://www.sqlite.org/pragma.html#pragma_synchronous
    title: SQLite synchronous levels
  - id: postgres
    resource: https://www.postgresql.org/docs/current/runtime-config-wal.html
    title: PostgreSQL WAL settings and crash tiers
  - id: billy
    resource: https://github.com/go-git/go-billy
    title: go-billy filesystem capabilities
  - id: winfsp
    resource: https://github.com/winfsp/winfsp/blob/master/inc/winfsp/winfsp.h
    title: WinFsp volume parameters and volume info
generated: { by: claude/okf, at: "2026-09-25T22:30:00+02:00" }
---

# Volume durability and usage facts

Accepted by the user on 2026-09-17 while resolving the durability half of issue #46.[^issue] A writable network adapter must state how durable an acknowledged write is and how much space remains, and it may only say what the volume can back. `FileHandle.sync` remains a liveness check, while checkpoints are explicit snapshots the application saves. `Volume` now publishes durability, identity, effective limits, and live usage facts.[^core][^checkpoints] The mutation half of the issue is recorded in the reference-based mutations decision, which links here; how an NFS adapter turns these facts into `WRITE` and `COMMIT` answers is the separate stability decision (#49).

## Decisions

1. **A static durability tier.** `Volume` exposes a `durability` fact as an ordered enumeration whose weakest value, `memory-only`, is the default and the only value core implements: acknowledged writes are lost when the volume is dropped or the process ends. Further tiers are named by the boundary they survive, process crash, operating-system crash, and power loss, because those are the boundaries SQLite's `synchronous` levels and PostgreSQL's crash table distinguish.[^sqlite][^postgres] The fact is named fields, not a bitmask, and is never fabricated: honest libraries default to the weak answer, and the NFS ecosystem's own default moved from `async` to `sync` because `async` lets a server "violate the NFS protocol".[^billy][^exports]
2. **Stable identity and a volume incarnation.** `Volume` exposes separately branded 128-bit lowercase hexadecimal tokens. `identity` names the logical volume: construction mints one unless the caller supplies it, and restoring a snapshot continues the same logical volume only when the caller supplies that identity. `incarnation` is never caller supplied and is minted on every construction. It changes whenever the runtime storage instance is reconstructed, so clients can detect that acknowledged memory-only writes may have been lost.[^knfsd][^rfc8881] NFS derives `fsid` from identity, and filehandle generation and the `READDIR` cookie-verifier base from incarnation. The `WRITE` and `COMMIT` verifier must depend on both the volume incarnation and a fresh NFS server generation. This refines the earlier incarnation-only choice: RFC 8881 requires a different verifier for each NFS server instance, even when the same volume remains open.[^rfc8881][^dispatcher] The server generation also scopes sessions, state IDs, and server-owner identity.[^buildbarn][^dispatcher]
3. **Readable limits and a live usage query.** `Volume` exposes `limits` as a plain value carrying `maxBytes`, `maxFileBytes`, `maxEntries`, and `maxPathBytes`, where `undefined` means unlimited and zero is never used for unknown, and `usage` as an effect returning `usedBytes` and `entries` sampled under the coordination gate. The engine maintains both counters transactionally with every write.[^engine] Static facts and dynamic usage are separate, following WinFsp's volume parameters and volume-info split.[^winfsp] Adapters derive protocol shapes such as total, free, and available from these facts. NFS omits unsupported capacity attributes from `GETATTR` when a limit is undefined rather than inventing a total; `VERIFY` and `NVERIFY` answer `NFS4ERR_ATTRNOTSUPP`.[^rfc8881]
4. **Per-write achieved stability is deferred.** `FileHandle.write` keeps returning a byte count. A result carrying the achieved stability, as nfs4j returns, becomes worthwhile only with a backend that can report less than requested; ganesha collapses the three NFS levels to one boolean and never reports the middle level.
5. **Application composition.** Three concerns stay outside core and outside protocol rules: whether an export is writable is an `NfsServer` option enforced at dispatch, because NFSv4.1 has no export model and `NFS4ERR_ROFS` is a predicate; when to capture and save a checkpoint stays with the application composing `Volume.snapshot` and the checkpoint store, and any write-ahead or write-through backend that raises the durability tier is a provider decided under #49; identity and owner-string mapping reuse the [authentication and export policy](../nfs/nfs-authentication-and-export-policy.md "constrained by"). Arbitration between two adapters sharing one volume is deliberately left open for #47.

## Consequences

- Issue #97 implements the durability, identity, and incarnation portion of this decision. Volume constructors mint identity and incarnation from Effect's `Random`, or from a `Crypto.Crypto` service when one is in context, and fail with no `PlatformError`; the [public API decision](public-api-targets-services-and-errors.md "refined by") removed the earlier `Crypto` requirement. Ordinary built-in volumes report `memory-only`. A live image provider can explicitly supply a qualified tier; omission remains `memory-only`. The R2 test app asserts `survives-power-loss` only for a verified Cloudflare R2 endpoint and one gateway, based on Cloudflare's successful-write contract.[^implementation-issue][^evidence]
- Issue #98 implements the limits and live usage portion of this decision.[^capacity-issue]
- The facts extend the [capacity and limits contract](../../contracts/capacity-and-limits.md "extends") and [volume capacity accounting](volume-capacity-accounting.md "extends"). They preserve [snapshot-local file identity](snapshot-local-file-identity.md "constrained by"): identity and incarnation are runtime state excluded from snapshot bytes, and a restored volume always mints a new incarnation.
- NFS exposes `maxfilesize` on every export and the space and file-count attributes when the corresponding volume limit is bounded. The current read-only profile can report these facts. `GETATTR` omits unsupported requested attributes under RFC 8881 Section 18.7.3; `VERIFY` and `NVERIFY` answer `NFS4ERR_ATTRNOTSUPP` for them.
- This decision [refines deferred capabilities](../../profiles/deferred-capabilities.md "refines"), which still exclude automatic persistence and crash durability; this concept only makes the exclusion machine readable.

[^issue]: Issue #46 holds the original questions; the review session's decisions are recorded here.

[^core]: `Volume` exposes `durability`, `identity`, `incarnation`, `limits`, and `usage`; `FileHandle.sync` remains documented as a liveness check with no host or crash durability to flush.

[^engine]: `VolumeOptions` carries the four limits; `usedBytes` and the entry count are updated inside the coordination gate, and the revision counter restarts on restore.

[^checkpoints]: `CheckpointStore` saves snapshots the application captured; it is not a live commit barrier.

[^dispatcher]: The NFS handler hashes the fresh server generation and volume incarnation for the `COMMIT` verifier; internal writable `WRITE` uses the same value. The export derives filehandles from incarnation and `fsid` from stable identity.

[^rfc8881]: Sections 5.2 (attributes "whenever they don't have to tell lies"), 18.7.3 (unsupported GETATTR attributes), 18.32.3 and 18.3.3 (write verifier), and Table 20 (committed levels).

[^exports]: The `async` option "allows the NFS server to violate the NFS protocol and reply to requests before any changes made by that request have been committed to stable storage"; `sync` has been the default since nfs-utils 1.0.0.

[^knfsd]: `commit_reset_write_verifier` skips `-EAGAIN` and `-ESTALE` because "neither of these are the result of a problem with durable storage".

[^buildbarn]: The NFSv4 layer answers `FILE_SYNC4` unconditionally, treats `COMMIT` as a no-op, and mints eight random bytes per process as both write and cookie verifier.

[^sqlite]: `synchronous=OFF` keeps consistency after an application crash but may corrupt after an operating-system crash or power loss.

[^postgres]: The `synchronous_commit` table separates loss after a server crash from loss after an operating-system crash.

[^billy]: `SyncCapability` is excluded from `DefaultCapabilities`, so a filesystem unaware of the flag is assumed not to sync.

[^winfsp]: `FSP_FSCTL_VOLUME_PARAMS` holds capabilities and limits with no space fields; `GetVolumeInfo` reports free space separately.
