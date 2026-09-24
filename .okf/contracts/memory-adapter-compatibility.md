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
  - resource: ../../packages/memory/src/internal/fileHandle.ts
    title: Effect file handle and cursor implementation
  - resource: ../../packages/memory/src/internal/treeOperations.ts
    title: Scoped traversal and recursive directory operations
  - resource: ../../packages/memory/src/internal/copyOperations.ts
    title: Adapter copy operations
  - resource: ../../packages/memory/src/internal/treeTransfer.ts
    title: Tree transfer engine used by copy
  - resource: ../../packages/memory/src/internal/platformError.ts
    title: Core-to-Effect error translation
  - resource: ../../packages/memory/test/AdapterCompatibility.test.ts
    title: Effect compatibility tests
  - resource: ../../packages/memory/test/CoreBinding.test.ts
    title: Shared core binding tests
  - id: adapter-tests
    resource: ../../packages/memory/test/MemoryFileSystem.test.ts
    title: Adapter behavior tests
  - resource: ../../packages/memory/test/ErrorMapping.test.ts
    title: Error mapping regressions
  - id: overlay-binding
    resource: ../../packages/memory/test/OverlayBinding.test.ts
    title: Overlay volume binding tests
generated: { by: codex/okf, at: 2026-09-20T16:11:30Z }
---

# Memory adapter compatibility

`@effect-vfs/memory` exposes Effect's path-based `FileSystem` service while `@effect-vfs/core` owns filesystem behavior. A fresh adapter creates a volume containing `/tmp`; `bind` attaches to an existing volume without modifying it.
The binding composes file handles, recursive traversal, and copy operations from separate internal modules; core retains namespace, content, and watch ownership.

Bindings share namespace and contents while retaining independent callers, descriptor tables, file cursors, and lifetimes. The adapter preserves Effect cursor and convenience behavior where it intentionally differs from the POSIX-oriented core, and maps expected core failures to `PlatformError`.
It translates `FsError` only when an operation crosses into Effect's `FileSystem` service. The translation preserves the core error as the cause and records the public method and path or descriptor. It maps volume admission pressure to `Busy`; failures without a matching Effect system-error tag, including capacity rejection, use `Unknown` with the core code in the description.

The adapter follows Effect's byte and cursor types at its public boundary. File metadata exposes exact `ByteSize.ByteSize` values, reads and writes return byte counts as numbers, and seeks accept and return bigint positions.
Seeks before the start fail with `BadArgument` without changing the cursor, and
`readAlloc` rejects missing, coerced, negative, and non-integer runtime sizes.

Directory copy rejects a destination child that is a symbolic link instead of following it as a directory. It also rejects copying `/` into one of its descendants before creating the destination. `copy` runs on the [tree transfer](tree-transfer.md "uses") engine with the volume's own limits and no depth bound; `overwrite` maps to `existing: "overwrite"`, `preserveTimestamps` to both timestamps, and source modes are copied with their special bits. A copy without `overwrite` claims its destination and removes it if the copy fails. An overwriting copy remains a sequence of core operations, so failures after earlier entries are copied can leave those entries in place.

The shared adapter suite in `packages/memory/test/FileSystemTest.ts` states this contract as executable assertions, and it runs against the memory adapter alone. Its requirements are unconditional: a handle used after its scope closes reports `BadResource` against the descriptor it held; `copy` with `overwrite: false` onto an existing destination fails `AlreadyExists` without changing either path; `utimes` reports its failing method as `utimes`; `copy` with `preserveTimestamps` carries both the access and the modification time; `chmod` and `chown` apply the requested mode and ownership without host privileges; derived stream and sink handles finalize on success, failure, and interruption; and a watcher stops receiving events once it is released.

Effect's Node platform adapter diverges from four of those requirements, which is why the suite is not run against it: `copy` with `overwrite: false` skips an existing destination silently instead of failing, `utimes` reports its method as `utime`, `preserveTimestamps` carries only the modification time, and a closed handle surfaces `EBADF` as `Unknown` rather than `BadResource`. Ownership changes there also need host privileges. These are upstream behaviors, not adapter obligations; the suite must not be weakened to accommodate them.

This contract [depends on](resources-and-authority.md "depends on") core capabilities, [implements package boundaries](../decisions/package-boundaries.md "implements"), and is [grounded in the Effect compatibility research](../research/effect-compatibility.md "grounded in").
