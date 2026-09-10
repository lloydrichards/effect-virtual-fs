---
type: Decision
title: Package boundaries
description: Separates the standalone core, Effect FileSystem compatibility adapter, and future bindings.
status: stable
tags: [architecture, packages]
generated: { by: codex/okf, at: "2026-09-10T00:00:00Z" }
---

# Package boundaries

`@effect-vfs/core` owns the standalone virtual filesystem: volumes, callers, handles, errors, limits, fixtures, and snapshots. It may depend on Effect for execution and resource management, but not on `@effect-vfs/memory`.

`@effect-vfs/memory` is the compatibility adapter for Effect's existing `FileSystem` interface and adapts core without changing that public contract. Future bindings depend on core and receive concrete package names only when they exist. Core is published only after its compatibility claims have executable evidence.
