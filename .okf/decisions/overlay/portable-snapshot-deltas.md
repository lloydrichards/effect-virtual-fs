---
type: Decision
title: Portable snapshot delta interface
description: Defines exact snapshot deltas, path-oriented inspection, Schema encoding, semantic base identity and bounded reconstruction.
status: stable
tags: [snapshots, delta, schema, portability, limits]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/9
    title: Snapshot change inspection and portability design issue
  - id: research
    resource: ../../research/overlay-changes.md
    title: Snapshot delta representation and validation research
  - id: snapshots
    resource: ../../contracts/snapshots-and-fixtures.md
    title: Existing snapshot ownership and validation contract
  - id: overlay-summary
    resource: overlay-final-difference-summary.md
    title: Existing lineage-aware overlay summary decision
  - id: implementation
    resource: ../../../packages/core/src/internal/snapshotDelta.ts
    title: Implemented snapshot delta representation and validation
  - id: rebuild
    resource: ../core/persistent-tree-rebuild.md
    title: Persistent tree rebuild, whose serialisation step replaced the delta format
  - id: amendment
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/185
    title: One tree schema, change-event deltas and streaming codecs
generated: { by: claude/okf, at: 2026-09-26T03:00:00+02:00 }
---

# Portable snapshot delta interface

Accepted by the user on 2026-09-12 before implementation of issue #9. The first release includes an exact, portable `SnapshotDelta`, not only an in-process summary. It reconstructs one target snapshot from one semantically matching immutable base. It is neither an operation journal nor a patch for a changed base. Merge, rebase and conflict handling remain separate work.[^issue]

## Public operations

`diffSnapshots(base, target, limits?)` returns an opaque `SnapshotDelta`. `inspectSnapshotDelta(base, delta, options?, limits?)` verifies the delta against its semantic base and derives an owned, deterministic `ReadonlyArray<SnapshotChange>`. `applySnapshotDelta(base, delta, limits?)` returns a new opaque `Snapshot`, never a live `Volume`.

`SnapshotChange` is separate from `OverlayChange`. It is path-oriented and has `Added`, `Removed` and `Updated` variants. Updates report before and after kinds plus changed semantic fields. The difference vocabulary covers kind, regular-file content, symbolic-link target, hard-link topology, ownership, mode and timestamps. Independent snapshots do not retain shared lineage, so inspection never guesses `Renamed` or lineage-based `Replaced` records. Moves appear as removal plus addition.[^overlay-summary]

`SnapshotDelta` owns the exact records and payloads required for reconstruction. The public change summary remains payload-free and does not expose internal record identifiers or the wire representation.

## Schema encoding

The first release includes public encoding and decoding through `SnapshotDeltaFromBytes(limits?)`. This Effect Schema transforms owned encoded `Uint8Array` values to and from opaque `SnapshotDelta` values. The delta has its own versioned format and does not extend complete snapshot format version 1. Record-level wire schemas remain internal so later format versions can change representation without exposing construction details.

`SnapshotDeltaLimits` is one complete resource policy used by delta creation, inspection, encoding, decoding and application. Omitting it selects the finite `SnapshotDeltaLimits.default` preset. `SnapshotDeltaLimits.constrained` is a second frozen preset for memory-sensitive environments. Callers may pass a complete custom value or spread a preset and replace fields. Presets use resource-oriented names rather than runtime or vague size labels.

The `constrained` and `default` presets bound encoded input, the bytes hashed for each identity, the changes a delta holds, decoded delta bytes, base, target and output records, namespace entries, output payload and the target records inherited from the base. Their numeric values live with the implementation and are not repeated here.[^implementation]

The policy bounds encoded input, the changes, the decoded delta bytes, the names written and the carried payload during decoding. Creation, inspection and application also bound base and target records, namespace entries, the applied target's records and payload, and the records it inherits. Limit checks occur before publishing a partial delta or reconstructed snapshot. Since #185 the policy is a thin schema over the internal budget the snapshot codec also reads, with its field names unchanged.[^amendment]

## Base identity and failures

Each delta records versioned SHA-256 identities of its base and its target over a canonical semantic representation. Canonicalization covers root metadata, raw byte paths in deterministic order, node kinds, contents or symbolic-link targets, all retained metadata and hard-link equivalence classes. It excludes image-local record IDs and runtime inode values. Since #185 the identity is a Merkle tree, a digest per node over its own bytes and its children's digests in name-byte order, with the hard-link groups listed at the root, under the unchanged algorithm name.[^amendment] Two snapshots with the same complete filesystem state therefore satisfy the same base requirement even when record order, image-local IDs or encoded JSON bytes differ. Hashing delegates to Effect's `Crypto.Crypto` service; the core owns no cryptographic implementation and imports no host platform.[^snapshots]

Invalid encoding, structure, version or resource limits remain codec failures with their own codes. A valid delta inspected or applied against the wrong valid base fails `BaseMismatch`. Both are codes of the one `VfsError` family since the public API decision replaced `ImageError` and `SnapshotDeltaError`.

## Implementation boundary

The public interface, semantic identity and safety rules are stable. Version 1 originally stored the target object graph with same-path inherited payload references. Since #185 it stores one change per differing path in the existing `Added | Removed | Updated` vocabulary, each carrying only the node it leaves, with a payload only where the change alters it and a link to the group's first path for a name that joins a hard-link group, so its size follows the changes rather than the tree. Diffing skips subtrees whose digests agree, and applying folds the changes over the base value and checks the target identity by digesting only what it rewrote. Deltas encoded before 0.6.0 no longer decode, which the same breaking release licenses.[^amendment][^rebuild] The internal record layout, the identity byte layout and the comparison walk remain non-public implementation choices. The Effect runtime service owns SHA-256 execution. Tests cover exact reconstruction, byte names, metadata, symbolic links, hard-link topology, deterministic inspection, owned results, hostile decoding, wrong bases and limit boundaries.[^research][^implementation]

[^issue]: Issue #9 asks for inspectable and portable snapshot changes and names exact-base rejection as a design requirement.

[^overlay-summary]: Overlay summaries may report renames because the live workspace retains base lineage. Independent snapshot comparison lacks that evidence.

[^snapshots]: Existing snapshots preserve complete reachable state and hard-link relationships through image-local IDs, but those IDs are not stable across images.

[^implementation]: `snapshotDelta.ts` owns the version 1 change layout, the diff walk and the fold; `merkle.ts` owns the identity encoding, and `SnapshotDelta.ts` the preset values.

[^amendment]: Issue #185's decisions of 2026-09-25 replaced the identity and the delta layout inside the 0.6.0 major and kept this decision's public operations and failures.

[^rebuild]: The rebuild decision's step 7 is the serialisation work this amendment belongs to.

[^research]: The draft research retains the unresolved representation and measurement work without reopening this public decision.
