---
type: Decision
title: Writable NFS export scope
description: Fixes the local writable export's authority, operation, locking, durability, and restart milestones without claiming implementation.
status: stable
tags: [nfs, writable, durability, locks]
sources:
  - id: issue-47
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/47
    title: NFS open and lock state issue
  - id: issue-48
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/48
    title: Bounded writable exports issue
  - id: issue-49
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/49
    title: WRITE stability and COMMIT issue
  - id: core
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Live volume coordination and mutation engine
  - id: checkpoint
    resource: ../../../packages/persistence/src/CheckpointStore.ts
    title: Explicit SQLite checkpoint store
  - id: rfc8881
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: NFSv4.1 specification
generated: { by: codex/okf, at: 2026-09-19T11:27:24Z }
---

# Writable NFS export scope

The user accepted this scope on 2026-09-19 for issues #47, #48, and #49. The public API now exposes an experimental guarded writable option for a qualified live volume; this scope still defines its requirements. The [profile ladder](nfs-profile-ladder.md "refined by") separates capability from maturity.

- A writable export is explicit, local, and restricted to one authorized user. It reuses the application-supplied peer and credential policy and its mapped VFS caller. The read-only local caller shortcut does not authorize writes. This narrows the [authentication and export policy](nfs-authentication-and-export-policy.md "constrained by").
- NFS share reservations are mandatory for NFS reads and writes. Byte-range locks are advisory between NFS clients. Full relevant open, share, lock, stateid, lease, limit, and cleanup behavior from #47 precedes the trustworthy writable milestone. Direct VFS callers remain outside NFS locks, as fixed by [reference-based mutations](../core/reference-mutations.md "constrained by").
- `CREATE` supports directories and symbolic links; `LINK` supports hard links. Regular files are created through `OPEN`, including ordinary, guarded, and both exclusive modes. `SETATTR` supports core-backed size, mode, owner, group, and timestamp fields through one core `setattr`, so it applies all of them or none and reports them all or none, and rejects unsupported fields. Each namespace mutation reports its own coherent change information. A compound is not a filesystem transaction.
- The trustworthy writable milestone requires a live durable volume provider. Successful file, namespace, and metadata mutations through either NFS or direct VFS callers have the same storage guarantee. Every successful `WRITE` is stored at `FILE_SYNC4` strength before its reply; `COMMIT` handles already durable data. The existing [volume durability facts](../core/volume-durability-and-usage-facts.md "depends on") distinguish what a provider can promise.
- The first durable writable milestone may require remounting after a server restart. Filehandles already survive a restart through core's [reference key](../core/reference-keys.md "extended by"); session, open, and lock recovery is a later #50 milestone before ordinary unattended use. Durable file contents alone do not imply recoverable NFS state.

## Storage design constraint

Ordinary core volumes mutate in-memory state inside a coordination gate and advertise `memory-only`. `LiveVolume` stages each candidate image and publishes it only after its provider confirms the commit. A live provider can report a stronger qualified tier; the R2 test app uses Cloudflare's synchronous successful-write contract. `CheckpointStore` saves application-supplied snapshots separately and is not a commit barrier.[^core][^checkpoint]

The R2 provider uses conditional whole-image replacement for the first experimental writable configuration. It requires one externally controlled gateway; it does not implement a distributed ownership lease or unattended NFS state recovery. Other providers still require their own qualification. RFC 8881 requires `FILE_SYNC4` replies to follow stable storage of data and metadata and permits advisory byte-range locks.[^rfc8881]

[^core]: `coordinated` guards in-memory mutations; built-in volumes report `memory-only`.

[^checkpoint]: The store saves a supplied snapshot and does not intercept live mutations.

[^rfc8881]: Sections 9.1, 18.3, 18.4, 18.16, 18.30, and 18.32.
