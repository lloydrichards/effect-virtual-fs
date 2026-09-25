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
generated: { by: claude/okf, at: "2026-09-25T22:30:00+02:00" }
---

# Schema data and capability interfaces

Reusable identities, configuration, metadata, fixtures, and snapshot image records are modeled with Schema and derive their TypeScript types. Every failure is one `VfsError`, a `Schema.TaggedError` with a code union, so an error can cross a wire; the [public API decision](public-api-targets-services-and-errors.md "refined by") replaced the earlier `Data.TaggedError` classes once remote access gave errors a serialization requirement.

Volume, Caller, FileHandle, and DirectoryHandle remain capability interfaces. BytePath, Snapshot, and SnapshotDelta are opaque controlled values with Effect-style string TypeIds and private authenticity registries; a decoded image tree is not itself a Snapshot. Schema validation does not imply deep immutability or serialize live resources.

The resulting ownership model is described by the [volume, caller, and handle architecture](../../architecture/volume-caller-handle-model.md "implemented by").
