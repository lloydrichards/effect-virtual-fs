---
type: Architecture
title: System boundaries
description: Separates the runtime-neutral filesystem core from Effect adaptation, checkpoint storage, build consumers, and future host or network integrations.
status: stable
tags: [architecture, boundaries, core]
sources:
  - id: core-source
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Core public implementation
generated: { by: codex/okf, at: 2026-09-10T00:00:00+00:00 }
---

# System boundaries

`@effect-vfs/core` owns filesystem semantics and public capabilities. It uses Effect for execution, typed failure, clocks, streams, and scopes, but does not depend on the memory adapter, persistence package, or host filesystem services.

`@effect-vfs/memory` adapts a core volume to Effect's `FileSystem` service. It preserves that service's string API, cursor behavior, helper operations, and `PlatformError` contract without moving those compatibility rules into core.

`@effect-vfs/persistence` stores named encoded snapshots using an application-provided SQLite client. Storage I/O and migrations belong to that package; core only owns snapshot capture, encoding, decoding, and restoration.

The virtual-build application is an external consumer of public package exports. It demonstrates that a build integration can consume a volume without making build-tool behavior part of the filesystem core.

Multiple consumers may share one live volume. Snapshot restoration instead creates an independent volume; it does not replace live state or preserve runtime resources.

These boundaries are [constrained by the package decisions](/decisions/package-boundaries.md "constrained by") and elaborated by the [package dependency model](package-dependency-model.md "refined by") and [volume, caller, and handle model](volume-caller-handle-model.md "refined by"). The supported result is summarized by the [implemented filesystem profile](/profiles/implemented-filesystem.md "implements"). Host, mount, network, and storage optimizations remain [deferred capabilities](/profiles/deferred-capabilities.md "excludes").
