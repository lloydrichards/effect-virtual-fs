---
type: Architecture
title: Volume, caller, and handle model
description: Assigns live filesystem state to the Effect preview while core preserves existing capability contracts and immutable snapshot formats.
status: stable
tags: [architecture, state, authority, resources]
sources:
  - resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Existing public core capabilities
  - resource: ../../packages/core/src/internal/model.ts
    title: Core schemas, errors, paths, and immutable snapshot representation
  - resource: ../../packages/core/src/internal/runtime.ts
    title: Core adaptation to the sole preview runtime
  - resource: ../../packages/core/src/internal/synchronous.ts
    title: Native adaptation to the same preview owner
  - resource: ../../packages/core/src/internal/durableStorage.ts
    title: Durable mutation publication
  - resource: ../../packages/core/src/internal/volumeWatch.ts
    title: Volume and confined watch delivery
  - resource: ../../packages/core/compatibility/preview-imports/check.mjs
    title: Sole-preview source import qualification
  - resource: ../../packages/core/test/SynchronousAdapter.test.ts
    title: Shared file contents and scope cleanup through the synchronous binding
  - resource: ../../packages/core/test/Volume.test.ts
    title: Execution checks through the existing constructors
  - resource: ../../packages/effect-preview/src/virtual-file-system/VirtualFileSystem.ts
    title: Preview owner, caller, operation, and handle contracts
generated: { by: codex/okf, at: "2026-11-16T10:22:00+01:00" }
---

# Volume, caller, and handle model

Core constructs volumes and authorizes callers through the private Effect preview. The preview owns the namespace, file bytes, object identities, permissions and open handles. The memory adapter binds a core caller to Effect's FileSystem. The Node provider binds synchronous operations to the same owner.

Core translates committed mutations into volume and caller-confined watch events. Snapshot and live-image codecs use core's immutable inode records. Sibling overlays can share captured file bytes until a write. LiveVolume offers a candidate image to storage before publishing a mutation. An unknown commit outcome freezes the session until the application reopens the stored image.

The public [confined caller contract](../contracts/confined-callers.md "constrained by") and [memory adapter contract](../contracts/memory-adapter-compatibility.md "constrained by") describe the caller-facing behavior.
