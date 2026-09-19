---
type: Decision
title: NFS filesystem error mapping
description: Defines the generic core-error translation and operation-specific writable error rules for NFSv4.1.
status: stable
tags: [nfs, errors, writable]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/99
    title: Writable profile error map issue
  - id: rfc8881
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: RFC 8881 NFSv4.1
  - id: core-errors
    resource: ../../../packages/core/src/internal/virtualFileSystem/errors.ts
    title: Core filesystem error codes
  - id: nfs-map
    resource: ../../../packages/nfs/src/internal/nfs4.ts
    title: NFS error map and dispatcher
  - id: tests
    resource: ../../../packages/nfs/test/ErrorMapping.test.ts
    title: Exhaustive error mapping test
generated: { by: codex/okf, at: 2026-09-19T11:48:19Z }
---

# NFS filesystem error mapping

Accepted for issue #99 on 2026-09-19. Core reports `FsError` values; the NFS adapter converts them to NFSv4.1 statuses. The generic mapping covers every current `FsCode` value and has a compile-time exhaustive table test. An unknown runtime code returns `SERVERFAULT` so reply encoding remains valid. An NFS operation can override the generic result when RFC 8881 requires a different status.[^nfs-map][^tests]

`AlreadyExists` maps to `EXIST`, `NotEmpty` to `NOTEMPTY`, and `StaleReference` to `STALE`. NFSv4.1 has no `LOOP` status, so `SymlinkLoop` maps to `INVAL`; the current NFS read path never follows symbolic links. `InvalidHandle`, `ForeignHandle`, `InvalidReference`, `ForeignReference`, and `ClosedCaller` are internal adapter failures and map to `SERVERFAULT`. Client-supplied filehandles retain their separate `PUTFH` classification: `BADHANDLE` for malformed or unknown handles, `FHEXPIRED` for a different export generation, and `STALE` for a formerly valid deleted object.[^rfc8881][^nfs-map]

The durable-provider error vocabulary now includes `StorageRejected`, `OutcomeUnknown`, and `VolumeUnavailable`; all map to `IO`. The current memory volume emits none of them. The [live durable volume proposal](../../research/live-durable-volume.md "proposed by") owns their future runtime behavior and fail-closed rules, which remain a draft.[^nfs-map]

Core's existing `FsError` shape stays unchanged. Its `AccessDenied` maps to `ACCESS` by default because core also uses that code for ownership restrictions. Writable `SETATTR` must identify ownership failures in its operation context and return `PERM` where RFC 8881 permits it. [The operations ledger](../../research/nfs/nfs-operations-ledger.md "refined by") records the rules for CREATE, LINK, OPEN, REMOVE, RENAME, SETATTR, and WRITE. In particular, RENAME returns `EXIST` for an incompatible or nonempty target, even when core reports `IsDirectory`, `NotDirectory`, or `NotEmpty`; a non-directory source or target directory handle still returns `NOTDIR`.[^rfc8881]

Issue #99 does not add writable NFS dispatch or a core hard-link limit. `MLINK` becomes relevant when core can report a link-count failure. Each writable operation must check its emitted statuses against RFC 8881 Section 15.2. That section lists valid statuses but gives no general precedence order when several failures coexist, so validation order is an adapter decision.[^rfc8881]

[^rfc8881]: RFC 8881 Sections 15.1, 15.2, 15.4, and 18.26.3 define the statuses, valid errors per operation, and RENAME's `EXIST` rule.

[^nfs-map]: The dispatcher and its `failureForFs` map implement the generic translation and separate filehandle validation.

[^tests]: The table test covers every current `FsCode`; its `Record<FsCode, number>` type makes a new code a compile-time error until a test row is added.
