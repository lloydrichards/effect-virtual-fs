---
name: package-test-design
description: Organize, write, or refactor package test suites in effect-virtual-fs around exported modules and observable behavior. Use for new package tests, test consolidation, and reviews of test ownership or coverage. Use also for demo smoke tests and documentation validation.
---

# Package test design

## Match suites to public modules

Use the package manifest's `exports` to identify public source modules. Give each public module one top-level suite named `test/<Module>.test.ts`. Use `test/index.test.ts` for the root entry point when it has its own export contract. Group behaviors within the owning suite using `describe` and parameterize cases that exercise the same promise.

Import package functions, values, and types through public modules. Source imports into public modules are fine when the runner uses source. Keep `src/internal/` imports out of suites and test helpers. Use helpers for fixtures and public dependencies. If multiple providers implement the same contract, define the assertions once in a shared conformance helper. Register those cases from each provider’s owning suite so the package runner reports them under the public module.

Keep benchmark workloads few and under the package's `benchmarks/` directory. Keep packed-consumer, type, and runtime qualification checks at their established entry points.

## Test what a caller can observe

Start with the public operation and assert the outcome a caller or adapter relies on. Use returned data, typed errors, events, persisted and reopened state, and resource lifetime. Avoid assertions about private caches, backing collections, and incidental calls. Drive races with public boundaries, such as a deferred `LiveImageStore.commit`, a scope close, or a test clock.

For wire protocols, send requests through the public listener and decode replies with an independent client fixture. Feed exact chunk boundaries through the public transport interface when the test depends on fragmentation.

Before consolidating a suite, identify the distinct failure each case detects. Preserve regressions for data loss, permission checks, compatibility, interruption, and concurrency. Replace private probes with observable scenarios where possible. Record any meaningful coverage gap when a private interleaving has no public equivalent.

Core is the first package organized this way. See [watch registration and cancellation](../../../packages/core/test/Watch.test.ts) and [handle lifetimes](../../../packages/core/test/FileHandle.test.ts). Use the [Effect development skill](../effect-development/SKILL.md) for Effect-specific test mechanics. Run the owning package suite and the relevant [repository checks](../../../.okf/workflows/evidence-and-validation.md).

## Prove the documented demo works

Give each distinct demo entry point a short smoke test that follows the documented workflow and checks its result. Launch the CLI, send requests to the protocol listener or HTTP handler, or open the built app when rendering, hydration, workers, or downloads are part of the workflow.

Use real package code and isolated fixtures. Substitute external services at their boundary when credentials, availability, or unpredictable output would make the test unsuitable for ordinary CI. Keep live and privileged qualification at its established entry points.

Keep additional integration cases for distinct app-owned behavior, such as cancellation, state recovery, or cleanup. Package suites own package semantics and edge cases. Remove temporary unit probes after development. Retain a focused unit test when it protects a distinct app-owned regression that would be costly to exercise through the entry point. Consolidate only after identifying which retained case detects each maintained failure. Start with one journey per distinct entry point. For any additional case, name the app-owned failure and explain what the journey would miss. Remove implementation checks and coverage owned by a package, runner, or stronger app test.

## Check documentation at the right boundary

Keep metadata, generated reference, internal link and fragment, and example checks in the docs workspace. Check the published source of runnable examples. Compile snippets that promise valid code and execute examples that promise a result.

Smoke-test representative routes against the built site. Check page-specific content so a fallback response cannot pass for a missing page. Use the docs Vitest Browser Mode suite for browser journeys. Start with one case per interactive example and add cases only for distinct failures the journey cannot expose. Use a top-level page when production navigation, isolation headers, or downloads are part of the behavior. Follow the repository validation workflow for where each check runs.
