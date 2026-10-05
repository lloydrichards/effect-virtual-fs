---
type: Decision
title: Confined caller authority
description: Explains identity-rooted authority, live revocation, and publication-time watch selection.
status: stable
tags: [callers, authority, confinement, resources, watches]
sources:
  - resource: ../../../packages/core/src/internal/resolution.ts
    title: Confined resolver
  - resource: ../../../packages/core/benchmarks/production-confinement-benchmark.mjs
    title: Reproducible confinement benchmark
  - resource: ../../../packages/memory/src/internal/memoryFileSystem.ts
    title: Current adapter ownership and watch integration
generated: { by: codex/okf, at: "2026-10-05T09:36:00+02:00" }
---

# Confined caller authority

The [confined caller contract](../../contracts/confined-callers.md "implemented by") is implemented. The root follows directory identity so trusted renames do not silently change the assigned tree. Path-based authority would allow a replacement at the old pathname to acquire that authority. The design assigns authority to a retained directory identity rather than a pathname. It rebases absolute lookup and symbolic links, clamps root `..`, and checks current membership for paths, references, entry directories, and directly usable handles. Nested roots retain ancestor boundaries. Existing hard links may share objects across confined roots; namespace confinement does not provide independent contents.

The implemented additions are scoped `Caller.withRoot`, `Caller.watch`, backing-volume `Caller.limits`, and borrowed `MemoryFileSystem.bindCaller`. Confined resources retain the [independent ownership model](independent-resource-lifetimes.md "constrained by"). Scope release differs from loss of namespace membership. Root deletion permanently invalidates its authority; moving an object outside temporarily denies access to a still-live capability.

Membership must be checked through the operation's draft-aware namespace inside its coordination gate. Independently scoped handles carry their boundary policy. Privileged credentials cannot bypass confinement. Caller roots, parents, canonical paths, and errors must agree on the visible namespace.

The adapter needs publication-time watch alias selection and path rebasing, typed stream failure conversion, and bounded terminal overflow. Conditional removal with an expected object reference is required to prevent temporary cleanup from deleting a replacement after path reuse. Cleanup must respect confinement and skip expected authority loss.

Live membership checks avoid a stale authority cache after trusted moves or rejected commits. This costs ancestry traversal for confined operations. Any future cache must preserve draft-aware authorization and revocation before improving throughput. The reusable production benchmark compares isolated source bundles and checks public operation results; single-host timing does not establish a universal throughput guarantee.

Authorization selects the operation's draft-aware lookup once, then shares it across root-liveness and membership checks. Path resolution similarly selects one lookup per walk instead of resolving the Effect context per component. The lookup reads current pending draft changes, including directories created earlier during that walk. Each operation selects its lookup anew; no namespace or membership result is cached across operations. This removes per-ancestor Effect context lookup without changing the linear ancestry cost. Walks yield every 128 parents to keep deep traversal interruptible. Core-owned benchmark sources live beside `src` and `test`; the benchmark can execute under Bun or Node and separates ancestry depth from file size.
