---
type: Decision
title: Schema data and capability interfaces
description: Uses Schema-derived data models and tagged errors while keeping live resources as capability interfaces.
status: stable
tags: [api, schema, modeling]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Schema data and capability interfaces

Reusable identities, configuration, metadata, fixtures, and snapshot image records are modeled with Schema and derive their TypeScript types. Filesystem, configuration, and image errors use `Data.TaggedError` while they have no serialization requirement.

Volume, Caller, FileHandle, and DirectoryHandle remain capability interfaces. BytePath and Snapshot are opaque controlled values; a decoded image tree is not itself a Snapshot. Schema validation does not imply deep immutability or serialize live resources.

The resulting ownership model is described by the [volume, caller, and handle architecture](/architecture/volume-caller-handle-model.md "implemented by").
