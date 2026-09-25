---
type: Decision
title: Overlay content sharing
description: Shares unchanged file contents across v1 workspaces and uses private whole-file contents on first content change.
status: stable
tags: [overlay, storage, isolation, copy-on-write]
sources:
  - id: core
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Current node identity, byte ownership and eager restoration
  - id: engine
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: The restored base value kept on the snapshot and shared by its workspaces
  - id: research
    resource: ../../research/overlay-filesystem.md
    title: Overlay storage alternatives
generated: { by: claude/okf, at: 2026-09-25T18:00:00Z }
---

# Overlay content sharing

Accepted by the user on 2026-09-10. Since the persistent tree rebuild, a base snapshot restores once into an immutable volume value kept on the snapshot handle, and every workspace starts from that value, so unchanged inodes and file contents are shared by structure rather than through a decoded-content cache. V1 workspaces created from the same immutable snapshot share unchanged file contents. First content change gives the workspace private whole-file contents. Copying only changed blocks or ranges is deferred.

Reads and metadata-only changes, including access times and permissions, retain shared contents. Metadata remains private. Public reads still return owned bytes under the [byte ownership contract](../../contracts/byte-ownership.md "preserves"); internal sharing must never expose mutable backing buffers.

Private contents belong to a logical object, not one path. Hard-link aliases and preexisting handles observe the same updated object within their workspace. The base and siblings remain unchanged under [base ownership](overlay-base-ownership.md "constrained by").

Whole-file granularity need not copy discarded bytes: complete overwrite or truncate-to-zero may build the result directly. Cache lifetime, decoded base storage and directory sharing remain implementation choices. Ordinary eager `fromSnapshot` is a behavior reference, not sufficient evidence of shared storage.

Live sharing changes neither complete snapshot encoding nor logical quotas. No quantified memory reduction or startup time is promised.

Prove sharing as well as behavior: unchanged contents are shared, reads and metadata updates retain sharing, and content changes isolate the edited workspace while preserving aliases and handles. Select focused internal evidence during implementation; ordinary filesystem tests alone cannot establish sharing.
