---
type: Contract
title: Portable snapshot deltas
description: Defines exact base-dependent snapshot reconstruction, deterministic inspection, Schema encoding and finite work limits.
status: stable
tags: [snapshots, delta, schema, portability, limits]
sources:
  - id: api
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Public snapshot delta operations and codec
  - id: models
    resource: ../../packages/core/src/SnapshotDelta.ts
    title: Public delta, change, error and limit models
  - id: implementation
    resource: ../../packages/core/src/internal/snapshotDelta.ts
    title: Delta construction, validation, encoding and application
  - id: identity
    resource: ../../packages/core/src/internal/merkle.ts
    title: The Merkle identity encoding and its versioned algorithm name
  - id: budget
    resource: ../../packages/core/src/internal/budget.ts
    title: The internal budget both public limit schemas decode into
  - id: behavior-tests
    resource: ../../packages/core/test/SnapshotDelta.test.ts
    title: Reconstruction, identity, inspection and ownership tests
  - id: decoding-tests
    resource: ../../packages/core/test/SnapshotDeltaDecoding.test.ts
    title: Hostile decoding and exact-boundary limit tests
  - id: effect-crypto
    resource: https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Crypto.ts
    title: Effect platform-neutral Crypto service
generated: { by: claude/okf, at: 2026-09-26T13:55:00+02:00 }
---

# Portable snapshot deltas

`diffSnapshots(base, target, limits?)` produces an opaque, portable `SnapshotDelta`. `applySnapshotDelta(base, delta, limits?)` reconstructs a new opaque `Snapshot`; it never mutates or exposes a live volume. Creation, inspection and application intentionally require Effect's platform-neutral `Crypto.Crypto` service. A delta is valid only for a base with the same canonical semantic SHA-256 identity. Inspecting or applying it against a different valid base, including the delta's own target, fails with a `VfsError` whose code is `BaseMismatch`.[^api][^effect-crypto]

The identity includes the complete reachable namespace, raw byte paths, node kinds, regular-file bytes, symbolic-link targets, all retained metadata and hard-link equivalence classes. It ignores snapshot record ordering and inode numbers.[^identity]

The identity is a Merkle tree. A node's digest is SHA-256 over its kind byte, uid, gid and mode as 64-bit big-endian integers, its four timestamps as length-framed decimal text, then its length-framed payload, or for a directory its entry count followed by each entry's length-framed name bytes and the child's digest, entries in the byte order of their names. The snapshot's identity is SHA-256 over the domain prefix `effect-vfs-semantic-sha256-v1` and a NUL, the root directory's digest, and the hard-link groups: their count, then each group as its path count and length-framed raw paths in byte order, groups ordered by their first path. A node's digest leaves out the names that reach it, so a hard-linked file is hashed once and two directories with the same digest hold the same subtree; the group list is what tells apart trees that differ only in which names share a node. Every hashed byte counts against `maxIdentityBytes`, charged before the bytes are assembled. Application and inspection re-hash only the nodes a delta rewrote, yet charge the target's whole preimage: the base's node bytes, less those of the nodes replaced or removed, plus the rewritten nodes and the identity frame, so they refuse exactly the targets a diff to them refuses.[^identity]

The identity algorithm carries its own version, so its byte layout is a persisted compatibility contract rather than an implementation detail. Two golden digests pin it: one over the empty snapshot, which fixes the domain prefix, the algorithm identifier, the root directory's node encoding and the empty group list, and one over a populated fixture that reaches every remaining element of the encoding. That fixture covers entries sorted by name bytes, each node kind byte, a child digest under a subdirectory, a hard-link group whose paths were declared out of order, empty and non-empty payloads, a symbolic-link payload, a raw non-UTF-8 byte path, distinct owner, group and mode values so a field reordering cannot hide, and negative and very large timestamps so their variable-length decimal framing stays fixed.[^identity-goldens]

A golden failure is either a regression or a deliberate change. A deliberate change is only complete when the algorithm identifier is bumped in the same commit, both digests are regenerated, this contract is updated and the release note records that previously serialised deltas no longer validate. Regenerating a digest on its own silently breaks every stored delta. The one exception so far is the 0.6.0 major: the flat identity stream became the Merkle tree above under the unchanged identifier `effect-vfs-semantic-sha256-v1`, because the delta format itself was replaced in the same breaking release and no earlier delta decodes any more. Both goldens were regenerated then, and the test beside them says why.[^identity-goldens]

`inspectSnapshotDelta(base, delta, options?, limits?)` verifies the delta against its semantic base, then returns a frozen, owned, raw-byte-path summary in deterministic path order. `SnapshotChange` has `Added`, `Removed` and `Updated` variants. It does not infer renames between independent snapshots. Timestamp-only changes are hidden unless `includeTimestamps` is true.[^behavior-tests]

`SnapshotDeltaFromBytes(limits?)` is the public Effect Schema transformation between owned `Uint8Array` values and opaque deltas. Its internal JSON/base64 document is separately versioned as `effect-vfs-delta` version 1: `{ format, version, base, target, changes }`, with the two identities as canonical base64 and one change per path that differs. Decoding is one schema with one rule check. It rejects unsupported versions, excess fields, malformed UTF-8 or base64, digests of the wrong length, invalid or unordered paths, a node that does not match its change's kind, a payload carried when the change does not alter it or missing when it does, and a hard link that names no earlier change's node. Failures keep the fields callers have relied on (`digest`, `changePath`, `payload`, `changes`) and otherwise name the change from the issue path, such as `changes.1.node.to`. Base-dependent inconsistencies fail during inspection or application with `InvalidStructure` before a snapshot is returned. A change the base does not bear out names itself: `changes.<index>`, `changes.<index>.differences` for a forged difference list, or `parent` for a change under a missing directory. Changes that fold but do not reach the target identity fail at `changes`. The per-change checks are not redundant with the identity: a directory folded away without its entries would leave them unreachable, so the remaining identity still matches.[^decoding-tests]

One complete `SnapshotDeltaLimits` policy applies to creation, inspection, encoding, decoding and application. Omitting it uses the frozen `SnapshotDeltaLimits.default`; `SnapshotDeltaLimits.constrained` is the frozen memory-sensitive preset. A custom policy must provide every field. Byte budgets use Effect's exact `ByteSize.ByteSize` type, while record and entry counts remain numbers. The policy is a thin schema over the one internal budget the snapshot codec also reads. It bounds encoded bytes, the decoded digests, paths and payloads a delta holds, the bytes hashed for each identity, base and target records, the changes a delta holds, the names either snapshot holds and a delta writes, the records and payload bytes an applied delta produces, and the target records inherited from the base rather than written by the delta. The target record and entry bounds, and the output and inherited bounds, apply on creation, inspection and application, where the target is known, not on decoding; an applied target fails at `targetRecords`, `entries` or `identityBytes` exactly where a diff to it would. The root counts as a record, so a `maxBaseRecords` or `maxTargetRecords` of zero refuses every snapshot.[^models][^budget]

The delta stores changes, not the target object graph. An `Added` or `Updated` change carries the node it leaves: metadata, and a file's content or a symbolic link's target only when the change adds the node or alters its kind or payload; otherwise the payload stays the one the same path held in the verified base. A name that joins a hard-link group carries a link to the group's first path, whose change carries the node. A one-file edit is therefore one change whatever the tree's size. Creation walks both snapshots at once and descends only where digests differ, then compares the grouped paths under the subtrees it skipped. Application folds the changes over the base value, removals from the deepest path up and additions from the root down, checks that the base bears out every change and that each update lists exactly its differences, then digests only the nodes it rewrote and the directories above them to check the target identity. Applying a delta orders each directory's entries by the raw bytes of their names, so the same delta reconstructs the same entry order on every runtime, including Node builds without ICU. A delta never carries entry order itself.[^implementation][^behavior-tests]

[^api]: `VirtualFileSystem.ts` exposes the reusable Effect operations and Schema codec.

[^implementation]: The internal implementation owns wire layout, the diff walk and the fold; these details are not public constructors.

[^identity]: `merkle.ts` owns the node and identity encodings and the algorithm name.

[^behavior-tests]: Behavior tests inspect reconstructed paths, payloads and metadata and exercise hard-link splits and joins, a link joining an unchanged subtree, byte paths, timestamp filtering, reusable effects, delta size against tree size, the digests an apply spends, and overlays made from an applied snapshot.

[^identity-goldens]: `SnapshotDelta.test.ts` pins both digests and documents, beside the populated fixture, which encoding element each part of it exists to cover.

[^decoding-tests]: Decoder tests exercise malformed documents, forged changes against a real base, and every limit at and beyond its boundary.

[^models]: The public model keeps exact delta contents opaque while exposing stable inspection and policy schemas.

[^budget]: `budget.ts` holds the internal budget, and `DecodeLimits` and `SnapshotDeltaLimits` decode into it with their public field names unchanged.

[^effect-crypto]: Runtime packages provide native Node, Bun, browser and Deno implementations; the filesystem core depends only on the Effect service interface.
