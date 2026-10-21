---
type: Decision
title: Persistent volume state
description: Keeps volume state immutable and installs one coordinated candidate after its commit provider confirms the change.
status: stable
tags: [core, engine, staging, overlay, snapshots]
sources:
  - resource: ../../../packages/core/src/internal/engine.ts
    title: Persistent state, directory slots and coordinated installation
  - resource: ../../../packages/core/src/internal/tree.ts
    title: Snapshot and live-image codecs
  - resource: ../../../packages/core/src/internal/snapshotDelta.ts
    title: Delta computation and verification
  - resource: ../../../packages/core/test/Engine.test.ts
    title: Persistent inode state and payload-free metadata replacement
  - resource: ../../../packages/core/test/behaviour/directoryOrder.test.ts
    title: Compaction order and captured-state isolation
generated: { by: codex/okf, at: "2026-10-21T17:50:27+00:00" }
---

# Persistent volume state

The volume owns one immutable state value. Inodes live in Effect `HashMap<Ino, Node>`, keyed by inode number. Directories carry their parent, name, and entries; files and symbolic links carry the names that reach them. Persistent directory entries avoid copying a wide directory on every live namespace edit.

## Collection ownership

Reuse Effect HashMap for inodes and directory slots instead of maintaining a generic integer trie. The project accepts the measured CPU and retained-heap costs to reduce collection maintenance. This decision does not establish performance parity or justify a new Effect collection. The [collection comparison](../../evidence/collection-reuse.md "evidenced by") records the accepted costs and qualification limits.

`setNode` applies `Equal.byReferenceUnsafe` to each filesystem-owned Node before storage. HashMap replacement can otherwise structurally compare records and hash unchanged file bytes or directory contents. Marking keeps that comparison by identity without proxy allocation. A spread creates an unmarked record, so every new record passes through this write boundary, including imported, rebuilt and quiet-atime records.

The marking changes equality and hashing for the private record's lifetime. It must not mark caller-owned metadata, shared byte arrays or link arrays. Buffer ownership and immutability remain separate requirements. Public object identity uses volume and inode identifiers, not the private record reference.

Translate pending deletion into `HashMap.remove`; storing `undefined` would retain a present entry. A private transient batch applies pending writes at the existing synchronous finish boundary. Publish only finalized successful state. Failed or cancelled work must leave the base unchanged, and intermediate mutable wrappers must not escape. Delta application and state reconstruction obey the same ownership policy.

Inode allocation remains monotonic and independent of map size. Valid inode numbers run from 1 through `Number.MAX_SAFE_INTEGER - 1`; `Number.MAX_SAFE_INTEGER` is the exhaustion sentinel. Hash collisions do not make distinct inode keys equivalent. An unlinked inode remains available while a handle holds it open.

## Explicit directory order

Directory name lookup and numeric slots use two HashMaps sharing one `{ name, ino, index }` entry. Overwriting preserves position. Removal deletes both entries and leaves a logical slot hole; reinsertion appends. Rebuild when `length > size * 2`, preserving surviving order. Restored native maps convert on their first namespace edit.

Live listings retain insertion order. Snapshot restore, overlays and live-image reopen canonicalize byte-name order. HashMap iteration must not define either policy, and map equality alone cannot prove ordering.

Full `readDirectory` observations populate a temporary array by explicit slot index and remove holes. Lazy snapshot and search consumers keep incremental traversal. Logical lengths beyond JavaScript array-index capacity use the incremental fallback. No cached sorted view is retained.

Single-map sorting reduces secondary storage but pays for sorting each newly listed version. Cached sorting retains arrays for listed historical versions and still sorts after edits. Chunk token logs need generation checks and compaction to preserve reinsertion. These alternatives were explored but did not justify replacing explicit slots for the balanced build and long-lived workloads. Proxy-wrapped inode identity avoids structural comparison but adds a wrapper; direct marking is restricted to private owned records instead.

## Coordinated changes

A transition admits the operation, resolves its target, checks authority, and builds a private candidate. The commit provider confirms that candidate before the engine installs it. Memory confirms locally. A durable provider encodes the candidate and submits it to the image store. Rejection discards the candidate; an uncertain commit stops access to the volume. Observations share permits, while changes take all permits.

Path and reference targets use the same operation bodies. The token registry holds capability validity outside the immutable tree. It must remain private because an editable inode identifier cannot establish authority. Handle cleanup and watch publication retain the rules in [resources and authority](../../contracts/resources-and-authority.md "preserves") and [mutation and observation](../../contracts/mutation-and-observation.md "preserves").

## Snapshots and overlays

Capture retains the immutable volume value without copying payloads. An overlay starts from that value and shares unchanged content while owning its namespace, metadata, coordination, and resource lifetimes. Candidate, snapshot, and overlay state use the same representation. See [overlay content sharing](../overlay/overlay-content-sharing.md "implements") and [snapshots and fixtures](../../contracts/snapshots-and-fixtures.md "implements").

The private tree schema defines snapshot and live-image codecs. Bounded newline-delimited decoding checks each line and then the relationships across nodes. A delta records changed paths and verifies its target identity over the reconstructed value. [Snapshot deltas](../../contracts/snapshot-deltas.md "implements") own the public reconstruction and budget rules.

## Limits

Live commits still encode whole images. Incremental storage commits remain deferred. Decoder memory includes the constructed value and a bounded line; streaming does not imply one-record total memory. Logical quotas do not bound all temporary allocations or retained snapshots. These limits follow [capacity and limits](../../contracts/capacity-and-limits.md "constrained by").

The [public API decision](public-api-targets-services-and-errors.md "refined by") owns target, service, and error shapes. [Package boundaries](../package-boundaries.md "constrained by") keep host storage and adapters outside core.
