---
type: Research
title: Effect preview drop-in evaluation
description: Records the single-package replacement experiment, direct contract failures, and the remaining work before existing core, memory and Node can use the proposed engine unchanged.
status: draft
tags: [effect, migration, compatibility]
sources:
  - resource: ../../packages/effect-preview/README.md
    title: Single pinned preview package and regeneration
  - resource: ../../packages/core/compatibility/preview/check.mjs
    title: Executable baseline and proposed contract comparisons
  - resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Existing caller, volume, snapshot, and overlay contracts
  - resource: ../../packages/core/src/SynchronousAdapter.ts
    title: Existing checked synchronous native boundary
  - resource: ../../packages/memory/src/internal/memoryFileSystem.ts
    title: Existing memory binding through a core caller
  - resource: ../../packages/node/src/NodeVirtualProvider.ts
    title: Existing Node binding through core SynchronousAdapter
  - resource: ../../packages/effect-preview/src/virtual-file-system/VirtualFileSystem.ts
    title: Proposed public owner and caller API
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/328
    title: Remaining API gaps and atomic copy option proposal
generated: { by: codex/okf, at: "2026-11-15T16:07:23+00:00" }
---

# Effect preview drop-in evaluation

The goal is one reproducible private preview package consumed by the existing core, memory, and Node packages. Existing applications, public behavior, codecs, and test assertions must remain intact. A parallel downstream stack does not establish replacement compatibility.

The PR now adds only `packages/effect-preview`, pinned to `161258278d6618bb5a10804827bb7a5f34b04c4d`. The former parallel adapters, codecs, helpers, transfer/search/delta packages, and application rewrites are removed. No generated upstream engine source has been changed.

## Current result: replacement remains blocked

The existing runtime has not been switched to the preview. Core has a preview development dependency and executable comparisons; memory and Node have commands for their existing binding boundaries. These are diagnostics, not completed adapters. The old constructors remain in place because substituting the new API while retaining current semantics is unresolved. There is no automatic fallback that could make a preview run look successful.

`bun run test` still executes the existing suites against their original implementation, plus the pinned upstream tests. Its passing result must not be described as the existing packages passing on the preview. `bun run check:preview-compatibility` instead compares the real baseline and preview boundaries and exits 1 on differences. It deliberately does not convert those differences into expected passing assertions or skip incompatible contracts.

## Reproduced differences

| Contract                         | Existing result                                           | Proposed result                                            | Disposition                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Whole-file replacement and read  | Short replacement truncates and reads `[9]`               | Same result with translated options                        | Ordinary adapter mapping. This one check proves no broader parity.                                                                             |
| Atomic exact final mode          | A write with `finalMode` publishes the requested mode     | Copy publication rejects `finalMode` as an excess field    | Upstream atomic-publication gap. Separate chmod is not equivalent.                                                                             |
| Atomic final-symlink replacement | Replaces the final entry without following its target     | Copy publication rejects `replaceFinalSymlink`             | Upstream gap; retain identity, quota, permissions, and failure atomicity.                                                                      |
| Watch acquisition                | Returns a subscribed stream                               | No owner watch method                                      | Need a public committed-change boundary or equivalent support to preserve existing watches. Snapshot polling is not an equivalent replacement. |
| Regular-file special bits        | Retains mode 04755                                        | Rejects unsupported bits                                   | Representation gap. Do not strip bits or weaken assertions.                                                                                    |
| Object revisions                 | Public monotonic bigint                                   | Opaque token                                               | Contract mismatch requiring a faithful adaptation proof or upstream support. Do not substitute invented counters.                              |
| Directory listing order          | Insertion order (`z`, `a`) in this case                   | Byte order (`a`, `z`)                                      | Observable behavior mismatch. Sorting the old expected output would narrow the contract.                                                       |
| Existing memory bind             | Accepts a core volume and provides working FileSystem I/O | An Owner has no core `caller` contract                     | Adapter work, not proof that the upstream cannot provide FileSystem.                                                                           |
| Existing Node bind               | Accepts a constructor-qualified synchronous core volume   | Rejects the Owner at core SynchronousAdapter qualification | Adapter work. The preview does have a synchronous API; that alone does not qualify native lifetime/reentry behavior.                           |

The command currently reports one equivalent comparison and eight differences. It preserves typed error fields for failed proposed operations. The existing core and adapter suites remain the eventual acceptance criteria; these comparisons are a focused diagnostic, not a replacement suite.

## Work before a behavior-preserving substitution

Adapt existing package boundaries rather than publish or maintain downstream preview counterparts. Translate path/reference authentication, credentials, error codes, options, metadata, and handles in core; keep Effect FileSystem translation in memory and native cursor/lifetime policy in Node. Existing generic snapshot, search, delta/merge, transfer, and persistence logic should keep its current owner and tests.

Constructor lifetime requires explicit design: a core volume creates unscoped callers, while preview authorization requires a Scope. Owning hidden scopes indefinitely or requiring consumers to change their public resource contract is not a demonstrated drop-in solution. Numeric revisions and namespace-change results similarly require coherent observations, not before/after calls that can race.

The [atomic copy proposal](https://github.com/lloydrichards/effect-virtual-fs/issues/328) is the smallest identified file-publication change: file-specific `finalMode` and `replaceFinalSymlink` options on `publishCopiedFile`. That operation already preserves existing regular-file identity. This proposal is not implemented in the pinned port.

Additional retained contracts require qualification: live stores commit before publication and fault on uncertain outcomes; NFS requires authenticated reference keys and restart identity; overlays retain their isolation/change and sharing contracts; codecs retain wide IDs, symlink metadata and empty targets that preview live state cannot always restore. Existing Node tests also require precise reentry, interruption, and closure behavior. These are blockers or adaptation obligations, not permission to omit features.

The safe next implementation step depends on resolving the core lifetime/revision and committed-change boundaries. Until then the PR is a blocked proof of concept, not a completed engine replacement. Passing the unchanged baseline suites does not remove that blocker.

## Reproduce

```sh
bun install --frozen-lockfile
bun run build
bun run test
bun run test:node
bun run --cwd packages/node test:mounted
bun run check:preview-compatibility
```

The last command is intentionally a failing replacement gate until all its comparisons agree. It is optional diagnostic work rather than a default CI success claim. No tests have been disabled or had their expected behavior relaxed.

This evaluation [refines the staged migration](minimal-effect-port.md "refines") and is constrained by the existing [package dependency model](../architecture/package-dependency-model.md "constrained by").
