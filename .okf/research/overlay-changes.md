---
type: Design Proposal
title: Snapshot delta representation research
description: Retains future persistence, encoding, merge, and deeper profiling questions beyond the implemented portable snapshot delta contract.
status: draft
tags: [overlay, snapshots, persistence, delta]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/9
    title: Snapshot change inspection and portability design issue
  - id: core
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Watch events, access-time changes and snapshot IDs
  - id: images
    resource: ../../packages/core/src/internal/image.ts
    title: Strict complete-image schema and graph validation
  - id: checkpoints
    resource: ../../packages/persistence/src/CheckpointStore.ts
    title: Checkpoint store accepts ordinary snapshots
generated: { by: codex/okf, at: 2026-09-12T12:25:38+02:00 }
---

# Snapshot delta representation research

Future research beyond the implemented [portable snapshot delta contract](/contracts/snapshot-deltas.md "constrained by"). [Staged overlay delivery](/decisions/staged-overlay-delivery.md "contrasts with") uses complete snapshots for persistence, while [overlay summary semantics](/decisions/overlay-final-difference-summary.md "contrasts with") remain an in-process, lineage-aware view. Issue #9 owns the general snapshot-to-snapshot capability.[^issue]

An exact delta reconstructs a state only with its specified immutable base. It differs from a readable summary, an operation journal, and a patch applied to a changed base. Rebasing and conflict resolution require separate decisions.

## Representation and identity

Snapshot v1 encodes a complete rooted graph and rejects unknown fields. It has no deletion, inherited-record or base-identity fields.[^images] The accepted interface requires a separate versioned representation with:

- exact base identity and mismatch handling;
- new or changed object contents, symlink targets and metadata;
- byte-preserving directory additions, replacements and removals;
- references preserving unchanged base objects and hard-link topology;
- suppression of inherited children after directory deletion and recreation;
- metadata-only differences, including root and access times;
- a stable capture boundary and owned exported data.

Version 1 now stores the target object graph with same-path inherited payload references and inline changed payloads. Public inspection uses path-oriented `Added`, `Removed` and `Updated` records, while the wire representation remains internal. Alternative per-directory or compressed encodings remain future compatibility and profiling work.

Base matching uses a versioned SHA-256 digest over canonical semantic state, not encoded snapshot bytes. The implementation normalizes record ordering and image-local IDs while retaining raw names, metadata, contents, symbolic-link targets and hard-link equivalence classes. It delegates the digest to Effect's platform-neutral `Crypto.Crypto` service and bounds the assembled canonical bytes. The byte-stream layout remains an internal versioned implementation detail rather than a public construction contract.

## Required validation and measurements

`CheckpointStore` accepts complete snapshots only; storing delta bytes still requires a later extension and retention of the base.[^checkpoints] A watch log cannot supply faithful changes because it has no replay or payloads and omits access-time updates.[^core]

Validate before exposing restored state. Bound encoded bytes, records, entries, decoded payload and inherited-reference work. Reject wrong or missing bases, conflicting entries, invalid names or references, forbidden directory cycles/aliases and unsupported versions. Apply destination quotas to the whole reconstructed view; failed restore must expose no partial volume.

Required evidence: base-plus-delta restoration matches a complete snapshot in bytes, metadata and alias topology; deletion and recreation, kind replacement, raw names, symbolic links and metadata-only edits survive; corrupt inputs, wrong bases and limit failures publish nothing; returned bytes cannot mutate prior state; independent restores remain isolated. Canonical digest tests must prove that record order and image-local IDs do not affect identity while every retained semantic field does.

The shipped presets are conservative finite defaults rather than universal workspace-size recommendations. Cross-runtime performance profiling, compressed encoding, checkpoint integration, and merge or rebase semantics remain future work.

[^issue]: Issue #9 asks for inspectable and portable snapshot changes and keeps names and package placement open for this design.

[^images]: `Document` and `capture` define and validate the strict complete-image graph.

[^core]: `Volume.snapshot` assigns traversal IDs; `Change` contains only a tag and path; reads change access times without `publishNode`.

[^checkpoints]: `CheckpointStore.save` accepts `Vfs.Snapshot` and encodes the ordinary image; load validates that same boundary.
