---
name: package-test-design
description: Organize, write, or refactor package test suites in effect-virtual-fs around exported modules and observable behavior. Use for new package tests, test consolidation, and reviews of test ownership or coverage.
---

# Package test design

## Match suites to public modules

Use the package manifest's `exports` to identify public source modules. Give each public module one top-level suite named `test/<Module>.test.ts`. Use `test/index.test.ts` for the root entry point when it has its own export contract. Group behaviors within the owning suite using `describe` and parameterize cases that exercise the same promise.

Import package functions, values, and types through public modules. Source imports into public modules are fine when the runner uses source. Keep `src/internal/` imports out of suites and test helpers. A helper may build fixtures or supply a public dependency. Keep assertions and test registration in the owning suite.

Keep benchmark workloads few and under the package's `benchmarks/` directory. Keep packed-consumer, type, and runtime qualification checks at their established entry points.

## Test what a caller can observe

Start with the public operation and assert the outcome a caller or adapter relies on. Use returned data, typed errors, events, persisted and reopened state, and resource lifetime. Avoid assertions about private caches, backing collections, and incidental calls. Drive races with public boundaries, such as a deferred `LiveImageStore.commit`, a scope close, or a test clock.

Before consolidating a suite, identify the distinct failure each case detects. Preserve regressions for data loss, permission checks, compatibility, interruption, and concurrency. Replace private probes with observable scenarios where possible. Record any meaningful coverage gap when a private interleaving has no public equivalent.

Core is the first package organized this way. See [watch registration and cancellation](../../../packages/core/test/Watch.test.ts) and [handle lifetimes](../../../packages/core/test/FileHandle.test.ts). Use the [Effect development skill](../effect-development/SKILL.md) for Effect-specific test mechanics. Run the owning package suite and the relevant [repository checks](../../../.okf/workflows/evidence-and-validation.md).
