---
type: Research Report
title: Rename-aware overlay merge proposal
description: Proposes a base-bound overlay capture and conflict rules for merging declared file renames.
status: draft
tags: [overlay, snapshots, merge, renames]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/271
    title: Rename-aware merge scope and release dependency
  - id: capture
    resource: ../../packages/core/src/internal/virtualFileSystem.ts
    title: Overlay creation and capture from one committed state
  - id: lineage
    resource: ../../packages/core/src/internal/overlayDiff.ts
    title: Identity-based pairing of removed and added names
  - id: tests
    resource: ../../packages/core/test/SnapshotDelta.test.ts
    title: Current delta-only rename behavior and merge laws
---

# Rename-aware overlay merge proposal

If one overlay moves `/r.txt` to `/moved.txt` and another edits `/r.txt`, the proposed merge puts the edited file at `/moved.txt`. The shipped [snapshot delta merge](../contracts/snapshot-deltas.md) compares paths. In the same case it reports `ChangedRemoved` at `/r.txt` and adds `/moved.txt`. Both behaviors have a purpose. Callers opt into lineage through a separate merge interface.

This draft proposes a community-core extension. A named consumer and its required behavior must be agreed before implementation. Inclusion in the [minimal Effect port](minimal-effect-port.md) requires a separate scope decision. Issue [#271](https://github.com/lloydrichards/effect-virtual-fs/issues/271) remains outside the v1.0 requirements.

## Capture and merge

The proposed operations are `captureOverlayForMerge(overlay)` and `mergeOverlayCaptures(base, ours, theirs, options?)`. The first returns an opaque in-process value from a genuine core overlay. The second returns a standard `SnapshotDelta` and conflict records. The existing `OverlayVolume` and `OverlayCapture` shapes, delta-only operation, and version 1 delta encoding stay compatible.

The capture retains the overlay's original base and an immutable view of the target and its private lineage from one committed state. Merge compares both retained bases with the supplied base by the existing canonical snapshot identity and rejects a mismatch with `BaseMismatch`. An independently restored base with the same identity is eligible. Lineage is derived inside each original overlay and matches across sides by the source path in that common base. Runtime inode numbers from two overlays are never matched against one another. A fabricated capture fails input validation. A plain capture or detached `Renamed` record cannot establish provenance.

The base check and lineage preparation use the merge's finite limits. Count additional lineage and conflict work during implementation, including alias scans and the total number of paths held by conflict groups. Bytes and metadata come from the verified snapshots. The result applies through `applySnapshotDelta` to the same base. It carries the merged tree in the current encoding.

## First supported moves

Accept a move when a base regular file has one name, the same object has exactly one name at capture, the old name is absent, and the destination was absent in the base. Require the same base directories to remain ancestors of every involved path on both sides. Reject an unsupported move before merging if it moves a directory or symlink, involves a file with multiple names on either side, replaces a base destination, or overlaps a move from a different base source. Reject the group if the other side replaces the source with an unrelated object or both removes the source and independently adds a destination. An independent addition at the destination must be a single-link regular file. Reject a directory collision before merging so its descendants never enter the delta as clean changes. Report the involved path and unsupported condition. Plain path changes outside these groups continue through ordinary delta merge.

The [overlay summary](../decisions/overlay/overlay-final-difference-summary.md) describes final differences. An intermediate name with no remaining effect adds no work to this merge. Swaps, chains involving several base files, directory moves, and hard-link moves require separate rules. File bytes and matching metadata never establish rename lineage.

## Outcomes for one base file

In the table, `/r` is the source, `/a` and `/b` are new destinations, and the sides can be swapped. A clean move changes only the name and possibly timestamps. Use the existing content, field-wise metadata, and timestamp rules when combining changes to the same file.

| Ours                       | Theirs                                       | Proposed result                                                                                  |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Move `/r` to `/a`          | Leave `/r` unchanged                         | Place the moved file at `/a`.                                                                    |
| Move `/r` to `/a`          | Edit the same file at `/r`                   | Put the combined file at `/a`. If the edits disagree, report one `BothChanged` conflict at `/a`. |
| Move `/r` to `/a`          | Move `/r` to `/a`                            | Merge the edits once at `/a`. If the edits disagree, report one `BothChanged` conflict there.    |
| Move `/r` to `/a`          | Move `/r` to `/b`                            | Report one proposed `RenameDiverged` conflict for `/r`, with both destinations.                  |
| Move `/r` cleanly to `/a`  | Remove `/r`                                  | Remove the file.                                                                                 |
| Move and edit `/r` at `/a` | Remove `/r`                                  | Report one `ChangedRemoved` conflict at `/a`.                                                    |
| Move `/r` to `/a`          | Keep or edit `/r` and independently add `/a` | Accept an agreed file at `/a` or report one conflict there.                                      |

For the destination collision, combine edits to `/r` first. If they disagree, report `BothChanged`. Otherwise compare the candidate moved file with the addition under the existing same-change rules. A disagreement is `BothAddedDifferent`.

## Conflict groups and resolutions

A rename conflict carries the base source, the path at which the conflict is presented, and both side summaries with their separate destinations when present. The `RenameDiverged` case presents the conflict at the source. Keep the source and all destinations at base while unresolved. This preserves one base file and reserves the destination paths, so a single conflict cannot leave half a move behind. Other clean changes still apply.

The caller submits one `{ source, take }` resolution for the whole rename group. `take` selects `ours`, `theirs`, or `base`. It applies the selected side's final values at every path in the group, including both destinations when present. A collision resolution that selects the independent addition keeps that side's source state as well. Reject duplicate or unknown resolutions and overlapping groups before emitting a delta. Ordinary path conflicts outside these groups keep the current path-based resolutions.

## Review and verification

Confirm the consumer, the lifetime of the opaque capture, and the proposed conflict and resolution shapes before writing production code. The implementation must earn its added interface by keeping lineage validation and delta emission inside core. A portable rename format, destination choice outside the existing paths, and cross-process trust require separate designs.

- Exercise every outcome through real overlay operations. Include timestamp-only differences, field-wise metadata, and independent same-byte additions. Verify removal followed by recreation with equal bytes yields no move.
- Reject fabricated captures, wrong bases, pre-existing destinations, replaced parents, and ambiguous or overlapping moves. Reject a destination directory containing a child before emitting a delta. Accept equivalent base snapshots and confirm later overlay writes leave captures unchanged.
- Check that an unresolved group holds every affected path at base, clean paths still apply, and each valid group resolution emits an applicable delta. Reject duplicate, unknown, and overlapping choices.
- Run seeded identity, identical-input, and mirrored-side laws. Reapply each result through `applySnapshotDelta` and compare the resulting tree, then rerun the unchanged delta-only conflict matrix and encoding checks.[^tests]

[^tests]: The shipped tests include a rename plus an edit and two different rename destinations. These cases establish the delta-only results the new interface must preserve.
