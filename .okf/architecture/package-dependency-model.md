---
type: Architecture
title: Package dependency model
description: Defines the one-way dependency flow from adapters and persistence into the core while keeping applications as external consumers.
status: stable
tags: [architecture, packages, dependencies]
sources:
  - id: preview-package
    resource: ../../packages/effect-preview/package.json
    title: Private preview package manifest
  - id: node-package
    resource: ../../packages/node/package.json
    title: Node package manifest
  - id: core-package
    resource: ../../packages/core/package.json
    title: Core package manifest
  - id: memory-package
    resource: ../../packages/memory/package.json
    title: Memory package manifest
  - id: persistence-package
    resource: ../../packages/persistence/package.json
    title: Persistence package manifest
  - id: nfs-package
    resource: ../../packages/nfs/package.json
    title: NFS package manifest
generated: { by: codex/okf, at: 2026-11-16T21:12:32+00:00 }
---

# Package dependency model

The dependency direction is:

```text
applications and build integrations
├── @effect-vfs/memory ──────┐
├── @effect-vfs/persistence ─┼──> @effect-vfs/core ──> effect
├── @effect-vfs/nfs ─────────┤
├── @effect-vfs/node ────────┤
└── @effect-vfs/core ────────┘
```

Core depends on the private `@effect-vfs/effect-preview` engine and Effect. Core is the runtime-neutral behavioral authority. Memory depends on core and exposes an Effect `FileSystem` adapter; persistence depends on core and owns checkpoint storage I/O; nfs depends on core and serves one volume to NFSv4.1 clients over an application-provided `SocketServer`. Node depends on core and exposes a synchronous-memory-backed Node VirtualProvider. Memory, Node, persistence, and nfs do not depend on one another. Applications provide platform layers such as the SQLite client or the socket server and decide how packages are composed.

Core must remain usable without either adapter and without host filesystem access. This direction is [established by the package boundary decision](../decisions/package-boundaries.md "implements") and extended by [named checkpoint persistence](../decisions/named-checkpoint-persistence.md "implements") and the [NFS profile ladder](../decisions/nfs/nfs-profile-ladder.md "implements"). See [system boundaries](system-boundaries.md "refined by") for responsibility ownership.

See the [package feature map](package-feature-map.md "refined by") for capability flows and adapter requirements.
