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
    title: Recursive listing and removal over the core walk and remove
  - resource: ../../packages/memory/src/internal/glob.ts
    title: Adapter glob compilation, traversal, exclusions, errors and sorted output
  - resource: ../../packages/memory/src/internal/adapterSupport.ts
    title: Named path-target options preserving bases and final-symlink policy
  - resource: ../../packages/memory/src/internal/copyOperations.ts
    title: Adapter copy operations
  - resource: ../../packages/memory/src/internal/treeTransfer.ts
    title: Tree transfer engine used by copy
  - resource: ../../packages/memory/src/internal/platformError.ts
    title: Core-to-Effect error translation
  - resource: ../../packages/memory/test/MemoryFileSystem.test.ts
    title: Effect compatibility tests
  - resource: ../../packages/memory/test/MemoryFileSystem.test.ts
    title: Shared core binding tests
  - resource: ../../packages/memory/test/FileSystemTest.ts
    title: Shared assertions and explicit adapter expectations
  - resource: ../../packages/memory/test/fixtures/host-watch-lifecycle.mjs
    title: Native watcher interruption cleanup
  - resource: ../../vitest.host.config.ts
    title: Node host qualification configuration
  - resource: ../../.github/workflows/pr-validation.yml
    title: Named host CI configuration
  - id: adapter-tests
    resource: ../../packages/memory/test/MemoryFileSystem.test.ts
    title: Adapter behavior tests
  - resource: ../../packages/memory/test/MemoryFileSystem.test.ts
    title: Error mapping regressions
  - id: overlay-binding
    resource: ../../packages/memory/test/MemoryFileSystem.test.ts
    title: Overlay volume binding tests
generated: { by: codex/okf, at: "2026-10-04T21:24:00+02:00" }
---

# Memory adapter compatibility

`@effect-vfs/memory` exposes Effect's path-based `FileSystem` service while `@effect-vfs/core` owns filesystem behavior. A fresh adapter creates a volume containing `/tmp`; `bind` attaches to an existing volume without modifying it.
`layerFromFixture(fixture, volumeOptions?, callerOptions?)` composes core fixture construction and binding. It requires Crypto, preserves typed construction failures, and adds no `/tmp`. Separate builds create independent volumes; a shared layer build shares writes, with `Layer.fresh` available for isolation. POSIX Path is optional through `Layer.merge(seeded, Path.layer)`.

The binding composes file handles, recursive traversal, and copy operations from separate internal modules; core retains namespace, content, and watch ownership. `watch` follows the object its path resolves to when the watch starts, not the path: it keeps reporting after the object or an ancestor is renamed and ends after reporting the object's removal. A watched file reports only changes under the watched name, not under its other hard links; that name follows the file across renames of the file and its ancestors. Core Caller watch registration resolves the path and selects its alias under the coordination gate. Resolved alias tracking happens at publication rather than when the adapter consumes queued events.

Bindings share namespace and contents while retaining independent callers, descriptor tables, file cursors, and lifetimes. The adapter preserves Effect cursor and convenience behavior where it intentionally differs from the POSIX-oriented core, and maps expected core failures to `PlatformError`.
It translates `FsError` only when an operation crosses into Effect's `FileSystem` service. The translation preserves the core error as the cause and records the public method and path or descriptor. It maps volume admission pressure to `Busy`; failures without a matching Effect system-error tag, including capacity rejection, use `Unknown` with the core code in the description.

The adapter follows Effect's byte and cursor types at its public boundary. File metadata exposes exact `ByteSize.ByteSize` values, reads and writes return byte counts as numbers, and seeks accept and return bigint positions.
Seeks before the start fail with `BadArgument` without changing the cursor, and
`readAlloc` rejects missing, coerced, negative, and non-integer runtime sizes.

Recursive `makeDirectory`, `readDirectory`, `glob`, and `remove` are the core's [recursive tree operations](../decisions/core/recursive-tree-operations.md "uses"). A recursive `makeDirectory` gives every directory it creates the mode, as Node does, and creates none when it fails partway, where Node leaves the ones it made. A recursive listing and `glob` hold no directory handle and, as Node's recursive `readdir` does, fail `PermissionDenied` below a directory the caller may read but not search. One difference is deliberate: they refresh no directory's access time, where Node's recursive `readdir` refreshes each under relatime, because the core walk writes nothing. `remove` with `force` succeeds only when the path itself is missing; an entry that goes missing below it fails the call.

The internal `glob.ts` operation owns glob compilation, collected core traversal, strict path conversion, exclusions, error translation and sorted strings. `memoryFileSystem.ts` delegates to it. `treeOperations.ts` keeps its collected walk private to recursive listings. Glob decodes the entire walk before exclusions, so excluded unreadable or invalid-name subtrees still fail. Its wildcard units remain UTF-16 and hidden names require explicit dot matching. Internal path targets use named `relativeTo` and `followFinalSymlink` options, preserving omitted defaults and explicit `false`.

Directory copy rejects a destination child that is a symbolic link instead of following it as a directory. It also rejects copying `/` into one of its descendants before creating the destination. `copy` runs on the [tree transfer](tree-transfer.md "uses") engine with the volume's own limits and no depth bound; `overwrite` maps to `existing: "overwrite"`, `preserveTimestamps` to both timestamps, and source modes are copied with their special bits. A copy without `overwrite` claims its destination and removes it if the copy fails. An overwriting copy remains a sequence of core operations, so failures after earlier entries are copied can leave those entries in place.

The layer-based adapter suite in `packages/memory/test/FileSystemTest.ts` runs shared assertions against memory and the Effect Node adapter. `vitest.host.config.ts` runs both providers in Node, independently of the normal Bun workspace run. The first host qualification target is Node 24.21.0 on Ubuntu 24.04 with `@effect/platform-node-shared` 4.0.0; the PR validation host job prints its runtime, operating system, architecture and adapter version. This target does not imply Windows, browser or Bun host support.

Shared behavior covers path failures, parents, links, open flags, independent cursors, append, truncation and open-unlinked files. Scoped temporary directories and files disappear after success, failure and interruption. Derived stream and sink handles fail structured `stat` checks immediately after success, failure and interruption, before another native descriptor can be acquired. Watch delivery is established by bounded setup mutations because native registration follows asynchronous `stat`; unrelated directory events do not satisfy the file assertion. Interruption stops consumption before a sentinel mutation. A separate host fixture observes the native watcher close event immediately after interruption, while its enclosing scope remains open.

Memory retains its stronger guarantees: closed handles report `BadResource`; copy collisions with `overwrite: false` fail `AlreadyExists`; missing-path `utimes` errors name `utimes`; copying with `preserveTimestamps` retains both timestamps; and arbitrary uid/gid changes need no host privilege. The explicit Node profile instead requires copy collisions to succeed without changing either path, closed-handle `stat` to fail `Unknown` with an `EBADF` cause, missing-path timestamp errors to name `utime`, copying to preserve modification time without requiring original access-time preservation, and missing-path watch errors to name the preliminary `stat`. Host ownership assertions retain the existing uid/gid without elevated privileges. Each difference is explained beside its assertion; shared cursor and write correctness is not relaxed to accommodate runtime defects.

The host command is `bun run --filter @effect-vfs/memory test:host`; Bun launches the script, but the script explicitly executes Vitest in Node. Other runtime and operating-system combinations remain unqualified.

This contract [depends on](resources-and-authority.md "depends on") core capabilities, [implements package boundaries](../decisions/package-boundaries.md "implements").

Borrowed `bindCaller` preserves caller root, cwd, credentials, and umask. The [confined caller contract](confined-callers.md "constrained by") defines boundary failures, default `/tmp`, publication filtering, and identity-safe temporary cleanup. Ordinary volume binding retains its constructor defaults.
