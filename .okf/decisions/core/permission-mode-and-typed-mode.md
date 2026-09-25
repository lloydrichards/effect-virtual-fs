---
type: Decision
title: Permission mode and typed mode
description: Keeps Metadata.mode as permission bits only and derives the POSIX st_mode from the kind through Metadata.typedMode and exported S_IF constants.
status: stable
tags: [metadata, permissions, posix]
sources:
  - id: metadata
    resource: ../../../packages/core/src/Metadata.ts
    title: Mode schema, S_IF constants, and typedMode
  - id: adapter
    resource: ../../../packages/memory/src/internal/adapterSupport.ts
    title: Memory stat info built through typedMode
  - id: tests
    resource: ../../../packages/core/test/Metadata.test.ts
    title: typedMode for each kind
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/208
    title: File-type bits in Metadata.mode
generated: { by: claude-code, at: "2026-09-26T10:05:00+02:00" }
---

# Permission mode and typed mode

Amends the [public API decision](public-api-targets-services-and-errors.md "amends"), which had declined file-type bits for 0.6.0. The decisions were grilled against the code on 2026-09-25 and recorded on [issue #208](https://github.com/lloydrichards/effect-virtual-fs/issues/208 "decided on").

## Context

`Metadata` carries `kind` and a `mode` capped at `0o7777`. Source across core, memory and NFS masks or compares mode bits, and only the memory adapter's `stat` info composed the `S_IF*` type bits. Folding the type bits into `mode` would change every exact-mode test assertion across core, NFS and persistence, and the snapshot, live image and delta hash, which all store it as permissions. NFS takes the type from `kind` and writes `mode` as `mode4`, which RFC 8881 limits to the 12 permission and special bits.

## Decisions

1. **`Metadata.mode` stays permission bits**, capped at `0o7777`. The kind has one source, so the two cannot disagree. No breaking change.
2. **Core derives the typed mode.** `Metadata` exports `S_IFMT`, `S_IFREG`, `S_IFDIR` and `S_IFLNK`, and `typedMode(metadata)` returns the POSIX `st_mode`: the kind's type bits joined with `mode`. The memory adapter uses it instead of composing the bits by hand.
3. **`chmod` input stays per layer.** Core rejects any mode above `0o7777` with `InvalidArgument`; a typed API does not guess. The memory adapter keeps masking with `0o7777`, because Effect `FileSystem` and Node callers pass stat-style modes and Node ignores the type bits.
4. **`dev` and `rdev` are 0 by contract.** A volume has no device nodes and its kind set excludes them, so `(dev, ino)` identifies an object only within one volume. Cross-volume identity is left to the object reference key.
5. **The persistent tree schema stores permission bits only**, with the kind as the node tag. Snapshot v1 and the live image need no migration.

## Consequences

The [permissions and metadata contract](../../contracts/permissions-and-metadata.md "constrains") states the mode, chmod and device rules. NFS keeps deriving `type` from `kind` and writing `mode` raw.
