---
type: Contract
title: Memory adapter compatibility
description: Preserves Effect FileSystem behavior while adapting shared core volumes through independent bindings.
status: stable
tags: [effect, adapter, compatibility]
sources:
  - resource: ../../packages/memory/src/MemoryFileSystem.ts
    title: Public memory adapter API
  - resource: ../../packages/memory/src/internal/memoryFileSystem.ts
    title: Core-to-Effect adapter implementation
  - resource: ../../packages/memory/test/AdapterCompatibility.test.ts
    title: Effect compatibility tests
  - resource: ../../packages/memory/test/CoreBinding.test.ts
    title: Shared core binding tests
generated: { by: codex/okf, at: 2026-09-12T10:45:54Z }
---

# Memory adapter compatibility

`@effect-vfs/memory` exposes Effect's path-based `FileSystem` service while `@effect-vfs/core` owns filesystem behavior. A fresh adapter creates a volume containing `/tmp`; `bind` attaches to an existing volume without modifying it.

Bindings share namespace and contents while retaining independent callers, descriptor tables, file cursors, and lifetimes. The adapter preserves Effect cursor and convenience behavior where it intentionally differs from the POSIX-oriented core, and maps expected core failures to `PlatformError`.

The adapter follows Effect's byte and cursor types at its public boundary. File metadata exposes exact `ByteSize.ByteSize` values, reads and writes return byte counts as numbers, and seeks accept and return bigint positions.

This contract [depends on](/contracts/resources-and-authority.md "depends on") core capabilities, [implements package boundaries](/decisions/package-boundaries.md "implements"), and is [grounded in the Effect compatibility research](/research/effect-compatibility.md "grounded in").
