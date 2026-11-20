# Mounted Node benchmarks

Use Node 26.11.1 and run these commands from the repository root.

```sh
bun run build --filter=@effect-vfs/node
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

## Tree and repeated I/O

The scan lists eight directories, stats 128 files, and reads their 512 B payloads.
The separate list, stat, and read cases isolate these phases. Stat and read use
paths prepared outside timing. The full scan discovers names within timing.
Each scan callback processes one tree. Repeated 4 KiB read and overwrite callbacks
make 32 path-based calls. Divide their batch latency by 32 for latency per call.

Typed listing measures the root and its eight subdirectories. Recursive names and
recursive typed listings each use a single call. Each callback counts the 136
returned entries, including the eight directories.
