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
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Current core interfaces and implementation
  - id: checkpoints
    resource: ../../packages/persistence/src/CheckpointStore.ts
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
generated: { by: codex/okf, at: 2026-09-10T08:47:21Z }
---

# NFSv4.1 server direction

No NFS design or implementation is accepted. The recommended experiment is a separate `@effect-vfs/nfs` package that depends on core and exposes a live volume read-only. Prove a real NFSv4.1 mount and read workload before committing to the protocol surface or writable access.

Core already supplies runtime file identity, byte-preserving paths, scoped open handles, positional I/O, permissions, and coordinated mutation.[^core] The proposed reusable core additions are developed in [object references](object-references.md "refined by") and [mutation revisions](mutation-revisions.md "refined by"). Selected atomic metadata or creation results may also be needed after the client experiment. Protocol-specific filehandles, RPC, sessions, authentication, leases, replay, resource limits, and recovery belong in the NFS package.

Writable NFS is a separate decision. Volatile `sync` and explicit SQLite checkpoints do not justify durable NFS write acknowledgements.[^core][^checkpoints] Sharing rules must also account for direct core writers; server-only bookkeeping cannot enforce mandatory restrictions across all consumers.

Successful mount evidence remains open. The next gate is a reference-server mount with retained operation traces for listing, reading, reopen-after-change, and unmount on a pinned Linux client and the target Mac. Record experiment results and planning estimates in the issue discussion; keep this concept focused on the direction, constraints, and acceptance gate.[^issue]

If the experiment proceeds, define an explicitly bounded preview profile. A successful `ls` is insufficient, and the preview must not be called a conformant NFSv4.1 server without accounting for every applicable mandatory operation, attribute, security, and recovery obligation. NFS object references must not weaken [explicit caller privilege](/decisions/explicit-caller-privilege.md "constrained by") or change [snapshot local identity](/decisions/snapshot-local-file-identity.md "constrained by").

[^core]: Current public capabilities, mutation coordination and memory-only `FileHandle.sync` are defined in the core implementation.

[^checkpoints]: `CheckpointStore` saves explicitly supplied snapshots; it is not a live-write commit barrier.

[^issue]: Issue #11 owns the research milestone and discussion; no successful mount is claimed here.
