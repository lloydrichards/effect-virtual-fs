---
type: Decision
title: Remaining implementation profile
description: Records the implemented regular-file, link, metadata, snapshot, fixture, adapter, watch, and error policies.
status: stable
tags: [core, implementation, compatibility]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Remaining implementation profile

Core implements bigint offsets, dense file storage, partial writes at capacity, coordinated mutation, hard links to files or symlinks, bounded symlink traversal, whole-list directory reads, explicit metadata authority, strict snapshot v1, validated final-state fixtures, and owned byte observations.

Memory adapts core while preserving its cursor, error, recursive-operation, and trailing-slash compatibility. Watches stream committed byte-path events without replay or silent drops; adapter filtering occurs before strict UTF-8 conversion. Whole-file transfers are atomic, while composed recursive operations are not transactions.

The profile concretizes [capacity accounting](./volume-capacity-accounting.md "implements"), [first-core contracts](./consolidated-first-core-contracts.md "implements"), and the snapshot decisions. `writeFile` controls allow final-symlink replacement and atomic final-mode application without temporary entries or duplicate watcher events.
