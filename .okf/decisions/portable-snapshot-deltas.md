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
    resource: ../research/overlay-changes.md
    title: Snapshot delta representation and validation research
  - id: snapshots
    resource: ../contracts/snapshots-and-fixtures.md
    title: Existing snapshot ownership and validation contract
  - id: overlay-summary
    resource: ./overlay-final-difference-summary.md
    title: Existing lineage-aware overlay summary decision
  - id: implementation
    resource: ../../packages/core/src/internal/snapshotDelta.ts
    title: Implemented snapshot delta representation and validation
generated: { by: codex/okf, at: 2026-09-12T14:02:54Z }
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

The constrained preset permits 2 MiB encoded input, 4 MiB canonical identity input, 6,500 stored records plus summary changes, 512 KiB decoded delta bytes, 6,500 base, target and output records, 6,500 namespace entries, 256 KiB output payload and 6,500 inherited records. The default preset permits 16 MiB encoded input, 32 MiB canonical identity input, 50,000 stored records plus changes, 8 MiB decoded delta bytes, 50,000 base and target records, 100,000 entries, 50,000 output records, 4 MiB output payload and 50,000 inherited records.[^implementation]

The policy bounds encoded input, delta records and decoded delta payload during decoding. Creation, inspection and application also bound base and target records, namespace entries, output payload and inherited-base work. Limit checks occur before publishing a partial delta or reconstructed snapshot.

## Base identity and failures

Each delta records a versioned SHA-256 digest over a canonical semantic representation of its base. Canonicalization covers root metadata, raw byte paths in deterministic order, node kinds, contents or symbolic-link targets, all retained metadata and hard-link equivalence classes. It excludes image-local record IDs and runtime inode values. Two snapshots with the same complete filesystem state therefore satisfy the same base requirement even when record order, image-local IDs or encoded JSON bytes differ. Hashing delegates to Effect's `Crypto.Crypto` service; the core owns no cryptographic implementation and imports no host platform.[^snapshots]

Invalid encoding, structure, version or resource limits remain codec or `ImageError` failures as appropriate. `SnapshotDeltaError` is a separate tagged error for a valid delta inspected or applied against the wrong valid base. Its initial machine-readable code set contains only `BaseMismatch`.

## Implementation boundary

The public interface, semantic identity and safety rules are stable. Version 1 internally stores the target object graph, uses same-path inherited payload references after base verification, and inlines other regular-file and symbolic-link payloads. The internal record layout, bounded canonical hash byte stream and comparison indexes remain non-public implementation choices. The Effect runtime service owns SHA-256 execution. Tests cover exact reconstruction, byte names, metadata, symbolic links, hard-link topology, deterministic inspection, owned results, hostile decoding, wrong bases and limit boundaries.[^research][^implementation]

[^issue]: Issue #9 asks for inspectable and portable snapshot changes and names exact-base rejection as a design requirement.

[^overlay-summary]: Overlay summaries may report renames because the live workspace retains base lineage. Independent snapshot comparison lacks that evidence.

[^snapshots]: Existing snapshots preserve complete reachable state and hard-link relationships through image-local IDs, but those IDs are not stable across images.

[^research]: The draft research retains the unresolved representation and measurement work without reopening this public decision.
