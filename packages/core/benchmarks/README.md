# Core benchmarks

Run from the repository root. The confinement benchmark bundles committed baseline
sources and working-tree candidate sources independently. Bun is needed to build
both bundles; either Bun or Node can execute the measurements.

```sh
CONFINEMENT_BENCH_BASELINE=HEAD \
CONFINEMENT_BENCH_BASELINE_CONFINED=1 \
CONFINEMENT_BENCH_ITERATIONS=10000 \
CONFINEMENT_BENCH_ROUNDS=9 \
CONFINEMENT_BENCH_OUTPUT=/tmp/confinement-bun.json \
bun packages/core/benchmarks/production-confinement-benchmark.mjs
```

Replace `bun` with `node` to measure Node. `bun run --cwd packages/core benchmark`
runs with the defaults. Run measurements sequentially on an otherwise idle host.
Keep the baseline commit fixed while evaluating candidate changes.

| Variable                              | Default                                                     | Meaning                                                                             |
| ------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `CONFINEMENT_BENCH_BASELINE`          | `HEAD`                                                      | Git revision containing baseline core sources                                       |
| `CONFINEMENT_BENCH_BASELINE_PATCH`    | unset                                                       | Apply a patch to the archived baseline sources before bundling                      |
| `CONFINEMENT_BENCH_BASELINE_CONFINED` | unset                                                       | Set to `1` to measure old confined callers too; requires `withRoot` in the baseline |
| `CONFINEMENT_BENCH_ITERATIONS`        | `1200`                                                      | Operations or read/write pairs per timed batch                                      |
| `CONFINEMENT_BENCH_ROUNDS`            | `7`                                                         | Timed rounds, after three warmup rounds                                             |
| `CONFINEMENT_BENCH_DEPTHS`            | `1,8,64`                                                    | Directory depths beneath `/tenant`                                                  |
| `CONFINEMENT_BENCH_FILE_BYTES`        | `4`                                                         | File size and bytes read or written per operation                                   |
| `CONFINEMENT_BENCH_OUTPUT`            | `production-confinement-benchmark.json` under `os.tmpdir()` | JSON output path under the host temporary directory by default                      |

The output retains samples, medians, runtime, host details, baseline revision, and
source bundle hashes, and stable source-tree hashes. Source-tree hashes use sorted relative filenames and file contents; generated bundle hashes also include temporary-path comments. `confinedChangePercent` compares candidate and baseline
confined medians; negative values mean less elapsed time. Ordinary callers compare
against baseline ordinary callers. The confined-to-ordinary ratio compares the
candidate callers, whose absolute paths omit the physical `/tenant` prefix.

Returned lengths, endpoint bytes, write counts, and checksums are checked in every
batch. Setup, acquisition, and bundling are outside timed batches. Assertions and
result allocations are inside them. These measurements do not quantify allocation
or storage performance. Timing thresholds do not belong in unit tests.
