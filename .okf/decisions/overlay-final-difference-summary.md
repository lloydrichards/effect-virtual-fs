---
type: Decision
title: Overlay final-difference summary
description: Defines overlay change inspection as the current difference from its immutable base rather than an operation history.
status: stable
tags: [overlay, changes, observation]
sources:
  - id: core
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Current snapshot ID assignment, watch events and mutation gate
  - id: images
    resource: ../../packages/core/src/internal/image.ts
    title: Complete-image records without overlay lineage
  - id: research
    resource: ../research/overlay-changes.md
    title: Summary, metadata and restoration distinctions
generated: { by: codex/okf, at: 2026-09-10T11:48:22Z }
---

# Overlay final-difference summary

Accepted by the user on 2026-09-10 and implemented by `OverlayVolume.changes` and `capture`. This refines [staged delivery](staged-overlay-delivery.md "refines"). The summary describes current differences from the immutable base, not intermediate operations or audit history.

## Final state and filtering

Creating then deleting a new file leaves no entry difference for that file. Repeated edits produce one final content difference. Restoring original bytes removes the content difference even if storage stays private; a dirty flag alone is insufficient. Other metadata or namespace differences may remain.

Hide timestamp-only differences by default, with `includeTimestamps` to include them. This includes access times from reads, times left by reverted edits and explicit time changes. Permissions, ownership, content and namespace changes remain visible. When another field differs, the default record omits timestamp field names. Complete snapshots always retain all timestamps.

## Renames

Report a rename when retained object identity makes pairing removed and added names unambiguous. Moving `/a.ts` to `/b.ts` gives one rename; editing it also adds a content difference. Removing `/a.ts` and creating unrelated `/b.ts` with identical bytes gives removal and addition. Equal bytes never prove a rename.

For ambiguous hard-link pairings, report added and removed names without guessing. This describes final relationships, not the operations performed. Runtime inode numbers across restores and independently assigned snapshot IDs are insufficient; retain base-to-workspace lineage. Directory-move grouping and presentation of content changes through several hard links remain open.

## Consistent capture

V1 includes an operation returning a summary and complete snapshot from one committed state. Later writes cannot alter either result. Separate calls may exist but do not promise matching states. Names and return types remain open.

Capture stable state and the lineage needed for comparison. An ordinary captured snapshot alone cannot recover discarded lineage. Comparison may run outside the mutation gate only after all its inputs are stable; this is an implementation option, not a latency guarantee.

Race writes and renames against capture, verify the summary matches its snapshot relative to the base, and verify later writes change neither. Test that timestamp filtering affects only the summary. The result remains informational, not a restorable delta.
