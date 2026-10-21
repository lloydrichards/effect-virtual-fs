---
type: Contract
title: Memory adapter compatibility
description: Preserves Effect FileSystem behavior while adapting shared core volumes through independent bindings.
status: stable
tags: [effect, adapter, compatibility]
sources:
  - resource: ../../packages/memory/src/internal/fileSystemAdapter.ts
    title: Shared operation-port binding
  - resource: ../../packages/memory/test/MinimalFileSystem.test.ts
    title: Private minimal provider qualification
  - resource: ../../packages/core/compatibility/engine-imports/check.mjs
    title: Transitive engine and adapter import audit
  - resource: ../../packages/memory/src/internal/directoryEntries.ts
    title: Internal typed entry reader for portable traversal
  - resource: ../../packages/memory/src/MemoryFileSystem.ts
    title: Public memory adapter API
  - resource: ../../packages/memory/src/internal/memoryFileSystem.ts
    title: Core-to-Effect adapter implementation
  - resource: ../../packages/memory/src/internal/fileHandle.ts
    title: Effect file handle and cursor implementation
  - resource: ../../packages/memory/src/internal/treeOperations.ts
    title: Recursive listing and removal over the core walk and remove
  - resource: ../../packages/memory/src/internal/glob.ts
    title: Portable glob compilation, depth-first traversal, exclusions and errors
  - resource: ../../packages/memory/src/internal/adapterSupport.ts
    title: Named path-target options preserving bases and final-symlink policy
  - resource: ../../packages/memory/src/internal/copyOperations.ts
    title: Adapter copy operations
  - resource: ../../packages/memory/src/internal/copyTree.ts
    title: Private Caller-based copy traversal and guarded cleanup
  - resource: ../../packages/memory/test/CopyCleanup.test.ts
    title: Copy failure, interruption, replacement and byte-fidelity checks
  - resource: ../../packages/memory/compatibility/copy-imports/check.mjs
    title: Copy runtime import boundary audit
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
generated: { by: codex/okf, at: "2026-10-21T23:00:00+02:00" }
---

# Memory adapter compatibility

`@effect-vfs/memory` exposes Effect's path-based `FileSystem` service while `@effect-vfs/core` owns filesystem behavior. A fresh adapter creates a volume containing `/tmp`; `bind` attaches to an existing volume without modifying it.
`layerFromFixture(fixture, volumeOptions?, callerOptions?)` composes core fixture construction and binding. It requires Crypto, preserves typed construction failures, and adds no `/tmp`. Separate builds create independent volumes; a shared layer build shares writes, with `Layer.fresh` available for isolation. POSIX Path is optional through `Layer.merge(seeded, Path.layer)`.

The binding composes file handles, recursive traversal, and copy operations from separate internal modules; the shared core engine retains namespace and content ownership, while community assembly constructs and delivers watches. `fileSystemAdapter.ts` binds the operation port without constructing community features; `memoryFileSystem.ts` supplies public construction and watch delivery. The test-only minimal provider uses the same binding and shared engine with no Crypto requirement. Its watch stream explicitly fails `WatchUnsupported` on consumption. Public memory constructors and their epoch-dated `/` and `/tmp` defaults are unchanged. The shared behavior corpus runs through both construction paths. `watch` follows the object its path resolves to when the watch starts, not the path: it keeps reporting after the object or an ancestor is renamed and ends after reporting the object's removal. A watched file reports only changes under the watched name, not under its other hard links; that name follows the file across renames of the file and its ancestors. Core Caller watch registration resolves the path and selects its alias under the coordination gate. Resolved alias tracking happens at publication rather than when the adapter consumes queued events.

Bindings share namespace and contents while retaining independent callers, descriptor tables, file cursors, and lifetimes. The adapter preserves Effect cursor and convenience behavior where it intentionally differs from the POSIX-oriented core, and maps expected core failures to `PlatformError`.
It translates `FsError` only when an operation crosses into Effect's `FileSystem` service. The translation preserves the core error as the cause and records the public method and path or descriptor. It maps volume admission pressure to `Busy`; failures without a matching Effect system-error tag, including capacity rejection, use `Unknown` with the core code in the description.

The adapter follows Effect's byte and cursor types at its public boundary. File metadata exposes exact `ByteSize.ByteSize` values, reads and writes return byte counts as numbers, and seeks accept and return bigint positions.
Seeks before the start fail with `BadArgument` without changing the cursor, and
`readAlloc` rejects missing, coerced, negative, and non-integer runtime sizes.

Recursive `makeDirectory`, `readDirectory`, and `remove` use the core's [recursive tree operations](../decisions/core/recursive-tree-operations.md "uses"). Recursive listings hold no directory handle and refresh no access times because the core walk writes nothing. Portable glob instead performs ordinary directory reads, which can refresh access times under relatime.

The internal `glob.ts` adapts Effect's MIT-licensed portable algorithm at `5c4b648deaf19676eb81c5f7e452b5bd5c3ae344`. It preserves Unicode matching, literal malformed brackets, normalized and absolute patterns, depth-first order, exclusion before reads, and skipping unreadable wildcard-reached directories. Named unreadable directories still fail. Its typed-entry reader observes each entry's own kind through its reference, including dangling symlinks. FileSystemTesting derives glob over the decorated readDirectory/stat/readLink methods and preserves the explicit glob handler.

Published Effect 4.0.5 supplies bigint metadata, positioned reads, final-component noFollow and watch readiness. Positioned reads preserve the sequential cursor; readiness runs after registration can buffer events. Access enforces every requested read/write bit. Metadata inode/device/link counts remain exact bigint values through transfer identity checks.

Portable Glob, public readDirectoryEntries/lstat, and the SecureRandom/Digest service split remain unreleased. The published FileSystem/Crypto interfaces remain the public contracts. Local TODOs name the upstream replacement condition; no parallel service is exposed. Provider failures in existing Crypto digest/random operations are defects, matching the future providers, while filesystem and storage I/O failures retain their typed errors.

The layer-based adapter suite in `packages/memory/test/FileSystemTest.ts` runs shared assertions against memory and the Effect Node adapter. `vitest.host.config.ts` runs both providers in Node, independently of the normal Bun workspace run. The first host qualification target is Node 24.21.0 on Ubuntu 24.04 with `@effect/platform-node-shared` 4.0.0; the PR validation host job prints its runtime, operating system, architecture and adapter version. This target does not imply Windows, browser or Bun host support.

Shared behavior covers path failures, parents, links, open flags, independent cursors, append, truncation and open-unlinked files. Scoped temporary directories and files disappear after success, failure and interruption. Derived stream and sink handles fail structured `stat` checks immediately after success, failure and interruption, before another native descriptor can be acquired. Watch delivery is established by bounded setup mutations because native registration follows asynchronous `stat`; unrelated directory events do not satisfy the file assertion. Interruption stops consumption before a sentinel mutation. A separate host fixture observes the native watcher close event immediately after interruption, while its enclosing scope remains open.

Memory retains its stronger guarantees: closed handles report `BadResource`; copy collisions with `overwrite: false` fail `AlreadyExists`; missing-path `utimes` errors name `utimes`; copying with `preserveTimestamps` retains both timestamps; and arbitrary uid/gid changes need no host privilege. The explicit Node profile instead requires copy collisions to succeed without changing either path, closed-handle `stat` to fail `Unknown` with an `EBADF` cause, missing-path timestamp errors to name `utime`, copying to preserve modification time without requiring original access-time preservation, and missing-path watch errors to name the preliminary `stat`. Host ownership assertions retain the existing uid/gid without elevated privileges. Each difference is explained beside its assertion; shared cursor and write correctness is not relaxed to accommodate runtime defects.

The host command is `bun run --filter @effect-vfs/memory test:host`; Bun launches the script, but the script explicitly executes Vitest in Node. Other runtime and operating-system combinations remain unqualified.

This contract [depends on](resources-and-authority.md "depends on") core capabilities, [implements package boundaries](../decisions/package-boundaries.md "implements").

Borrowed `bindCaller` preserves caller root, cwd, credentials, and umask. The [confined caller contract](confined-callers.md "constrained by") defines boundary failures, default `/tmp`, publication filtering, and identity-safe temporary cleanup. Ordinary volume binding retains its constructor defaults.

## Copy ownership and cleanup

`FileSystem.copy` uses a private iterative Caller traversal, not the public TreeTransfer engine. It retains volume-derived entry, path, file and stored-byte limits, byte-sorted traversal, raw descendant names and link targets, hard-link topology, exact modes and optional original atime/mtime. Each file is buffered whole and written atomically; a tree is live and observable throughout copying.

`copy` copies source link objects and replaces final destination file links. A destination directory link is rejected. `copyFile` follows final source and destination links, retains an existing destination inode and its aliases/open handles, and treats a same-inode request as an event- and metadata-neutral no-op. `copy` rejects the same inode.

Failure or interruption in reject mode removes the newly claimed unfinished root. Cleanup reopens copy-created restrictive directories by object reference and uses core recursive removal with an expected root reference. Every removal checks the root and the child identities observed by that walk. A root moved or replaced before cleanup is preserved; a replacement after observation stops removal and remains intact. Entries added inside the owned root before the walk lists them may be removed. A concurrently added restrictive directory can prevent cleanup if its permissions prohibit traversal. Cleanup is not a journal of copy-created entries.

Overwrite retains partial progress and restores created directory modes on failure. Directory metadata finishes bottom-up without interruption; a late interruption can leave a completed copy. Cleanup errors remain defects alongside the original typed failure or interruption, including after PlatformError translation. This does not promise an atomic tree publication or consistency under arbitrary concurrent source and ancestor changes.

`bun run --cwd packages/memory check:copy-imports`, also run by the memory build, traces runtime workspace imports from the copy module after TypeScript type erasure. Core leaf imports keep that graph free of project transfer, snapshot, image, fixture and codec modules. Whole-provider construction still uses the core engine; its separation belongs to #307.
