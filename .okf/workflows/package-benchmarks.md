---
type: Workflow
title: Package benchmarks
description: Defines repeatable Vitest timing, Effect configuration and resource lifetimes, correctness qualification, and CI timing history.
status: stable
tags: [benchmarks, testing, effect, performance]
sources:
  - resource: ../../packages/core/benchmarks/confinement.bench.ts
    title: Core measurement and scoped fixture ownership
  - resource: ../../packages/core/benchmarks/sources.ts
    title: Independent source bundle preparation
  - resource: ../../packages/nfs/benchmarks/xdr-effect.bench.ts
    title: Production and experimental XDR measurements
  - resource: ../../packages/node/benchmarks/mountedMemory.bench.ts
    title: Mounted filesystem comparison with Node MemoryProvider
  - resource: ../../packages/node/benchmarks/mountedTree.bench.ts
    title: Mounted tree scan and batched I/O workload definitions
  - resource: ../../vitest.config.ts
    title: Package benchmark projects
  - resource: ../../.github/workflows/pr-validation.yml
    title: Correctness smoke qualification
  - resource: ../../.github/workflows/package-benchmarks.yml
    title: CI timing and artifact collection
  - resource: https://github.com/benchmark-action/github-action-benchmark/blob/master/README.md
    title: Custom metrics for a benchmark history dashboard
  - resource: https://cli.github.com/manual/gh_run_download
    title: Download timing artifacts for a selected run
  - resource: https://vitest.dev/guide/benchmarking
    title: Vitest benchmark fixture
  - resource: https://vitest.dev/guide/migration/
    title: Vitest 5 migration
  - resource: ../../bun.lock
    title: Installed runner versions
generated: { by: codex/okf, at: "2026-11-20T10:26:56+01:00" }
---

# Package benchmarks

Benchmarks belong in the owning package's `benchmarks` directory. Run its
`benchmark` script after building its production declarations. Vitest 5 exposes
`bench` through a regular test's context. Benchmark projects match `*.bench.ts`;
ordinary tests run separately. Benchmark sources are type-checked
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

The inspected Vitest 5.1.0 / Tinybench 6.2.3 provider runs candidates sequentially,
despite the public guide describing interleaving. Vitest suite hooks surround the
enclosing test; Tinybench iteration hooks surround each warmup and measurement
callback outside its timer. Recheck installed source when changing runner versions.

The NFS client-scheduling probe uses Vitest test mode. Its samples measure timestamps
inside overlapping operations with controlled storage delay.

Use ordinary JSON reporters for native statistics. Saved `writeResult` / `bench.from`
baselines can support controlled historical comparisons, but cannot replace core's
independent same-run source comparison. Keep generated timing files outside version
control. Re-measure both revisions after changing measurement boundaries; results
from different runners are not directly interchangeable.

Run Node and Bun sequentially on an idle host. Report sample count and variation;
mean-based faster/slower matchers do not establish statistical significance. Pull request CI uses small workloads to check execution, result agreement, and
configuration.

## Follow timing over time

The package benchmarks workflow runs on benchmark-related pushes to main and can
run on demand. It runs core and XDR under Node 24 and Bun, and the mounted provider
comparison under Node 26. It runs benchmark files sequentially in each job. Open
the workflow run and download the artifact for the runtime you want to inspect,
or use its run ID with GitHub CLI.

```sh
gh run download RUN_ID --pattern 'package-benchmarks-*' --dir /tmp/package-benchmarks
```

Each runtime job installs and builds two independent checkouts. On a push, the
previous revision is the main tip before the push. On a manual run, or a push
without a previous tip, it is the current commit's first parent. The job runs
both checkouts sequentially on the same runner. The workflow alternates revision
order by run number and attempt.

Each runtime uploads one artifact for up to 90 days. The artifact contains
`previous/` and `current/` directories with Vitest JSON and per-revision toolchain
metadata. Use `comparison.txt` to check both commit IDs, measurement order, shared
runner details, and workload controls.

CI times six confinement rounds of 120 operations or read/write pairs per batch.
Each checkout saves its own confinement round samples. Inside each checkout,
core's existing `HEAD` control compares two builds of that checkout's sources.
For revision-to-revision comparisons, use the working-tree candidate from each
checkout. Compare cases only when their workload and measurement boundary match.

Keep separate series by runtime, runner class, workload, candidate, and
measurement version. Compare the median of round medians and retain the spread
and sample count. Core confinement reports latency per batch and throughput in
batches per second. XDR and the mounted single-file cases report latency and
throughput per operation. Mounted tree cases report per tree and repeated 4 KiB
cases report per batch of 32 calls. CI supplies the new mounted tree benchmark
to the previous revision when the file is missing and records its hash for both
revisions. Confirm apparent regressions on an idle controlled host
before setting a threshold.

For history beyond artifact retention, publish normalized results from successful
main runs to a versioned data store. Include the commit, run ID and attempt, units,
sample count, and the series identity. The Vitest 5 JSON reporter stores tasks
under `testResults[].assertionResults[].benchmarks[].tasks[]`. Use package-relative
file names and stable case names when deriving series keys. Benchmark Action can
graph normalized custom metrics from a dedicated data branch.
