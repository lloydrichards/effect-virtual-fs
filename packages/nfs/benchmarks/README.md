# NFS benchmarks

Build the NFS package, then run the XDR experiment from the repository root:

```sh
bun run --cwd packages/nfs build
bun run --cwd packages/nfs benchmark
```

`xdr-effect-benchmark.mjs` compares the current production XDR codec
with several experimental Effect implementations. `xdr-effect-proposal.ts` is
benchmark support, outside published `src`. Its behavior tests live in
`test/XdrProposal.test.ts`. The experiment does not change the production codec.
