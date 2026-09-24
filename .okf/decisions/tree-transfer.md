---
type: Decision
title: Tree transfer
description: Moves directory trees as Effect streams of fixture entries owned by the memory package, with bounded sources, rejecting sinks, and atomic new volumes.
status: stable
tags: [memory, transfer, interop, streams]
sources:
  - id: design-issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/29
    title: Import and export directory trees design issue
  - id: decision-summary
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/29#issuecomment-5809022897
    title: Decision summary posted on the design issue
  - id: public-api
    resource: ../../packages/memory/src/TreeTransfer.ts
    title: Public tree transfer API
  - id: behavior-tests
    resource: ../../packages/memory/test/TreeTransfer.test.ts
    title: Tree transfer behavior tests
generated: { by: claude/okf, at: "2026-09-24T09:10:00Z" }
---

# Tree transfer

A tree transfer is an Effect `Stream` of core fixture entries, rooted at the transfer root, run into a `Sink`. Users pass capabilities they already hold. There is no separate port interface for adapters to implement. The existing fixture entry type already carries byte paths, nanosecond timestamps, owners, symbolic-link target bytes, and hard links, so it is the only interchange type. Filtering, merging several roots, and progress use Effect's own `Stream` operators rather than transfer options. The [tree transfer contract](../contracts/tree-transfer.md "specifies") owns the exact rules.

`@effect-vfs/memory` owns the module beside its existing traversal code and Effect `FileSystem` bridge. Core stays free of host filesystem services, as the [package boundaries](package-boundaries.md "preserves") require. The memory adapter's `FileSystem.copy` runs on the same engine, using the volume's own limits and no depth bound, so its public signature does not change.

## Sources

A `Caller` cannot take a snapshot, and reading file contents updates access time. `fromCaller` therefore reads live, while `fromSnapshot` gives a point-in-time read that never changes the source. A snapshot-only source was rejected because it would encode the whole volume for every subtree copy.

Sources always enforce limits. A supplied policy must be complete, and omission uses a finite default preset, matching the [portable snapshot delta](overlay/portable-snapshot-deltas.md "follows") precedent. Requiring limits on every call was rejected as noisier without adding safety, since the default is always finite. The five fields use `VolumeOptions` names. Separate link-table and symbolic-link bounds fold into `maxEntries`.

## Sinks

The default rejects an existing destination, following Go and Deno rather than Node's overwriting default. The only alternative is `overwrite`, which merges and replaces. A no-overwrite merge had no consumer. A live sink claims its root with an exclusive create and removes it on failure instead of staging into a sibling directory and renaming. A rename can silently replace an empty directory, staging needs temporary-name rules, and staged writes still reach watchers. All-or-nothing visibility belongs to `toVolume`, which inherits fixture validation.

Mode and modification time are applied by default. Setuid, setgid, and sticky bits and the access time are opt-in, and owner preservation is deferred. Symbolic links are always reproduced verbatim, and hard links are always preserved. Following links, escape checks, skip policies, and the host adapter are deferred to the host adapter milestone.

## Consequences

Rejected alternatives recorded on the design issue include public source and sink ports, an Effect `FileSystem`-only engine, fixed `copy` and `toVolume` functions with endpoint objects, staging with rename, required limits, and per-entry reports of properties a destination could not preserve.
