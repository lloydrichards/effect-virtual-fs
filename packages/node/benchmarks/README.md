# Mounted Node benchmarks

Use Node 26.11.1 and run these commands from the repository root.

```sh
bun run --cwd packages/core build
bun run --cwd packages/node benchmark -- --reporter=json --outputFile=/tmp/node-mounted-benchmark.json
```

The suite compares the Effect VFS provider with Node's built-in `MemoryProvider`.
Both candidates serve the same synchronous `node:fs` operations through separate mounts.
Each measurement uses a file eight directories deep.
The suite measures stat, a 4 KiB binary read, and a 4 KiB overwrite of an existing file.
One iteration is one filesystem call. The suite mounts, creates fixtures, checks results,
and cleans up outside the timed callbacks.

Each workload runs two rounds with fresh fixtures. The Effect provider runs first in round 1,
and Node's provider runs first in round 2. Vitest records each round under a distinct name.
For each workload, compare the median of the two round p50 latencies for each provider.
For trends over time, compare matching workloads on the same Node version and runner configuration.
The timings include Node mount routing and in-memory provider work.
