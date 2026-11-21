---
type: Research
title: NFS unused-export pilot
description: Records the findings and limits of a report-only Knip trial for the NFS workspace.
status: stable
tags: [nfs, tooling, static-analysis]
sources:
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/386
    title: Audit finding and known orphan
  - resource: ../../tools/checks/repository.mjs
    title: Manifest-driven public entries
  - resource: ../../packages/nfs/package.json
    title: Public subpaths and workspace commands
  - resource: ../../packages/nfs/src/internal/lockRanges.ts
    title: Known orphan and imported controls
  - resource: ../../packages/nfs/docgen.json
    title: NFS API documentation inputs
  - resource: https://knip.dev/reference/jsdoc-tsdoc-tags
    title: Production handling of internal annotations
---

# NFS unused-export pilot

This historical pilot informs the [static analysis policy research](static-analysis-policy.md "informs").
The report-only trial found two unused declarations, `sameRange` and the XDR benchmark's `decodeExample`.
It also found five declarations used in their own files whose `export` modifiers have no observed consumers.
The results support reviewing those declarations in a separate cleanup.
A mandatory check would add configuration to distinguish test consumers, entrypoint exports, and documentation tags.
The small result set does not justify that cost.

## Scope and results

Knip 6.45.1 ran with Node 26.12.0 on Linux x86-64 at `a260fe90`. Bun 1.4.4 installed repository dependencies and generated the pilot configuration.
The manifest inventory supplied both published source roots, `src/index.ts` and `src/NfsServer.ts`.
Knip left their exports out of unused-export reporting. The imported lock-range controls `LockRange`, `MAX_OFFSET`, `lockRange`, and `overlaps` also stayed out of the reports.

| Run                 | Time excluding startup | Startup | Result                                                                        |
| ------------------- | ---------------------: | ------: | ----------------------------------------------------------------------------- |
| Production flag     |                  1.0 s |  292 ms | No symbol or dependency findings. Emitted 249 tag hints, including 31 in NFS. |
| Test-inclusive      |                  1.0 s |  295 ms | Seven symbol findings and no dependency findings.                             |
| Source-only project |                  1.0 s |  452 ms | Ten symbol findings and two unused development dependencies.                  |

The test-inclusive report and a reference search give these dispositions.

| Finding                                                                                                                                                 | Disposition                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `sameRange` in `src/internal/lockRanges.ts`                                                                                                             | Unused declaration. The only module import selects its four siblings.    |
| `decodeExample` in `benchmarks/xdr-effect-proposal.ts`                                                                                                  | Unused declaration. The benchmark and proposal tests use other exports.  |
| `putfhFailure` in `src/internal/nfs4.ts`                                                                                                                | Export-only candidate. The same file calls it.                           |
| `HANDLER_OPTIONS` in `test/support/harness.ts`                                                                                                          | Export-only candidate. The same file uses it to create the test handler. |
| `OpenedFile` in `src/internal/export.ts`, `ServerLimits` in `src/internal/server.ts`, benchmark `DecoderSession` in `benchmarks/xdr-effect-proposal.ts` | Export-only candidates. Their defining modules still use the types.      |

Source-only reporting also flagged `Status`, `Operation`, `nextSequenceId`, `failureForFs`, `Nfs4Limits`, and `Credentials`.
The NFS tests import all six. The two source-only development dependency findings, `@effect/platform-node-shared` and `@effect/vitest`, also have test imports.
Treat those eight findings as expected for the narrower graph. They would be false positives for repository-wide removal.
The workspace scripts consume Vitest, and the TypeScript configs extend `@repo/config-typescript`.
The package's runtime import of `effect` requires its peer declaration.

Knip suppresses `@internal` exports under `--production`. That hid both `sameRange` and `putfhFailure` in the production-mode report.
The source-only project keeps the source graph while using default tag handling.
The production tag hints also reached loaded dependency workspaces, including the generated Effect preview. That source remains owned by its generator.

The workspace has no computed or literal dynamic module imports in its TypeScript sources, tests, or benchmarks.
Test and benchmark files are explicit development roots because Vitest discovers them by glob.
The manifest retains the public source roots for external imports and generated docs. NFS docgen excludes `src/internal` and consumes the public server module.
Application entrypoints, documentation examples, and external conformance scripts consume the public package. They do not add private NFS roots.

## Reproduce the three reports

From the repository root, use a frozen dependency install and put the pilot package under the ignored cache.

```sh
bun install --frozen-lockfile
mkdir -p .cache/knip-386
npm install --prefix .cache/knip-386 --no-package-lock --no-audit --no-fund knip@6.45.1
```

Build the views from the package inventory.

```sh
bun --eval '
  import { discoverWorkspaces, publicEntries } from "./tools/checks/repository.mjs"
  const nfs = (await discoverWorkspaces()).find(({ manifest }) => manifest.name === "@effect-vfs/nfs")
  const roots = publicEntries(nfs).map(({ source }) => source.slice(nfs.directory.length + 1))
  const config = (view) => ({ workspaces: { [nfs.directory]: view } })
  await Bun.write(".cache/knip-386/config.json", JSON.stringify(config({
    entry: [...roots.map((root) => root + "!"), "test/**/*.test.ts", "benchmarks/**/*.bench.ts"],
    project: ["src/**/*.ts!", "test/**/*.ts", "benchmarks/**/*.ts"]
  })))
  await Bun.write(".cache/knip-386/source-only.json", JSON.stringify(config({
    entry: roots,
    project: ["src/**/*.ts"],
    vitest: false
  })))
'
```

Run the default and production reports with the same configuration, then run the source-only view.

```sh
knip=.cache/knip-386/node_modules/.bin/knip
"$knip" --config .cache/knip-386/config.json --workspace @effect-vfs/nfs --no-exit-code --no-progress --duration
"$knip" --config .cache/knip-386/config.json --workspace @effect-vfs/nfs --no-exit-code --no-progress --duration --production
"$knip" --config .cache/knip-386/source-only.json --workspace @effect-vfs/nfs --no-exit-code --no-progress --duration
```
