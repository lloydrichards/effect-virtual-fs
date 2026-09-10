---
type: Design
title: Effect adapter compatibility
description: Defines the durable compatibility boundary between the runtime-neutral core and Effect's FileSystem adapter.
status: stable
tags: [effect, adapter, compatibility]
sources:
  - id: memory-adapter
    resource: ../../packages/memory/src/MemoryFileSystem.ts
    title: MemoryFileSystem adapter
  - id: adapter-contract-suite
    resource: ../../packages/memory/test/FileSystemTest.ts
    title: Shared adapter contract suite
  - id: core-binding-tests
    resource: ../../packages/memory/test/CoreBinding.test.ts
    title: Core binding compatibility tests
generated: { by: codex/okf, at: 2026-09-10T12:00:00Z }
---

# Effect adapter compatibility

`@effect-vfs/core` owns runtime-neutral filesystem semantics. `@effect-vfs/memory` adapts those semantics to Effect's `FileSystem` service and owns string conversion, `PlatformError` translation, derived helpers, and cursor differences required by that interface. Core does not depend on the adapter.

Bindings to one volume share namespace and bytes but retain independent caller and handle state. Separate opens have independent positions. Adapter append preserves its cursor even though the core handle append operation advances its own offset; positional core I/O lets the adapter preserve this distinction without splitting append placement from the write.

The adapter must preserve current observable behavior for final-symlink handling, copy into existing destination identity, deep trees, scoped cleanup, watch delivery, and normalized errors. Mutations made through another caller or binding must still reach adapter watchers, so event publication belongs at the shared volume coordination boundary rather than in one wrapper.

Byte-valued core observations are converted strictly. String observations fail when names cannot be represented without loss; they must not silently normalize or merge distinct names. The default memory adapter remains permissive in its historical permission behavior even though the core supports explicit caller authority.

The shared adapter suite and focused binding tests are executable compatibility evidence, not proof of full Effect or platform compatibility. The maintained behavior is summarized by [memory adapter compatibility](/contracts/memory-adapter-compatibility.md "implemented by"). Apply the [evidence and validation workflow](/workflows/evidence-and-validation.md "validated by") and preserve the package boundary established by [package boundaries](/decisions/package-boundaries.md "constrained by").
