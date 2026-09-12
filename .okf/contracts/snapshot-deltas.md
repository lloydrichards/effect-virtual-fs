---
type: Behavioral Contract
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
  - id: behavior-tests
    resource: ../../packages/core/test/SnapshotDelta.test.ts
    title: Reconstruction, identity, inspection and ownership tests
  - id: decoding-tests
    resource: ../../packages/core/test/SnapshotDeltaDecoding.test.ts
    title: Hostile decoding and exact-boundary limit tests
  - id: effect-crypto
    resource: https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Crypto.ts
    title: Effect platform-neutral Crypto service
generated: { by: codex/okf, at: 2026-09-12T12:25:38+02:00 }
---

# Portable snapshot deltas

`diffSnapshots(base, target, limits?)` produces an opaque, portable `SnapshotDelta`. `applySnapshotDelta(base, delta, limits?)` reconstructs a new opaque `Snapshot`; it never mutates or exposes a live volume. Both operations intentionally require Effect's platform-neutral `Crypto.Crypto` service. A delta is valid only for a base with the same canonical semantic SHA-256 identity. Applying it to a different valid base fails with `SnapshotDeltaError` code `BaseMismatch`.[^api][^effect-crypto]

The identity includes the complete reachable namespace, raw byte paths, node kinds, regular-file bytes, symbolic-link targets, all retained metadata and hard-link equivalence classes. It ignores snapshot record ordering and image-local record identifiers.[^implementation]

`inspectSnapshotDelta(base, delta, options?, limits?)` verifies the delta against its semantic base, then returns a frozen, owned, raw-byte-path summary in deterministic path order. `SnapshotChange` has `Added`, `Removed` and `Updated` variants. It does not infer renames between independent snapshots. Timestamp-only changes are hidden unless `includeTimestamps` is true.[^behavior-tests]

`SnapshotDeltaFromBytes(limits?)` is the public Effect Schema transformation between owned `Uint8Array` values and opaque deltas. Its internal JSON/base64 document is separately versioned as `effect-vfs-delta` version 1. Decoding rejects unsupported versions, excess fields, malformed UTF-8 or base64, invalid paths, duplicate namespace entries and cross-path inherited references. Base-dependent inconsistencies, including forged summaries and unresolved inherited references, fail during inspection or application before a snapshot is returned.[^decoding-tests]

One complete `SnapshotDeltaLimits` policy applies to creation, encoding, decoding and application. Omitting it uses the frozen `SnapshotDeltaLimits.default`; `SnapshotDeltaLimits.constrained` is the frozen memory-sensitive preset. A custom policy must provide every field. Limits bound encoded and decoded bytes, canonical identity bytes, base, target, delta and output records, namespace entries, output payload bytes and inherited-record work.[^models]

The delta stores the target object graph. Unchanged regular-file and symbolic-link payloads may refer to a same-path object in the verified base; other payloads are inline. Directory and hard-link topology is reconstructed and validated as a complete snapshot before publication.[^implementation]

[^api]: `VirtualFileSystem.ts` exposes the reusable Effect operations and Schema codec.

[^implementation]: The internal implementation owns wire layout and canonical hashing; these details are not public constructors.

[^behavior-tests]: Behavior tests inspect reconstructed paths, payloads and metadata and exercise hard-link splits and joins, byte paths, timestamp filtering and reusable effects.

[^decoding-tests]: Decoder tests exercise malformed documents and every limit at and beyond its boundary.

[^models]: The public model keeps exact delta contents opaque while exposing stable inspection and policy schemas.

[^effect-crypto]: Runtime packages provide native Node, Bun, browser and Deno implementations; the filesystem core depends only on the Effect service interface.
