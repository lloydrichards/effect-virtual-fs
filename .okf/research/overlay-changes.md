---
type: Design Proposal
title: Deferred overlay delta restoration
description: Retains later-stage delta identity, encoding and validation requirements without making them prerequisites for v1.
status: draft
tags: [overlay, snapshots, persistence, delta]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/8
    title: Open questions about inspecting and persisting overlay changes
  - id: core
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Watch events, access-time changes and snapshot IDs
  - id: images
    resource: ../../packages/core/src/internal/image.ts
    title: Strict complete-image schema and graph validation
  - id: checkpoints
    resource: ../../packages/persistence/src/CheckpointStore.ts
    title: Checkpoint store accepts ordinary snapshots
generated: { by: codex/okf, at: 2026-09-10T11:03:16Z }
---

# Deferred overlay delta restoration

Draft research for a later stage, not v1 requirements. [Staged delivery](/decisions/staged-overlay-delivery.md "constrained by") uses complete snapshots for persistence; [summary semantics](/decisions/overlay-final-difference-summary.md "constrained by") are accepted separately. Issue #8 motivated exploring changes-only export.[^issue]

A future exact delta reconstructs a state only with its specified immutable base. It differs from a readable summary, an operation journal, and a patch applied to a changed base. Rebasing and conflict resolution require separate decisions.

## Representation and identity

Snapshot v1 encodes a complete rooted graph and rejects unknown fields. It has no deletion, inherited-record or base-identity fields.[^images] A delta needs a separate versioned representation with:

- exact base identity and mismatch handling;
- new or changed object contents, symlink targets and metadata;
- byte-preserving directory additions, replacements and removals;
- references preserving unchanged base objects and hard-link topology;
- suppression of inherited children after directory deletion and recreation;
- metadata-only differences, including root and access times;
- a stable capture boundary and owned exported data.

Per-directory edits, replacement records and opaque markers are alternatives, not settled encoding choices. Exclude live resources and unreachable open files as ordinary snapshots do.

Retain lineage for inherited references; IDs are assigned afresh during snapshot traversal.[^core] A digest of precisely defined base bytes could identify an exact encoding, but would not identify every logically equivalent filesystem. Algorithm, encoding stability, base lookup and mismatch errors remain open.

## Proposed later-stage validation

`CheckpointStore` accepts complete snapshots only; storing delta bytes requires an extension and retention of the base.[^checkpoints] A watch log cannot supply faithful changes because it has no replay or payloads and omits access-time updates.[^core]

Validate before exposing restored state. Bound encoded bytes, records, entries, decoded payload and inherited-reference work. Reject wrong or missing bases, conflicting entries, invalid names or references, forbidden directory cycles/aliases and unsupported versions. Apply destination quotas to the whole reconstructed view; failed restore must expose no partial volume.

Proposed evidence: base-plus-delta restoration matches a complete snapshot in bytes, metadata and alias topology; deletion/recreation, replacement, raw names, symlinks and metadata-only edits survive; corrupt inputs and quota failures publish nothing; returned bytes cannot mutate prior state; independent restores remain isolated. These tests and a delta format are deferred.

[^issue]: Issue #8 asks about inspecting and persisting only changes; subsequent accepted scope defers exact delta persistence.

[^images]: `Document` and `capture` define and validate the strict complete-image graph.

[^core]: `Volume.snapshot` assigns traversal IDs; `Change` contains only a tag and path; reads change access times without `publishNode`.

[^checkpoints]: `CheckpointStore.save` accepts `Vfs.Snapshot` and encodes the ordinary image; load validates that same boundary.
