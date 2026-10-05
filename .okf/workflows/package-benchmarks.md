---
type: Workflow
title: Package benchmarks
description: Defines repeatable Vitest timing, Effect configuration and resource lifetimes, and correctness-only benchmark qualification.
status: stable
tags: [benchmarks, testing, effect, performance]
sources:
  - resource: ../../packages/core/benchmarks/confinement.bench.ts
    title: Core measurement and scoped fixture ownership
  - resource: ../../packages/core/benchmarks/sources.ts
    title: Independent source bundle preparation
  - resource: ../../packages/nfs/benchmarks/xdr-effect.bench.ts
    title: Production and experimental XDR measurements
  - resource: ../../vitest.config.ts
    title: Package benchmark projects
  - resource: ../../.github/workflows/pr-validation.yml
    title: Correctness smoke qualification
  - resource: https://vitest.dev/guide/benchmarking
    title: Vitest benchmark fixture
  - resource: https://vitest.dev/guide/migration/
    title: Vitest 5 migration
  - resource: ../../bun.lock
    title: Installed runner versions
generated: { by: codex/okf, at: 2026-10-05T08:20:00Z }
---

# Package benchmarks

Benchmarks belong in the owning package's `benchmarks` directory. Run its
`benchmark` script after building its production declarations. Vitest 5 exposes
`bench` through a regular test's context. Benchmark projects match `*.bench.ts`;
ordinary tests run separately. Both core and NFS benchmark sources are type-checked
without becoming production build inputs. Core's native build tools use a separate
Node-typed benchmark project.

Decode workload controls through Effect Config before setup or timing. Validate
positive safe integers and use `Config.Array` for comma-separated depth lists.
Malformed controls fail; missing controls receive documented defaults. Configuration
and correctness tests use `@effect/vitest` with explicit ConfigProvider overrides.

Measure with live runtime clocks. Vitest callbacks form the native runtime boundary:
use `Effect.runPromiseWith` for core batches in the enclosing scope's context and
`Effect.runSync` for synchronous XDR operations. Include that boundary in the stated
measurement. Acquire volumes and handles before timing, retain their scope across
callbacks, and release them on failure as well as success. Remove temporary source
bundles after the suite.

Core compares separately built committed and working-tree sources. Preserve their
source identities, runtime, host details, workload controls, raw samples, and units
in output. Each round warms candidates, measures one batch per candidate, and
alternates their order across rounds. Aggregate batch medians across rounds;
Vitest table throughput is batches per second. A faster result must remain
[constrained by live caller authority](/decisions/core/confined-caller-authority.md "constrained by").

XDR measures one operation per callback, checks equivalent results, and alternates
candidate order between comparisons. Fixture encoding is outside timing; checksum
assertions and Effect runtime execution are inside. Its wrapped production cases
intentionally include an additional runtime boundary.

The inspected Vitest 5.0.3 / Tinybench 6.1.4 provider runs candidates sequentially,
despite the public guide describing interleaving. Vitest suite hooks surround the
enclosing test; Tinybench iteration hooks surround each warmup and measurement
callback outside its timer. Recheck installed source when changing runner versions.

Use ordinary JSON reporters for native statistics. Saved `writeResult` / `bench.from`
baselines can support controlled historical comparisons, but cannot replace core's
independent same-run source comparison. Keep generated timing files outside version
control. Re-measure both revisions after changing measurement boundaries; results
from different runners are not directly interchangeable.

Run Node and Bun sequentially on an idle host. Report sample count and variation;
mean-based faster/slower matchers do not establish statistical significance. CI
uses small workloads to check execution, result agreement, and configuration. It
imposes no timing threshold on shared runners.
