---
type: Architecture
title: System boundaries
description: Separates the runtime-neutral filesystem core from Effect adaptation, checkpoint storage, build consumers, and Node and NFS integrations.
status: stable
tags: [architecture, boundaries, core]
sources:
  - id: core-source
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Core public implementation
  - resource: ../../packages/effect-preview/README.md
    title: Preview engine ownership
  - resource: ../../packages/persistence/src/index.ts
    title: Checkpoint and live-image store exports
  - id: nfs-source
    resource: ../../packages/nfs/src/NfsServer.ts
    title: NFS server public configuration
  - id: agent-tools-example
    resource: ../../apps/demo-agent-tools/README.md
    title: Independent caller-bound MCP example
generated: { by: codex/okf-dream, at: 2026-11-16T22:02:33Z }
---

# System boundaries

`@effect-vfs/core` owns filesystem semantics and public capabilities. It uses Effect for execution, typed failure, clocks, streams, and scopes, but does not depend on the memory adapter, persistence package, or host filesystem services.

The private Effect preview owns the live namespace, file bytes, identities, permissions, and open handles. Core supplies the public volume and caller APIs, snapshots, overlays, watch delivery, and durable publication. The memory adapter and the [Node provider](../contracts/node-provider.md "implemented by") reach the same engine through core. The [volume, caller, and handle model](volume-caller-handle-model.md "refined by") describes how these layers share state.

`@effect-vfs/memory` adapts a core volume to Effect's `FileSystem` service. It preserves that service's string API, cursor behavior, helper operations, and `PlatformError` contract without moving those compatibility rules into core.

`@effect-vfs/persistence` stores application-requested named checkpoints in SQLite. Its SQLite and R2 live-image stores serve a different purpose: core asks the selected store to commit a candidate image before publishing the live mutation. Storage I/O belongs to the provider. The [package feature map](package-feature-map.md "refined by") identifies each store’s durability qualification.

`@effect-vfs/nfs` exposes one live volume to native NFSv4.1 clients through an application-provided socket server. RPC, sessions, filehandles, protocol authentication, and resource limits belong to that package; it reaches the volume only through callers and object references and adds no rules to core.

The virtual-build, overlay-demo, and nfs-preview applications are external consumers of public package exports. They demonstrate that a build integration, an overlay workflow, and a native mount can consume a volume without making their behavior part of the filesystem core.

The independent `demo-agent-tools` application binds an Effect AI toolkit to an identity-rooted project subtree on a dedicated overlay and serves it over stdio MCP. Volume-level orchestration data remains outside that caller view. Its text and listing limits, display errors, and client workflow belong to the example. A separate base reader demonstrates isolation. It adds no AI or transport dependencies to core.

Its separate [Code Mode example](codemode-example.md "refined by") gives each OpenCode execution a fresh rooted overlay and retains captured results for inspection. Interpreter policy, execution limits, and artifact retention belong to the application. It adds no runtime dependency to core.

Multiple consumers may share one live volume. Snapshot restoration instead creates an independent volume; it does not replace live state or preserve runtime resources.

These boundaries are [constrained by the package decisions](../decisions/package-boundaries.md "constrained by") and elaborated by the [package dependency model](package-dependency-model.md "refined by") and [volume, caller, and handle model](volume-caller-handle-model.md "refined by"). The supported result is summarized by the [implemented filesystem profile](../profiles/implemented-filesystem.md "implements"). The [NFS profile ladder](../decisions/nfs/nfs-profile-ladder.md "refined by") distinguishes the local read-only preview from the experimental networked read-only and guarded writable profiles. Unattended writable restart recovery remains a [deferred capability](../profiles/deferred-capabilities.md "excludes").
