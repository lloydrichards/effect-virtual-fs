---
type: Contract
title: Portable snapshot deltas
description: Defines exact base-dependent snapshot reconstruction, deterministic inspection, Schema encoding, finite work limits and the path-level merge of two deltas from one base.
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
    resource: ../../packages/core/test/SnapshotDelta.test.ts
    title: Hostile decoding and exact-boundary limit tests
  - id: effect-crypto
    resource: https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Crypto.ts
    title: Effect platform-neutral Crypto service
  - id: merge
    resource: ../../packages/core/src/internal/snapshotMerge.ts
    title: Merge classification, hard-link partition check, resolutions and emission
  - id: merge-tests
    resource: ../../packages/core/test/SnapshotMerge.test.ts
    title: Merge conflict table and property laws
generated: { by: claude/okf, at: 2026-10-02T20:00:00+02:00 }
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

## Merging two deltas

`mergeSnapshotDeltas(base, ours, theirs, options?)` decodes its options, failing `InvalidArgument` at the offending limit field or at `resolutions` for a malformed one, verifies both deltas against one base, fails `BaseMismatch` for a foreign one, and returns `{ delta, conflicts }` under the [merge decision](../decisions/overlay/snapshot-delta-merge.md "implements"). The call is total: conflicts are data, and the returned delta is bound to the same base and applies with `applySnapshotDelta`. Changes on one side are taken; identical changes on both sides are taken once; both removed is absent. Metadata fields changed on one side combine with content changed on the other, the same `mode`, `uid` or `gid` set differently on both sides is a `BothChanged` conflict, and timestamps never conflict, taking the later value where both changed and counting as no change when deciding conflicts. A conflicted path keeps the base node. Each `MergeConflict` carries the path, a reason from `BothChanged`, `ChangedRemoved`, `BothAddedDifferent`, `KindDiverged`, `ParentRemoved` and `HardLinkGroupDiverged`, and each side as `Unchanged`, `Added`, `Removed` or `Updated` with its non-timestamp differences; no payloads or metadata values are included.[^merge]

A directory removed on one side, or replaced by another kind, with changes beneath it on the other reports `ParentRemoved` at each changed path, with the eliminating side shown as the change that eliminated the directory, and keeps the whole subtree at base; a side that only removed paths beneath it, or only touched their timestamps, agrees with the removal. A kind change against any other change at a path, including its removal, reports `KindDiverged` once and the subtree stays at base. Two sides adding the same directory merge their children; adding different nodes at one path is `BothAddedDifferent` and drops both subtrees. Renames are not inferred, so a rename beside an edit of the old name adds the new name cleanly and reports `ChangedRemoved` at the old one.[^merge-tests]

Hard links are merged per node, using each side's final tree to tell which names share a node. A side's class of names is a base node when one of its names still carries that node's bytes, else when it is the only class holding the node's kept names; when sibling classes already own the other candidates it belongs to the one left, and otherwise it is contested and the node is in conflict whenever the other side touched it. An edit through one name combines with a link, unlink or split from the other side; unlinking one name of a node the other side edited through another name is taken; a name one side unlinked and wrote anew is a new node beside the old one. When both sides changed which names a node holds and the results differ, every name involved is `HardLinkGroupDiverged` and stays at base, except that two sides that only remove names agree and the removals add up, and that linking a new name to a node the other side removed entirely is `ChangedRemoved` at the new name. Removing every name of a node the other side edited is `ChangedRemoved` at each name, and two sides that point one name at different nodes report `BothChanged` at it. A conflict keeps every name of the nodes it touches at base, including nodes tied to it by a new name both sides gave to different nodes, and the subtree of any directory a side removed above one of them. A changed name held at base only because it shares a node with a conflicted name is itself reported, with reason `HardLinkGroupDiverged`, so no change is withheld without a record; paths beneath a conflicted directory are covered by that directory's record and not reported again. The merged delta lists every name of a changed node, the first in byte order carrying it and the rest linking to it, and a surviving name whose group shrank or grew carries a `hardLinks` difference even when nothing else about it changed.[^merge]

`options.resolutions` holds `{ path, take }` entries with `take` one of `ours`, `theirs` or `base` for paths an earlier merge reported; the merge is run again with them and the chosen side's changes replace the conflict, while unresolved conflicts stay reported. A resolution for a path not in conflict, or a removed subtree or hard-link group whose reported paths are not all resolved the same way, fails `InvalidArgument` at `resolutions`. The operation requires `Crypto.Crypto` and `options.limits` defaults to `SnapshotDeltaLimits.default`; it consumes the same budgets as creation and application. Six seeded property laws hold over generated edit scripts: merging with an empty delta returns the input unchanged, merging a delta with itself returns it unchanged, swapping the sides mirrors the conflicts and leaves the delta identical, resolving every conflict with either side or with base yields a delta that applies, a path only one side changed is taken as that side left it when nothing conflicts, and a conflicted path never appears in the merged delta while every merged path comes from one of the inputs. Repeated merges are not associative.[^merge-tests]

[^api]: `VirtualFileSystem.ts` exposes the reusable Effect operations and Schema codec.

[^implementation]: The internal implementation owns wire layout, the diff walk and the fold; these details are not public constructors.

[^identity]: `merkle.ts` owns the node and identity encodings and the algorithm name.

[^behavior-tests]: Behavior tests inspect reconstructed paths, payloads and metadata and exercise hard-link splits and joins, a link joining an unchanged subtree, byte paths, timestamp filtering, reusable effects, delta size against tree size, the digests an apply spends, and overlays made from an applied snapshot.

[^identity-goldens]: `SnapshotDelta.test.ts` pins both digests and documents, beside the populated fixture, which encoding element each part of it exists to cover.

[^decoding-tests]: Decoder tests exercise malformed documents, forged changes against a real base, and every limit at and beyond its boundary.

[^models]: The public model keeps exact delta contents opaque while exposing stable inspection and policy schemas.

[^budget]: `budget.ts` holds the internal budget, and `DecodeLimits` and `SnapshotDeltaLimits` decode into it with their public field names unchanged.

[^effect-crypto]: Runtime packages provide native Node, Bun, browser and Deno implementations; the filesystem core depends only on the Effect service interface.

[^merge]: `snapshotMerge.ts` indexes both verified documents by path, classifies paths top down with timestamp-only updates treated as unchanged, compares each side's partition of a base node's names before the path loop, and emits one change list by lineage for the existing fold to validate and digest.

[^merge-tests]: `SnapshotMerge.test.ts` holds a row per paired change, resolution and rejection cases, and `it.effect.prop` laws over generated edit scripts.
