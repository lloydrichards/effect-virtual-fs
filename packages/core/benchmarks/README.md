# Core benchmarks

Build core first, then run its Vitest benchmark project from the repository root:

```sh
bun run --cwd packages/core build
CONFINEMENT_BENCH_BASELINE=HEAD \
CONFINEMENT_BENCH_BASELINE_CONFINED=1 \
CONFINEMENT_BENCH_ITERATIONS=10000 \
CONFINEMENT_BENCH_ROUNDS=9 \
CONFINEMENT_BENCH_OUTPUT=/tmp/confinement-bun.json \
bun run --cwd packages/core benchmark
```

Bun builds baseline and working-tree sources independently. To measure Node,
use the same controls with:

```sh
node node_modules/vitest/vitest.mjs bench --run --config vitest.config.ts \
  --project 'core (bench)' --reporter=json --outputFile=/tmp/core-vitest.json
```

Run measurements sequentially on an idle host. Keep the baseline revision fixed.
Configuration is decoded through Effect Config before setup or timing. Malformed
values fail rather than falling back to defaults.

| Variable                              | Default                             | Meaning                                                                       |
| ------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `CONFINEMENT_BENCH_BASELINE`          | `HEAD`                              | Revision containing baseline core sources                                     |
| `CONFINEMENT_BENCH_BASELINE_PATCH`    | unset                               | Patch applied to archived baseline sources                                    |
| `CONFINEMENT_BENCH_BASELINE_CONFINED` | `false`                             | Enable baseline confined callers with `1` or `true`; requires `withRoot`      |
| `CONFINEMENT_BENCH_ITERATIONS`        | `1200`                              | Operations or read/write pairs per callback                                   |
| `CONFINEMENT_BENCH_ROUNDS`            | `7`                                 | Independent comparisons, alternating candidate order                          |
| `CONFINEMENT_BENCH_DEPTHS`            | `1,8,64`                            | Comma-separated depths beneath `/tenant`                                      |
| `CONFINEMENT_BENCH_FILE_BYTES`        | `4`                                 | File size and bytes per operation                                             |
| `CONFINEMENT_BENCH_OUTPUT`            | `.cache/confinement-benchmark.json` | Summary path relative to the command's working directory, or an absolute path |

Each comparison warms each candidate with three batches, then measures one batch
through Vitest/Tinybench. The summary retains samples and medians across rounds,
percentage comparisons, runtime, host details, baseline revision, and source
hashes. Vitest's optional JSON reporter also retains native benchmark statistics.
Throughput in its tables means batches per second, not filesystem operations per
second. A single round cannot establish statistical significance.

Source-tree hashes use sorted relative filenames and contents. Bundle hashes also
include temporary-path comments. Negative `confinedChangePercent` means less time
than baseline confined callers. The confined-to-ordinary ratio compares current
callers; confined paths omit the physical `/tenant` prefix.

Fixtures, handle acquisition, Config decoding, and builds are outside timing.
Every timed batch checks returned lengths, endpoint bytes, write counts, and
checksums. Assertions, runtime execution, and result allocations are included.
Scopes close handles on success and failure; temporary bundles are removed after
the suite. These measurements do not quantify allocation or storage performance.

Re-measure both revisions after changing runners. Earlier manual-runner medians
and Vitest callback timings have different runtime boundaries. CI runs only a
small correctness smoke; it does not impose speed thresholds.
