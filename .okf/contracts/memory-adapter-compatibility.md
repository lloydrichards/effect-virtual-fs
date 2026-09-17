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
  - id: adapter-tests
    resource: ../../packages/memory/test/MemoryFileSystem.test.ts
    title: Adapter behavior tests
  - id: overlay-binding
    resource: ../../packages/memory/test/OverlayBinding.test.ts
    title: Overlay volume binding tests
generated: { by: codex/okf, at: 2026-09-13T14:53:40Z }
---

# Memory adapter compatibility

`@effect-vfs/memory` exposes Effect's path-based `FileSystem` service while `@effect-vfs/core` owns filesystem behavior. A fresh adapter creates a volume containing `/tmp`; `bind` attaches to an existing volume without modifying it.

Bindings share namespace and contents while retaining independent callers, descriptor tables, file cursors, and lifetimes. The adapter preserves Effect cursor and convenience behavior where it intentionally differs from the POSIX-oriented core, and maps expected core failures to `PlatformError`.

The adapter follows Effect's byte and cursor types at its public boundary. File metadata exposes exact `ByteSize.ByteSize` values, reads and writes return byte counts as numbers, and seeks accept and return bigint positions.
Seeks before the start fail with `BadArgument` without changing the cursor, and
`readAlloc` rejects missing, coerced, negative, and non-integer runtime sizes.

The shared adapter suite in `packages/memory/test/FileSystemTest.ts` states this contract as executable assertions, and it runs against the memory adapter alone. Its requirements are unconditional: a handle used after its scope closes reports `BadResource` against the descriptor it held; `copy` with `overwrite: false` onto an existing destination fails `AlreadyExists` without changing either path; `utimes` reports its failing method as `utimes`; `copy` with `preserveTimestamps` carries both the access and the modification time; `chmod` and `chown` apply the requested mode and ownership without host privileges; derived stream and sink handles finalize on success, failure, and interruption; and a watcher stops receiving events once it is released.

Effect's Node platform adapter diverges from four of those requirements, which is why the suite is not run against it: `copy` with `overwrite: false` skips an existing destination silently instead of failing, `utimes` reports its method as `utime`, `preserveTimestamps` carries only the modification time, and a closed handle surfaces `EBADF` as `Unknown` rather than `BadResource`. Ownership changes there also need host privileges. These are upstream behaviors, not adapter obligations; the suite must not be weakened to accommodate them.

This contract [depends on](resources-and-authority.md "depends on") core capabilities, [implements package boundaries](/decisions/package-boundaries.md "implements"), and is [grounded in the Effect compatibility research](/research/effect-compatibility.md "grounded in").
