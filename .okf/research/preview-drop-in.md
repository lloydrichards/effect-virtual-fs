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
  - resource: ../../packages/core/src/internal/previewRuntime.ts
    title: Public preview compatibility facade used by existing core constructors
  - resource: ../../packages/core/test/PreviewRuntime.test.ts
    title: Shared preview state and restored-volume ownership regressions
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
generated: { by: codex/okf, at: "2026-11-15T16:58:00+00:00" }
---

# Effect preview drop-in evaluation

The goal is one reproducible private preview package consumed by the existing core, memory, and Node packages. Existing applications, public behavior, codecs, and test assertions must remain intact. A parallel downstream stack does not establish replacement compatibility.

The PR now adds only `packages/effect-preview`, pinned to `161258278d6618bb5a10804827bb7a5f34b04c4d`. The former parallel adapters, codecs, helpers, transfer/search/delta packages, and application rewrites are removed. No generated upstream engine source has been changed.

## Current result: runtime switched, acceptance blocked

The existing `make`, fixture, and `fromSnapshot` construction paths now create preview-owned state through `packages/core/src/internal/previewRuntime.ts`. Core consumes the single preview package as a runtime dependency. Memory keeps its existing FileSystem adapter over core Caller. Node keeps its existing provider over core SynchronousAdapter, whose preview binding uses the public synchronous API. There are no downstream preview packages and no automatic fallback on errors.

The compatibility facade maps authenticated targets, credentials, ordinary reads and mutations, conditional entry opens, metadata, scoped handles, and public capture/restore records to the existing interfaces. Core owns the scope for its unscoped root callers; derived callers and handles use the caller's scope. Core serializes its compatibility observations, and native calls share a reentry guard. This is adaptation code, not a claim of complete revision or concurrency parity.

`PreviewRuntime.test.ts` proves that ordinary core and native writes are visible through the actual public preview owner, and that restored volumes also use it. The existing tests have not been changed or skipped. Core and memory still have failures; the Node provider passes 41/44 and mounted filesystems pass 18/18 on the required Node 26.11.1. These are preview results, unlike the earlier unchanged-engine baseline.

`check:preview-compatibility` explicitly constructs the retained community baseline with `makeCommunityVolume`; it must not accidentally compare preview-backed default constructors to the preview and call them the old engine.

## Blocking upstream contracts

- Watches require an atomic committed-change boundary. Polling cannot preserve subscription readiness, ordering, aliases, capacity, or confinement behavior.
- Exact final file mode and final-symlink replacement need atomic publication options. Separate chmod/unlink operations would expose partial results and change failure behavior.
- Entry creation with initial size/owner/times and exact modes, and combined size/metadata updates, require atomic operations. Literal symlink timestamps can use existing copy publication; an exact directory mode unaffected by umask needs no workaround.
- Live stores require commit-before-publication, definite rejection, uncertain-outcome, and recovery hooks absent from the public owner.
- General overlays require the existing copy-on-write isolation and sharing contract; independently restoring a capture would narrow it.
- Special mode bits, non-0777 symlink modes, wide owners, and empty symlink targets are not all representable by the pinned engine. Existing snapshot codecs remain unchanged and unsupported restores fail rather than normalize state.
- Reentrant synchronous owner-scope closure currently requires an asynchronous drain. The existing native test fails with AsyncFiberError.
- Authenticated persistent reference keys and canonical paths by arbitrary reference still need a public capability contract.

These are concrete blockers to completing a faithful replacement. They do not excuse adapter failures. Error precedence/fields, listing order, numeric revision and snapshot identity fidelity, walks under mutation, and cancellation require further compatibility work or a demonstrated public-API limitation. A red assertion is not automatically an upstream blocker.

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

The diagnostic reports the original direct-API comparisons separately from the adapted runtime suites. It preserves typed error fields for failed proposed operations. The existing core and adapter suites remain the eventual acceptance criteria; these comparisons are a focused diagnostic, not a replacement suite.

## Review status

The runtime substitution is implemented for ordinary operations, but the PR remains a failing proof of concept. Build/type checks and passing ownership tests do not establish drop-in compatibility. Keep existing failure expectations as the acceptance contract, and record exact suite results in PR #329 and issue #328. Do not publish the core runtime dependency on this private preview package.

The [atomic copy proposal](https://github.com/lloydrichards/effect-virtual-fs/issues/328) describes the smallest identified file-publication addition. It is not implemented in the pinned source. Resolving it alone does not resolve watch, persistence, overlay, metadata, or remaining adapter behavior.

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
