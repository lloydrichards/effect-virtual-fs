---
type: Contract
title: Capacity and limits
description: Defines logical entry and byte accounting together with file, path, and snapshot processing limits.
status: stable
tags: [capacity, limits, quotas]
sources:
  - resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Volume options and quota implementation
  - resource: ../../packages/core/src/Snapshot.ts
    title: Snapshot decode limits
  - resource: ../../packages/core/test/File.test.ts
    title: File quota behavior tests
generated: { by: codex/okf, at: 2026-09-10T00:00:00Z }
---

# Capacity and limits

Volumes may bound logical regular-file bytes, namespace entries, individual file size, and encoded path length. File contents and symlink targets are charged once per inode; directory names consume entries; root and implicit dot entries do not.

Unlinked open files remain charged. Dense regular files cannot exceed 4,294,967,295 bytes, and `maxFileBytes` may lower that ceiling. Snapshot decoding requires explicit encoded-byte, record, entry, and decoded-byte work limits; restore also enforces destination volume quotas.

See [volume capacity accounting](/decisions/volume-capacity-accounting.md "constrained by") and [optional total path limit](/decisions/optional-total-path-limit.md "constrained by").
