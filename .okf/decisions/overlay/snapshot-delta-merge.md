---
type: Decision
title: Snapshot delta merge
description: Accepts a total path-level three-way merge of two snapshot deltas from one base, with conflicts returned as data, field-wise metadata, per-inode hard links and data resolutions.
status: stable
tags: [overlay, snapshots, delta, merge, agents, conflicts]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/174
    title: Merge snapshot deltas from a common base, with the decisions comment of 2026-10-02
  - id: deltas
    resource: portable-snapshot-deltas.md
    title: The exact base-bound delta this merge consumes and produces
  - id: overlay-summary
    resource: overlay-final-difference-summary.md
    title: Lineage-aware overlay summaries, including the rule that equal bytes never prove a rename
  - id: research
    resource: ../../research/overlay-changes.md
    title: Delta research that held merge and rebase open
  - id: implementation
    resource: ../../../packages/core/src/internal/snapshotMerge.ts
    title: Classification, hard-link partition check, resolution and emission over the existing fold
  - id: tests
    resource: ../../../packages/core/test/SnapshotMerge.test.ts
    title: Conflict table and property laws
  - id: git-ort
    resource: https://github.com/git/git/blob/master/merge-ort.c
    title: Tree-level trivial resolution and independent mode merging in git
  - id: jj
    resource: https://github.com/jj-vcs/jj/blob/main/lib/src/merge.rs
    title: Jujutsu trivial merge with the same-change rule
  - id: mesa
    resource: https://docs.mesa.dev/content/reference/ts/bookmarks-merge.md
    title: Mesa merge with conflicts as data and path resolutions
generated: { by: claude/okf, at: 2026-10-02T20:00:00+02:00 }
---

# Snapshot delta merge

It closes the merge question the [delta research](../../research/overlay-changes.md "resolves") held open and refines the [portable delta interface](portable-snapshot-deltas.md "refines"). The implemented rules are recorded by the [snapshot delta contract](../../contracts/snapshot-deltas.md "implemented by"). Text-level merge, conflict markers, rebase onto another base and branch names stay outside.[^issue]

## Contract and output

`mergeSnapshotDeltas(base, ours, theirs, options?)` is total. It returns `{ delta, conflicts }` where the delta takes every change neither side disputed and every resolved conflict, and paths still in conflict keep the base node. It fails only for `BaseMismatch`, limits, `InvalidArgument` for malformed options or resolutions, and structural `InvalidStructure`. Every surveyed merge used by agents or sync tools, Mesa, Dolt and Unison among them, applies the clean part and reports the rest, and one fold over the base gives the merged state either way.[^mesa]

The output is a `SnapshotDelta`, not a snapshot. It is portable, encodable and bound to the base identity, and it applies through the existing verified `applySnapshotDelta`. A merged delta cannot be made from two deltas alone: the target digest is a Merkle root over the folded tree and payload-less updates inherit bytes from the base, so the base is an input. Inputs are deltas only; overlay users call `diffSnapshots(base, capture.snapshot)` first.[^deltas]

## Conflict records

A conflict is `{ path, reason, ours, theirs }`. Each side is `Unchanged`, `Added { kind }`, `Removed { kind }` or `Updated { beforeKind, afterKind, differences }`, as `SnapshotChange` already reports, with timestamp fields left out. No payload bytes or metadata values are carried; the application reads them from the three snapshots it holds. The reason union is closed: `BothChanged`, `ChangedRemoved`, `BothAddedDifferent`, `KindDiverged`, `ParentRemoved` and `HardLinkGroupDiverged`.

## Rules

Per path the trivial rules of git and Jujutsu apply: one side unchanged takes the other; both sides identical in kind, bytes and merged metadata take it; both removed is absent. Same-change acceptance is not configurable, and repeated merges are documented as not associative. Metadata merges field by field, independently of content; the same `mode`, `uid` or `gid` changed on both sides to different values is `BothChanged`, never a tie-break, where git picks a side under an admitted FIXME. Timestamps never conflict: one side changed takes that side, both changed take the later value per field, and a change that touches only timestamps counts as no change when deciding conflicts.[^git-ort][^jj]

A directory removed on one side, or replaced by another kind, with a path added or updated beneath it on the other yields `ParentRemoved` per touched path, reporting the removing side as the change that eliminated the directory, and the whole removed subtree stays at base. A kind change against any other change at a path, including its removal, is one `KindDiverged` at that path without descent. Identical implicit parents merge; different ones are `BothAddedDifferent`. Renames stay path-level: a rename beside an edit is `ChangedRemoved` at the old path and a clean addition at the new one, with no heuristic detection, because [equal bytes never prove a rename](overlay-final-difference-summary.md "constrained by").

Hard links follow the node. Each side's final tree says which names share a node, so an edit through any name merges with a link, unlink or split from the other side, and a name one side unlinked and rewrote is a new node beside the old one. When both sides change which names a node holds and the results differ, every name involved is `HardLinkGroupDiverged` and the group stays at base, with two exceptions: two sides that only remove names agree and the removals add up , and linking a new name to a node the other side removed entirely is `ChangedRemoved` at the new name. Two sides that point one existing name at different nodes are `BothChanged` at that name; a new name they give to different nodes is `BothAddedDifferent` there, and either case ties both nodes into the conflict. A changed name held at base only because it shares a node with a conflicted name is reported as well, so nothing is withheld silently. No version-control system models hard links, so this rule has no precedent to follow.

## Resolutions

`options.resolutions` is data: `{ path, take: "ours" | "theirs" | "base" }` for paths an earlier merge reported. A second call re-merges with the choices and unresolved conflicts stay reported. A resolution for a path not in conflict, or a set of reported paths that spans one removed subtree or one hard-link group and is not resolved the same way throughout, fails `InvalidArgument` at `resolutions`. No policy shortcut and no replacement node exist yet.

## Placement and evidence

The operation lives in `VirtualFileSystem.ts` beside `diffSnapshots` and `applySnapshotDelta`; the schemas live in `SnapshotDelta.ts`; the engine in `internal/snapshotMerge.ts` reuses the delta fold, limit checks and identity hashing. It requires `Crypto.Crypto`, takes `limits` defaulting to `SnapshotDeltaLimits.default`, and ships in 0.8.0 as a minor change. Evidence is a row-per-pair conflict table over two fixtures and the repository's first property tests, six seeded laws: identity with the empty delta, idempotence, mirrored results when the sides swap, resolving every conflict with either side or base yields an applicable delta, one-sided paths are taken as left, and conflicted paths never appear in the result.[^tests]

## Follow-up

A rename-aware merge that accepts overlay captures, whose `Renamed` records carry lineage, so edits follow renames and rename/rename conflicts are reported, is tracked as rename-aware merge input.

[^issue]: The issue's decisions comment of 2026-10-02 lists the thirteen decisions and the follow-up.

[^deltas]: `verify` folds the changes over the base and recomputes the target with `foldedIdentity`; `fold` rejects an update whose differences the base does not bear out.

[^mesa]: Mesa's `bookmarks.merge` applies the clean part, reports `conflicted_entries` and accepts `resolutions: [{ path, take }]`.

[^git-ort]: merge-ort merges the mode independently when only one side changed it and admits that a two-sided mode conflict arbitrarily takes side A.

[^jj]: Jujutsu's `trivial_merge` resolves the same three cases and makes same-change acceptance a flag because it breaks the conflict algebra.

[^tests]: The property tests and an adversarial review found lineage and hard-link defects in the first draft, which the per-node model replaced; the table covers every paired change the review produced.
