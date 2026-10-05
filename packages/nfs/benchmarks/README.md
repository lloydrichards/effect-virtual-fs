# XDR benchmarks

Build NFS, then compare its production codec with the experimental codecs:

```sh
bun run --cwd packages/nfs build
bun run --cwd packages/nfs benchmark
```

For Node, run from the repository root:

```sh
node node_modules/vitest/vitest.mjs bench --run --config vitest.config.ts \
  --project 'nfs (bench)' --reporter=json --outputFile=/tmp/xdr-vitest.json
```

Effect Config decodes positive integer controls before measurement:

| Variable               | Default | Meaning                                            |
| ---------------------- | ------- | -------------------------------------------------- |
| `XDR_BENCH_TIME_MS`    | `1000`  | Minimum measured time per candidate in each round  |
| `XDR_BENCH_ITERATIONS` | `64`    | Minimum callback count per candidate in each round |
| `XDR_BENCH_ROUNDS`     | `3`     | Comparisons, alternating candidate order           |

Tinybench must meet both time and iteration minimums. It also warms candidates
before timing. Each callback performs one operation and checks its checksum;
Effect runtime execution is included. Encoding fixtures and checking equivalent
wire bytes happen outside timing. `production-wrapped` deliberately measures an
extra Effect runtime boundary around the production call.

Keep correctness coverage in `test/XdrProposal.test.ts`. Generated timing JSON
belongs outside version control. Run Node and Bun sequentially on an idle host;
report runtime versions with results. CI uses small settings to check execution
and agreement, without performance thresholds.
