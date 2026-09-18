---
type: Decision
title: Remaining implementation profile
description: Records the implemented regular-file, link, metadata, snapshot, fixture, adapter, watch, and error policies.
status: deprecated
tags: [core, implementation, compatibility]
sources:
  - id: core
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Public core surface
  - id: adapter
    resource: ../../../packages/memory/src/internal/memoryFileSystem.ts
    title: Adapter compatibility behavior
generated: { by: claude/okf, at: 2026-09-16T23:00:00+02:00 }
---

# Remaining implementation profile

Retained as the record of the policies accepted when the first core slice was completed. Each is now owned by a focused contract: [regular-file I/O](../../contracts/regular-file-io.md "superseded by"), [paths and namespace](../../contracts/paths-and-namespace.md "superseded by"), [snapshots and fixtures](../../contracts/snapshots-and-fixtures.md "superseded by"), [mutation and observation](../../contracts/mutation-and-observation.md "superseded by"), and [memory adapter compatibility](../../contracts/memory-adapter-compatibility.md "superseded by").

Core implements bigint offsets, dense file storage, partial writes at capacity, coordinated mutation, hard links to files or symlinks, bounded symlink traversal, whole-list directory reads, explicit metadata authority, strict snapshot v1, validated final-state fixtures, and owned byte observations.

Memory adapts core while preserving its cursor, error, recursive-operation, and trailing-slash compatibility. Watches stream committed byte-path events without replay or silent drops; adapter filtering occurs before strict UTF-8 conversion. Whole-file transfers are atomic, while composed recursive operations are not transactions.

The profile concretizes [capacity accounting](volume-capacity-accounting.md "implements"), [first-core contracts](consolidated-first-core-contracts.md "implements"), and the snapshot decisions. `writeFile` controls allow final-symlink replacement and atomic final-mode application without temporary entries or duplicate watcher events.
