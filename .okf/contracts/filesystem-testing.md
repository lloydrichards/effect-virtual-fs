---
type: Contract
title: Filesystem faults and spies
description: Observes or rejects public Effect FileSystem calls before delegation while preserving scoped ownership and build-local state.
status: stable
tags: [effect, testing, adapter]
sources:
  - resource: ../../packages/memory/src/FileSystemTesting.ts
    title: Decorator API and implementation
  - resource: ../../packages/memory/test/FileSystemTesting.test.ts
    title: Delegation, fault, counter, and lifetime tests
  - resource: ../../packages/memory/test/FileSystemTesting.types.ts
    title: Handler arguments, typed failures, and scope contracts
  - resource: ../../apps/docs/app/content/guides/testing-with-an-isolated-filesystem.mdx
    title: Consumer examples and sharing rules
generated: { by: codex/okf, at: "2026-10-04T11:10:00+00:00" }
---

# Filesystem faults and spies

`FileSystemTesting` lives in `@effect-vfs/memory`, following the [package boundaries](../decisions/package-boundaries.md "constrained by"). It accepts any Effect `FileSystem`; it does not change the core state engine or require an in-memory provider. The [memory adapter contract](memory-adapter-compatibility.md "depends on") owns the backing memory service's behavior.

`make(base, factory)` returns an Effect that runs the factory once per execution. The factory produces `{ handlers, state }`, and construction returns `{ fileSystem, state }`. Counters allocated inside the factory are independent across builds, even when those builds share the base filesystem. A built service and a memoized Layer build share their counter state. `Layer.fresh` rebuilds the service, but cannot isolate counters captured outside the factory.

Handlers receive the original method arguments and return `Effect<void, PlatformError>` with the method's original scope requirement. Their successful values are ignored; success permits exactly one backing operation, and failure prevents delegation. Each handler is evaluated when its operation executes, never when the operation Effect is constructed. The decorator preserves handler and backing errors, interruption, and scope ownership. It does not introduce another resource scope or make handlers uninterruptible.

The decorator rebuilds five helpers with Effect's `FileSystem.make`. `exists` uses intercepted `access`; `readFileString` uses `readFile`; `writeFileString` uses `writeFile`; consumed streams and sinks use `open`. Any custom implementations of these five helpers on the base service are replaced by Effect's standard implementations. Direct derived-method handlers are excluded.

Scoped `open` and temporary-path methods can be observed or rejected before delegation. Returned file handles remain unchanged: stream chunk reads, sink chunk writes, seeking, and synchronization do not enter top-level handlers. `watch` is forwarded unchanged. Operations inside the backing service, including temporary-resource cleanup and writes performed by copying, do not enter unrelated handlers. A spy records documented public calls rather than every filesystem mutation.

A selected pre-delegation write rejection leaves that operation unapplied while earlier successful writes remain inspectable. It does not simulate a partial write, crash, engine rollback, or physical durability. Permission and quota tests use actual credentials and volume limits rather than injected substitutes.
