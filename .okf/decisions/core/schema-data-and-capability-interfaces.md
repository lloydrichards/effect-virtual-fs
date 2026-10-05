---
type: Decision
title: Schema data and capability interfaces
description: Uses Schema-derived data models and tagged errors while keeping live resources as capability interfaces.
status: stable
tags: [api, schema, modeling]
sources:
  - id: core
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Schema data types and capability interfaces
  - resource: ../../../packages/core/src/Search.ts
    title: Dual snapshot search operations
  - resource: ../../../packages/memory/src/TreeTransfer.ts
    title: Dual stream-to-volume construction
  - resource: ../../../packages/memory/src/FileSystemTesting.ts
    title: Dual filesystem decoration
generated: { by: codex/okf, at: "2026-10-05T13:17:21+00:00" }
---

# Schema data and capability interfaces

Reusable identities, configuration, metadata, fixtures, and snapshot image records are modeled with Schema and derive their TypeScript types. Every failure is one `VfsError`, a `Schema.TaggedError` with a code union, so an error can cross a wire; the [public API decision](public-api-targets-services-and-errors.md "refined by") replaced the earlier `Data.TaggedError` classes once remote access gave errors a serialization requirement.

Volume, Caller, FileHandle, and DirectoryHandle remain capability interfaces. BytePath, Snapshot, and SnapshotDelta are opaque controlled values with Effect-style string TypeIds and private authenticity registries; a decoded image tree is not itself a Snapshot. Schema validation does not imply deep immutability or serialize live resources.

The resulting ownership model is described by the [volume, caller, and handle architecture](../../architecture/volume-caller-handle-model.md "implemented by").

Selected standalone functions accept both data-first and data-last calls through Effect's `dual`. These are the eight `Search` operations, `BytePath.join`, `VirtualFileSystem.snapshotEntries`, `encodeSnapshot`, `encodeSnapshotStream`, `decodeSnapshot`, `Testing.collectChanges`, `TreeTransfer.toVolume`, and `FileSystemTesting.make`. The curried form captures configuration and receives the same first data argument as the direct form. Effect-returning functions compose with `Effect.flatMap` over their resolved input.

Fixed required parameters use arity dispatch. Snapshot encoding and stream-to-volume construction use predicates to distinguish their data argument from optional configuration. A curried decorator still runs its factory once per execution. Capability methods remain bound to their caller or handle; the dual functions do not change resource ownership, failure types, or tracing boundaries.
