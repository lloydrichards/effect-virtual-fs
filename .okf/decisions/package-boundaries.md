---
type: Decision
title: Package boundaries
description: Separates the standalone core, Effect FileSystem compatibility adapter, and future bindings.
status: stable
tags: [architecture, packages]
sources:
  - id: workspace
    resource: ../../package.json
    title: Workspace package list
  - resource: ../../packages/memory/src/FileSystemTesting.ts
    title: Generic Effect filesystem testing decorator
  - resource: ../../packages/core/src/internal/virtualFileSystem.ts
    title: Untraced volume, caller, and handle operations
  - resource: ../../packages/persistence/src/CheckpointStore.ts
    title: Untraced checkpoint operations
generated: { by: codex/okf, at: "2026-10-04T18:03:35+00:00" }
---

# Package boundaries

`@effect-vfs/core` owns the standalone virtual filesystem: volumes, callers, handles, errors, limits, fixtures, and snapshots. It may depend on Effect for execution and resource management, but not on `@effect-vfs/memory`.

`@effect-vfs/memory` is the compatibility adapter for Effect's existing `FileSystem` interface and adapts core without changing that public contract. Future bindings depend on core and receive concrete package names only when they exist. Core is published only after its compatibility claims have executable evidence.

The memory package also owns `FileSystemTesting`, a decorator over any Effect filesystem. Its [fault and spy contract](../contracts/filesystem-testing.md "constrains") defines public-call interception and state allocated per build. This utility stays outside the core state engine. Local package placement does not settle ownership in a future upstream Effect port.

Packages leave tracing boundaries to their consuming applications. Reusable Effect operations use `Effect.fnUntraced`; package implementations do not add spans with named `Effect.fn`, `Effect.withSpan`, or `Stream.withSpan`. Applications can wrap the operations they want to trace.
