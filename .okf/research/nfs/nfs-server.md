---
type: Research Report
title: NFSv4.1 server direction
description: Evaluates a separate, bounded NFSv4.1 server for exposing a live core volume, beginning with a read-only mount experiment.
status: draft
tags: [nfs, interoperability, roadmap]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/11
    title: NFS research scope and discussion
  - id: core
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Current core interfaces and implementation
  - id: nfs-preview
    resource: ../../../apps/nfs-preview/README.md
    title: Experimental NFS preview profile and mount example
  - id: linux-gate
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/39
    title: Privileged Linux mount gate and retained macOS result
  - id: nfs-tests
    resource: ../../../packages/nfs/test/Nfs4.test.ts
    title: NFSv4.1 protocol behavior tests
  - id: checkpoints
    resource: ../../../packages/persistence/src/CheckpointStore.ts
    title: Explicit checkpoint storage
  - id: nfs41
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: RFC 8881 NFSv4.1
  - id: nfs41-xdr
    resource: https://www.rfc-editor.org/rfc/rfc5662.html
    title: RFC 5662 NFSv4.1 XDR
  - id: rpc
    resource: https://www.rfc-editor.org/rfc/rfc5531.html
    title: RFC 5531 RPC
  - id: xdr
    resource: https://www.rfc-editor.org/rfc/rfc4506.html
    title: RFC 4506 XDR
generated: { by: claude/okf, at: 2026-09-18T11:00:00+02:00 }
---

# NFSv4.1 server direction

The accepted first implementation is a private, experimental `@effect-vfs/nfs` package that exposes one live volume read-only to a trusted local user. The application supplies the volume, privileged virtual caller, and a platform implementation of Effect's `SocketServer`; the package accepts only a loopback TCP binding, while the user or operating system owns mounting. Server restarts require a remount. Windows, writable NFS, delegations, locking, multi-user deployment, and full RFC conformance remain outside this preview. Backchannels are supported as of #44, but only to probe the callback path; nothing is ever recalled.

Core supplies runtime file identity, byte-preserving paths, scoped open handles, positional I/O, permissions, coordinated mutation, stable [object references](../../contracts/object-references.md "refined by"), and live [mutation revisions](../../contracts/mutation-revisions.md "refined by"). Protocol-specific filehandles, RPC, sessions, authentication, leases, replay, resource limits, and recovery belong in the NFS package.

Writable NFS is a separate decision. Volatile `sync` and explicit SQLite checkpoints do not justify durable NFS write acknowledgements.[^core][^checkpoints] Sharing rules must also account for direct core writers; server-only bookkeeping cannot enforce mandatory restrictions across all consumers. The core boundary for both is now fixed by [reference-based mutations](../../decisions/core/reference-mutations.md "superseded by") and [volume durability and usage facts](../../decisions/core/volume-durability-and-usage-facts.md "superseded by"): mutations move to reference operations, share state stays adapter-only with a documented boundary, and durability becomes a readable `memory-only` fact plus an incarnation token.

On 2026-09-13 a macOS client completed AUTH_SYS NFSv4.1 `EXCHANGE_ID`, `CREATE_SESSION`, `SEQUENCE`, `RECLAIM_COMPLETE`, root filehandle discovery, metadata and access probes, `DESTROY_SESSION`, and `DESTROY_CLIENTID` against Linux nfsd. Every ordinary post-creation compound began with `SEQUENCE`; absent Finder probe names returned `NFS4ERR_NOENT`. Docker Desktop's export harness then blocked the directory workload before `READDIR`.[^issue]

The retained macOS result records a successful mount of this implementation, including directory listing, regular-file reads, symlink traversal, equal inode identity for two hard-link names, VFS-side file replacement after the configured one-second attribute-cache window, protocol-level write rejection, restart-required remount behavior, and clean unmount.[^linux-gate] Protocol tests cover the required non-pNFS `EXCHANGE_ID` role, structured `AUTH_SYS` callback credentials, downward `CREATE_SESSION` limit negotiation, compound-local `SAVEFH` and `RESTOREFH`, and read-only `OPEN` with `CLAIM_FH`.[^nfs-tests] The repeatable privileged Linux-client mount remains an implementation gate.[^linux-gate][^nfs-preview]

The package's public configuration, resource limits, limit overrides, and bound address are Effect schemas. The constructor supplies lease and finite resource defaults while accepting selective overrides. The application owns socket binding and selects a platform adapter, while NFS validates the resulting address. Byte budgets use `Schema.ByteSize`, count and protocol fields carry explicit numeric bounds, and startup validates the complete resolved policy before the only conversion into the private number-based XDR limits. Live `Volume`, `Caller`, and `SocketServer` values remain capability contracts and are checked effectfully. Public declarations do not depend on the package-blocked protocol modules under `internal`. A separate workspace app owns the Bun binding, runnable fixture, and native mount instructions.[^nfs-preview]

The bounded preview also models confirmed and pending client incarnations separately, limits pending restart replacements explicitly, enforces negotiated session channels against actual encoded replies, preserves slot replay identity across retries and teardown, and uses RFC stateid and directory-cookie forms for read interoperability. Minimum preflight bounds allow small `SEQUENCE` and `READDIR` results when a request's maximum possible reply exceeds the channel; the server rolls the slot back if the encoded result is actually too large. Compounds hold the server state gate for their whole run, but the interrupt boundary sits between operations: the lease sweep, the compound parse, the replay-cache hit path, and the replay-slot commit are uninterruptible, so a compound is abandonable between operations and never torn in half. An abandoned compound restores its slot's sequence ID, cached reply, and retained bytes, so the client's retry is accepted as a first attempt. Each operation that mutates server state guards itself within its own operation; `CLOSE` closes the handle and drops it from the open map in one region. This bounds shutdown against a stalled backing store, except within a single operation's own uninterruptible region.

The bounded profile this research asked for is now defined. The [NFS profile ladder](../../decisions/nfs/nfs-profile-ladder.md "superseded by") names the capability profiles and maturity evidence, the [read-only-local profile](../../profiles/nfs/nfs-read-only-local.md "refined by") states the first supported boundary, and the coverage ledgers account for every mandatory operation, attribute, and cross-cutting obligation. This concept retains the accepted direction, the design constraints above, and the macOS interoperability result. NFS object references must not weaken [explicit caller privilege](../../decisions/core/explicit-caller-privilege.md "constrained by") or change [snapshot local identity](../../decisions/core/snapshot-local-file-identity.md "constrained by").

[^core]: Current public capabilities, mutation coordination and memory-only `FileHandle.sync` are defined in the core implementation.

[^checkpoints]: `CheckpointStore` saves explicitly supplied snapshots; it is not a live-write commit barrier.

[^issue]: Issue #11 owns the research milestone and discussion.

[^nfs-preview]: The package README defines the experimental scope, manual mount command, and remaining privileged Linux gate.

[^linux-gate]: Issue #39 retains the completed macOS gate summary and owns the missing repeatable Linux-client evidence.

[^nfs-tests]: The NFS protocol suite checks negotiation, callback credentials, filehandle operations, directory behavior, replay, and read-only opens.
