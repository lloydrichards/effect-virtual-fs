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
  - resource: ../../packages/effect-preview/src/virtual-file-system/internal/runtime.ts
    title: Preview admission, completion, and interruption behavior
  - resource: ../../packages/effect-preview/src/virtual-file-system/internal/model.ts
    title: Public owner operations, metadata, and atomic publication options
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/328
    title: Remaining API gaps and atomic copy option proposal
generated: { by: codex/okf, at: "2026-11-15T19:42:00+00:00" }
---

# Effect preview drop-in evaluation

The goal is one reproducible private preview package consumed by the existing core, memory, and Node packages. Existing applications, public behavior, codecs, and test assertions must remain intact. A parallel downstream stack does not establish replacement compatibility.

The PR now adds only `packages/effect-preview`, pinned to `161258278d6618bb5a10804827bb7a5f34b04c4d`. The former parallel adapters, codecs, helpers, transfer/search/delta packages, and application rewrites are removed. No generated upstream engine source has been changed.

## Current result: runtime switched, acceptance blocked

The existing `make`, fixture, and `fromSnapshot` construction paths now create preview-owned state through `packages/core/src/internal/previewRuntime.ts`. Core consumes the single preview package as a runtime dependency. Memory keeps its existing FileSystem adapter over core Caller. Node keeps its existing provider over core SynchronousAdapter, whose preview binding uses the public synchronous API. There are no downstream preview packages and no automatic fallback on errors.

The compatibility facade maps authenticated targets, credentials, ordinary reads and mutations, conditional entry opens, metadata, scoped handles, and public capture/restore records to the existing interfaces. Core owns root-caller scopes; derived callers and handles retain independently scoped authority observers. Imported directory restrictions apply to the resolved final symlink target as well as the original entry. Core serializes compatibility observations, and native calls share its reentry guard.

The facade now preserves insertion order, numeric revisions, authenticated in-memory reference keys, reference paths, relative addresses, stale references, partial recursive removal, and unchanged snapshot identity. A private owner and operation invalidation allow repeated captures to reuse the immutable snapshot. Native resource scopes close after the current native operation returns, preserving the existing reentrant shutdown behavior. These are implemented adaptations, not missing upstream APIs.

Exact creation modes use the same credentials, root, and cwd with a zero umask. Existing modes need no change when they already equal `finalMode`; newly created files can receive that mode atomically. Symlink creation timestamps use existing copy publication. These cases must not be blocked merely because the preview uses different option names.

`PreviewRuntime.test.ts` proves that core and native writes share the actual public preview owner, and restored volumes use it. Existing test assertions remain unchanged. Current acceptance results are recorded in [PR #329](https://github.com/lloydrichards/effect-virtual-fs/pull/329) and [issue #328](https://github.com/lloydrichards/effect-virtual-fs/issues/328).

`check:preview-compatibility` explicitly constructs the retained community baseline with `makeCommunityVolume`. Its adapter comparisons use the actual existing core, memory, and Node bindings. A raw API difference is classified separately when the facade can preserve the behavior.

## Blocking upstream contracts

| Contract                                                                | Evidence from the pinned public implementation                                                                                                                                                                                            | Existing coverage affected                                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Watches                                                                 | Owner and caller have no watch or committed-change subscription.                                                                                                                                                                          | Watch readiness, ordering, capacity, confinement, and adapter events.                                               |
| Durable volumes                                                         | Owner exposes authorize, capture, usage, and limits, with no commit-before-publication/rejection/recovery hook.                                                                                                                           | LiveVolume, registry, persistence, and admission tests that wait on a commit hook.                                  |
| Copy-on-write overlays                                                  | Public restore constructs an independent engine; there is no shared fork operation.                                                                                                                                                       | Overlay sharing/isolation, merge integration, and Node overlay tests.                                               |
| Existing-file final mode and final-symlink replacement                  | Copy publication rejects `finalMode` and `replaceFinalSymlink` as excess fields.                                                                                                                                                          | File identity, aliases, exact quotas, transfer publication, and failure atomicity.                                  |
| Atomic initial metadata                                                 | Open rejects `initialSize`; directory creation rejects `times`.                                                                                                                                                                           | Initial size/owner/literal times and their rollback checks.                                                         |
| Combined resize and metadata                                            | `setAttributes` rejects `size`. Separate truncate/chmod calls cannot preserve authorization, failure atomicity, or one revision.                                                                                                          | Combined setattr tests.                                                                                             |
| Special modes, custom symlink modes, wide owners, empty symlink targets | Direct probes reject unsupported bits, symlink mode changes, owners above unsigned 32-bit range, and empty targets.                                                                                                                       | Existing rich fixtures, snapshot round trips, transfer fidelity, and Node symlink tests. No metadata is normalized. |
| Non-owner UTIME_NOW                                                     | A non-owner with write permission cannot request current times through numeric `setAttributes`; it fails ownership.                                                                                                                       | Metadata authority and operation-matrix tests.                                                                      |
| Caller-authorized orphan metadata                                       | A file retained by a creator handle remains observable, but a different authorized owner cannot update it by public reference after unlink. Using the creator's privileged handle would change the invoking caller's authority.           | Orphan handle metadata authority.                                                                                   |
| Relatime                                                                | A second recent read updates atime again.                                                                                                                                                                                                 | File, handle, directory, and transfer atime tests.                                                                  |
| Readable, nonsearchable directory listing                               | Public no-atime walk requires search permission before listing. Binding listings require search; name-only listings lack object references and touch atime.                                                                               | Walk, recursive listing, and transfer failure-prefix tests.                                                         |
| Atomic recursive mkdir with terminal dot components                     | Public recursive creation rejects the terminal name in `/new/..`. Incremental downstream mkdir would change rollback and publication behavior.                                                                                            | Recursive dot-component tests.                                                                                      |
| Masked finalizer cleanup                                                | Interrupting a child whose finalizer creates a directory leaves that directory on the baseline and omits it on the preview. The pinned runtime explicitly enables interruption at admission/completion inside the caller's masked region. | Interrupted temporary resources, copy cleanup, and transfer final-mode/cleanup tests.                               |

The direct probes preserve typed error fields and require successful baseline operations. The masked-finalizer probe isolates the engine from the adapters; `internal/runtime.ts` explicitly uses `Effect.interruptible` at admission and completion. Forking cleanup into a detached fiber would change caller scheduling and cancellation semantics, so the facade does not use that workaround.

Error precedence, fields, listing order, snapshot identity, authority, and cancellation remain part of the acceptance contract. A failing assertion alone does not establish an upstream gap. Failures in concurrent watch and live-store tests that wait for unavailable hooks remain visible, including their timeouts.

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
