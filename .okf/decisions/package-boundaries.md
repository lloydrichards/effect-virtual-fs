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
  - id: tracing-lint
    resource: ../../oxlint.config.ts
    title: Scope of the package tracing lint rule
generated: { by: codex/okf, at: "2026-11-17T20:15:00+00:00" }
---

# Package boundaries

`@effect-vfs/core` owns the standalone virtual filesystem: volumes, callers, handles, errors, limits, fixtures, and snapshots. It may depend on Effect for execution and resource management, but not on `@effect-vfs/memory`.

`@effect-vfs/memory` is the compatibility adapter for Effect's existing `FileSystem` interface and adapts core without changing that public contract. `@effect-vfs/node` implements the [direct Node provider](../contracts/node-provider.md "implemented by") over an existing synchronous core volume, with native types and independent handle semantics. Mounted qualification remains separate. Other future bindings depend on core and receive concrete package names only when they exist. Core is published only after its compatibility claims have executable evidence.

The memory package also owns `FileSystemTesting`, a decorator over any Effect filesystem. Its [fault and spy contract](../contracts/filesystem-testing.md "constrains") defines public-call interception and state allocated per build. This utility stays outside the core state engine. Local package placement does not settle ownership in a future upstream Effect port.

Packages leave tracing boundaries to their consuming applications. Reusable Effect operations use `Effect.fnUntraced`; package implementations do not add spans with named `Effect.fn`, `Effect.withSpan`, or `Stream.withSpan`. Applications can wrap the operations they want to trace.

The `anti-slop-effect/no-package-spans` rule checks handwritten library source using the workspace policy registry. It follows Effect and Stream imports through constant aliases. For `Effect.fn`, it reports calls whose first argument is recognizable as a string from source syntax. The rule does not infer arbitrary computed names or follow wrappers across modules. Runtime tracing tests still cover the application boundary.
