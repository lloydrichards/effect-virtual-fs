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

## Measure and diagnose performance

- Measure the public operation first. Match the provider route, durability, payload, path depth, and fixture state. Label direct calls, mounted calls, Effect programs, and reused handles separately. A positional patch skips truncation, so the difference from whole-file overwrite cannot estimate the savings from an optimization.
- Keep the small, existing, and large cases distinct. Use latency for tiny files, latency and payload MiB/s for large files, and time per tree plus files/s for multi-file work. Derive throughput from the stated latency statistic and label it accordingly.
- Use paired CI reports for trends. Record both commit IDs and measurement order. For new workloads, run the same benchmark source on both revisions when their APIs support it. Match workload names and units before calculating deltas. Use unchanged-code pairs to estimate variation and repeat small changes in both revision orders.
- Audit the timing boundary with unprofiled standalone batches on the same runtime. Keep setup and checks outside timing where feasible. Compare each experiment against a control that bypasses the changed path. A moved control warrants investigation before claiming a small improvement.
- Profile a warmed operation loop separately. Save the raw CPU profile and label flame graph widths as sampled stack prevalence. Distinguish inclusive stack shares from self time. Trace the hot public call through intermediate layers, then test one change with identical workloads.
- For lookup and write optimizations, measure creation and symlink writes alongside regular overwrite. Check permissions, error precedence, link behavior, and ownership where the change touches them.
- Keep raw reports, the runner command, commit and tool versions, host details, and per-pair results together. For an issue or PR, show a size curve, call-stack figure, or compact before/after table when it helps explain the change. State which profile or benchmark supports the claim and which scenarios still need a measurement.
