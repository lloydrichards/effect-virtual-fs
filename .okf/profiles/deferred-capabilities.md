---
type: Project Profile
title: Deferred capabilities
description: Lists capabilities intentionally outside the current filesystem contract so future exploration is not mistaken for implemented support.
status: draft
tags: [profile, roadmap, deferred]
generated: { by: claude/okf, at: 2026-09-15T17:30:00+02:00 }
---

# Deferred capabilities

The current profile does not include:

- FUSE or other host mounts, Vim integration, or access by arbitrary native tools other than the read-only NFS export;
- writable, networked, authenticated, or locking NFS exports, and WebDAV or other network filesystem protocols;
- live backing volumes, snapshot-delta merge or rebase, block-level copying, or changed-data budgets;
- host-directory import or export;
- FIFOs, device files, filesystem sockets, or other special files;
- advisory locks or descriptor duplication;
- caller-specific restricted roots or subtree confinement;
- sparse allocation or copy-on-write storage optimization;
- automatic persistence of live writes, host `fsync`, or crash/power-loss durability;
- complete Node package resolution, dependency installation, or HMR inside the virtual build integration.

These are exclusions, not rejected designs. Active investigation may be represented separately as draft research, but it must not imply implementation or acceptance. Snapshot checkpoints provide explicit reconstruction, not live-write durability; dense zero-filled gaps provide filesystem behavior without sparse allocation.

See [system boundaries](/architecture/system-boundaries.md "constrained by") and the [bounded POSIX profile](bounded-posix.md "contrasts with") for the current supported boundary. The read-only loopback NFS export is the first step of the [NFS profile ladder](/decisions/nfs-profile-ladder.md "refined by"); its later profiles remain deferred until their owning issues land.

Overlay [v1 scope is implemented](/contracts/overlay-workspaces.md "contrasts with"). [Overlay research](/research/overlay-filesystem.md "explored by") retains alternatives and deferred delta questions.

The [portable snapshot delta interface](/decisions/portable-snapshot-deltas.md "implemented by") is implemented by the [snapshot delta contract](/contracts/snapshot-deltas.md "refined by"). Its draft [representation research](/research/overlay-changes.md "explored by") now retains only future persistence, alternative encoding, merge and profiling questions.
