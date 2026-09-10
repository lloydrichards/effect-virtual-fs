---
type: Contract
title: Overlay workspaces
description: Defines snapshot-based writable workspaces, shared immutable contents, final-difference summaries and consistent complete capture.
status: stable
tags: [overlay, snapshots, isolation, changes]
sources:
  - id: core
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Overlay construction, content promotion and capture
  - id: comparison
    resource: ../../packages/core/src/internal/overlayChanges.ts
    title: Identity-based final-state comparison
  - id: behavior
    resource: ../../packages/core/test/Overlay.test.ts
    title: Overlay behavior and integration tests
  - id: sharing
    resource: ../../packages/core/test/OverlayContent.test.ts
    title: Internal shared-content identity evidence
generated: { by: codex/okf, at: 2026-09-10T14:46:00+02:00 }
---

# Overlay workspaces

`makeOverlay` creates an ordinary `Volume` from one immutable `Snapshot`. Workspaces made from the same snapshot share unchanged regular-file payloads, while their namespace, metadata, coordination, callers, handles and watches are private. Every content mutation replaces the workspace's whole-file payload, including same-sized handle writes. Reads and metadata operations retain the shared payload. Public byte results remain owned copies.[^core][^sharing]

Logical entry and byte limits apply to the complete visible volume. Shared base contents count once per inode; promotion is not an extra charge. Unlinked-open files retain their existing charge, and writes may return the prefix that fits remaining capacity.[^core][^behavior]

`changes()` returns deterministic final differences from the immutable base. Timestamp fields are ignored by default and included with `includeTimestamps`. Renames require an unambiguous retained lineage; equal contents never establish identity. Same-path new identities are replacements, and ambiguous alias changes remain additions and removals. Ordering compares raw path bytes.[^comparison]

`makeOverlay`, `changes()` and `capture()` return reusable Effects. Each execution of `makeOverlay` creates a fresh workspace, while each execution of `changes()` or `capture()` observes the workspace again. Invalid construction or summary options fail with `ConfigurationError`; failures while inspecting or constructing snapshots fail with `ImageError`. Summary schemas retain opaque, in-process `BytePath` values and do not define a portable summary encoding.[^core]

`capture()` returns a complete snapshot and matching summary from one committed state. Both are owned and stable after later writes. The snapshot retains version 1 encoding and checkpoint compatibility. Restoring it recovers filesystem state only; it does not recover the previous overlay base, lineage or summary. Reset is application-level replacement with a fresh workspace, so old resources keep their independent lifetimes.[^core][^behavior]

This contract implements the accepted [staged overlay delivery](/decisions/staged-overlay-delivery.md "implements"). Delta persistence, live backing volumes, merge or rebase, in-place reset, changed-data budgets, block copying and performance guarantees remain deferred.

[^core]: `makeOverlay`, the private content store, mutation paths and the shared observation routine define runtime behavior.

[^comparison]: The comparator pairs lineage before replacement classification and sorts byte paths without string conversion.

[^behavior]: Core, memory-adapter and persistence tests cover the public behavior and complete-snapshot integration.

[^sharing]: The white-box test proves two constructed workspaces retain the same cached payload after reads and metadata changes.
