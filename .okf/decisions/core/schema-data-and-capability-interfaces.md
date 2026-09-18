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
generated: { by: codex/okf, at: "2026-09-13T18:05:00+02:00" }
---

# Schema data and capability interfaces

Reusable identities, configuration, metadata, fixtures, and snapshot image records are modeled with Schema and derive their TypeScript types. Filesystem, configuration, and image errors use `Data.TaggedError` while they have no serialization requirement.

Volume, Caller, FileHandle, and DirectoryHandle remain capability interfaces. BytePath, Snapshot, and SnapshotDelta are opaque controlled values with Effect-style string TypeIds and private authenticity registries; a decoded image tree is not itself a Snapshot. Schema validation does not imply deep immutability or serialize live resources.

The resulting ownership model is described by the [volume, caller, and handle architecture](../../architecture/volume-caller-handle-model.md "implemented by").
