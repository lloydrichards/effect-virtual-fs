---
type: Project Profile
title: Deferred capabilities
description: Lists capabilities intentionally outside the current filesystem contract so future exploration is not mistaken for implemented support.
status: draft
tags: [profile, roadmap, deferred]
generated: { by: codex/okf, at: 2026-09-10T00:00:00+00:00 }
---

# Deferred capabilities

The current profile does not include:

- FUSE or other host mounts, Vim integration, or access by arbitrary native tools;
- NFS, WebDAV, or other network filesystem protocols;
- overlay filesystems, copy-up rules, or cheap copy-on-write branches;
- host-directory import or export;
- FIFOs, device files, filesystem sockets, or other special files;
- advisory locks or descriptor duplication;
- caller-specific restricted roots or subtree confinement;
- sparse allocation or copy-on-write storage optimization;
- automatic persistence of live writes, host `fsync`, or crash/power-loss durability;
- complete Node package resolution, dependency installation, or HMR inside the virtual build integration.

These are exclusions, not rejected designs. Active investigation may be represented separately as draft research, but it must not imply implementation or acceptance. Snapshot checkpoints provide explicit reconstruction, not live-write durability; dense zero-filled gaps provide filesystem behavior without sparse allocation.

See [system boundaries](/architecture/system-boundaries.md "constrained by") and the [bounded POSIX profile](bounded-posix.md "contrasts with") for the current supported boundary. Network filesystem work is currently only [draft NFS research](/research/nfs-server.md "explored by").
