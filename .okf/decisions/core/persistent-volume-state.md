---
type: Decision
title: Persistent volume state
description: Keeps volume state immutable and installs one coordinated candidate after its commit provider confirms the change.
status: stable
tags: [core, engine, staging, overlay, snapshots]
sources:
  - resource: ../../../packages/core/src/internal/volumeState.ts
    title: Immutable volume state and node relationships
  - resource: ../../../packages/core/src/internal/inodeTable.ts
    title: Persistent inode table
  - resource: ../../../packages/core/src/internal/directoryEntries.ts
    title: Persistent directory entries
  - resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Coordinated transitions and commit providers
  - resource: ../../../packages/core/src/internal/tree.ts
    title: Snapshot and live-image codecs
  - resource: ../../../packages/core/src/internal/snapshotDelta.ts
    title: Delta computation and verification
generated: { by: codex/okf, at: 2026-10-05T00:00:00Z }
---

# Persistent volume state

The volume owns one immutable state value. Inodes live in a persistent table keyed by inode number. Directories carry their parent, name, and entries; files and symbolic links carry the names that reach them. Persistent directory entries avoid copying a wide directory on every live namespace edit.

## Coordinated changes

A transition admits the operation, resolves its target, checks authority, and builds a private candidate. The commit provider confirms that candidate before the engine installs it. Memory confirms locally. A durable provider encodes the candidate and submits it to the image store. Rejection discards the candidate; an uncertain commit stops access to the volume. Observations share permits, while changes take all permits.

Path and reference targets use the same operation bodies. The token registry holds capability validity outside the immutable tree. It must remain private because an editable inode identifier cannot establish authority. Handle cleanup and watch publication retain the rules in [resources and authority](../../contracts/resources-and-authority.md "preserves") and [mutation and observation](../../contracts/mutation-and-observation.md "preserves").

## Snapshots and overlays

Capture retains the immutable volume value without copying payloads. An overlay starts from that value and shares unchanged content while owning its namespace, metadata, coordination, and resource lifetimes. Candidate, snapshot, and overlay state use the same representation. See [overlay content sharing](../overlay/overlay-content-sharing.md "implements") and [snapshots and fixtures](../../contracts/snapshots-and-fixtures.md "implements").

The private tree schema defines snapshot and live-image codecs. Bounded newline-delimited decoding checks each line and then the relationships across nodes. A delta records changed paths and verifies its target identity over the reconstructed value. [Snapshot deltas](../../contracts/snapshot-deltas.md "implements") own the public reconstruction and budget rules.

## Limits

Live commits still encode whole images. Incremental storage commits remain deferred. Decoder memory includes the constructed value and a bounded line; streaming does not imply one-record total memory. Logical quotas do not bound all temporary allocations or retained snapshots. These limits follow [capacity and limits](../../contracts/capacity-and-limits.md "constrained by").

The [public API decision](public-api-targets-services-and-errors.md "refined by") owns target, service, and error shapes. [Package boundaries](../package-boundaries.md "constrained by") keep host storage and adapters outside core.
