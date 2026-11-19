---
name: package-benchmarks
description: Design, run, or review performance benchmarks in effect-virtual-fs, including filesystem baselines and CI timing history.
---

# Package benchmarks

Read the [benchmark workflow](../../../.okf/workflows/package-benchmarks.md) and the owning package's benchmark README. Check the installed Vitest API before changing how measurements run.

- Put throughput and latency cases in the owning package's Vitest benchmark project. Keep controlled scheduling probes in test mode when their internal timestamps are the measurements.
- Define the work per callback, its units, and the public API being measured. State which setup, Effect runtime calls, checks, and cleanup are within timing. Use live clocks and scope resources across callbacks.
- Check equivalent results and state transitions before comparing speed. Use the same payload, paths, operation order, and concurrency for each candidate. Record API and durability differences that affect interpretation.
- Use a fixed historical revision for source comparisons and same-run candidates for comparisons across implementations. Keep the runtime, workload, and measurement boundary fixed when following a series. Give changed workloads new case names or record where the series breaks.
- Keep raw samples and environment metadata in CI artifacts. Compare timings within one runtime and runner class. Use shared runners for trends and repeat apparent regressions on an idle controlled host.
