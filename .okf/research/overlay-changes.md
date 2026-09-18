---
type: Research Report
title: Snapshot delta representation research
description: Retains the open snapshot delta questions beyond the implemented contract, namely compressed encodings, checkpoint storage of deltas, cross-runtime profiling, and merge or rebase semantics.
status: stable
tags: [overlay, snapshots, persistence, delta]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/9
    title: Snapshot change inspection and portability design issue
  - id: core
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Watch events and access-time changes
  - id: checkpoints
    resource: ../../packages/persistence/src/CheckpointStore.ts
    title: Checkpoint store accepts complete snapshots only
generated: { by: claude/okf, at: 2026-09-16T23:00:00+02:00 }
---

# Snapshot delta representation research

Issue #9 asked for inspectable and portable snapshot changes.[^issue] The accepted interface is the [portable snapshot delta decision](../decisions/overlay/portable-snapshot-deltas.md "constrained by") and the shipped rules are the [snapshot delta contract](../contracts/snapshot-deltas.md "constrained by"). This concept retains the distinctions that framed the work and the questions that remain open.

## Distinctions that framed the design

An exact delta reconstructs a state only with its specified immutable base. It differs from a readable summary, which the [overlay final-difference summary](../decisions/overlay/overlay-final-difference-summary.md "contrasts with") provides as an in-process, lineage-aware view; from an operation journal; and from a patch applied to a changed base. A watch log cannot stand in for a delta because it carries no payloads or replay and omits access-time updates.[^core]

## Open questions

- **Alternative encodings.** Version 1 stores the target object graph with same-path inherited payload references and inline changed payloads. Per-directory or compressed encodings were deferred as compatibility and profiling work; nothing in core compresses today.
- **Checkpoint storage of deltas.** `CheckpointStore` accepts and returns complete snapshots only. Storing delta bytes needs a retention policy for the base, a way to name the base a delta depends on, and validation on load.[^checkpoints]
- **Profiling.** The shipped `default` and `constrained` presets are conservative finite bounds, not measured workspace-size recommendations. Cross-runtime measurements of creation, codec and application cost would let them be justified or revised.
- **Merge and rebase.** Applying a delta to a base other than its exact one, and reconciling two deltas from one base, need their own decisions on conflict detection and resolution.

[^issue]: Issue #9 keeps names and package placement open for later work; the decision and contract record what was adopted.

[^core]: `Change` carries only a tag and a path; reads update access times without publishing an event.

[^checkpoints]: `CheckpointStore.save` accepts `Vfs.Snapshot` and encodes the complete image; load validates that same boundary.
