---
type: Research
title: Effect preview drop-in evaluation
description: Records the single-package replacement experiment, direct contract failures, and the remaining work before existing core, memory and Node can use the proposed engine unchanged.
status: draft
tags: [effect, migration, compatibility]
sources:
  - resource: ../../packages/effect-preview/README.md
    title: Single pinned preview package and regeneration
  - resource: ../../packages/effect-preview/patches/0001-preserve-caller-interruptibility.patch
    title: Upstream cancellation fix and regression tests
  - resource: ../../packages/effect-preview/patches/0002-recursive-mkdir-dot-components.patch
    title: Upstream recursive mkdir traversal fix and regression tests
  - resource: ../../packages/effect-preview/patches/0003-current-time-attributes.patch
    title: Upstream current-time attribute support and runtime/type regressions
  - resource: ../../packages/effect-preview/patches/0004-atomic-resize-attributes.patch
    title: Upstream atomic resize attributes and runtime/type regressions
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
generated: { by: codex/okf, at: "2026-11-15T19:35:14+00:00" }
---

# Effect preview drop-in evaluation

The goal is one reproducible private preview package consumed by the existing core, memory, and Node packages. Existing applications, public behavior, codecs, and test assertions must remain intact. A parallel downstream stack does not establish replacement compatibility.

The PR now adds only `packages/effect-preview`, pinned to `161258278d6618bb5a10804827bb7a5f34b04c4d`. The former parallel adapters, codecs, helpers, transfer/search/delta packages, and application rewrites are removed. The upstream snapshot remains unchanged; checksummed contribution patches fix cancellation and recursive mkdir dot-component traversal, and add current-time and atomic resize attributes, with upstream runtime and type regressions.

## Current result: runtime switched, acceptance blocked

The existing `make`, fixture, and `fromSnapshot` construction paths now create preview-owned state through `packages/core/src/internal/previewRuntime.ts`. Core consumes the single preview package as a runtime dependency. Memory keeps its existing FileSystem adapter over core Caller. Node keeps its existing provider over core SynchronousAdapter, whose preview binding uses the public synchronous API. There are no downstream preview packages and no automatic fallback on errors.

The compatibility facade maps authenticated targets, credentials, ordinary reads and mutations, conditional entry opens, metadata, scoped handles, and public capture/restore records to the existing interfaces. Core owns root-caller scopes; derived callers and handles retain independently scoped authority observers. Imported directory restrictions apply to the resolved final symlink target as well as the original entry. Core serializes compatibility observations, and native calls share its reentry guard.

The facade now preserves insertion order, numeric revisions, authenticated in-memory reference keys, reference paths, relative addresses, stale references, partial recursive removal, and unchanged snapshot identity. A private owner and operation invalidation allow repeated captures to reuse the immutable snapshot. Native resource scopes close after the current native operation returns, preserving the existing reentrant shutdown behavior. These are implemented adaptations, not missing upstream APIs.

Exact creation modes use the same credentials, root, and cwd with a zero umask. Existing modes need no change when they already equal `finalMode`; newly created files can receive that mode atomically. Symlink creation timestamps use existing copy publication. These cases must not be blocked merely because the preview uses different option names.

`PreviewRuntime.test.ts` proves that core and native writes share the actual public preview owner, and restored volumes use it. Existing test assertions remain unchanged. With four contributions, all 239 preview tests pass. Existing core results improve to 709 passed / 309 failed: atomic resize recovers ten more tests covering rollback, timing, call styles, and combined requests. Memory remains 652 passed / 70 failed, retaining the 28 failures fixed by cancellation. No previously passing tests regress. Node 26.11.1 remains 42 passed / 2 failed, with all 18 mounted tests passing. The remaining gaps are tracked in [issue #328](https://github.com/lloydrichards/effect-virtual-fs/issues/328).

`check:preview-compatibility` explicitly constructs the retained community baseline with `makeCommunityVolume`. Its adapter comparisons use the actual existing core, memory, and Node bindings. A raw API difference is classified separately when the facade can preserve the behavior.

## Blocking upstream contracts

| Contract                                                                | Evidence from the pinned public implementation                                                                                                                                                                                  | Existing coverage affected                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Watches                                                                 | Owner and caller have no watch or committed-change subscription.                                                                                                                                                                | Watch readiness, ordering, capacity, confinement, and adapter events.                                               |
| Durable volumes                                                         | Owner exposes authorize, capture, usage, and limits, with no commit-before-publication/rejection/recovery hook.                                                                                                                 | LiveVolume, registry, persistence, and admission tests that wait on a commit hook.                                  |
| Copy-on-write overlays                                                  | Public restore constructs an independent engine; there is no shared fork operation.                                                                                                                                             | Overlay sharing/isolation, merge integration, and Node overlay tests.                                               |
| Existing-file final mode and final-symlink replacement                  | Copy publication rejects `finalMode` and `replaceFinalSymlink` as excess fields.                                                                                                                                                | File identity, aliases, exact quotas, transfer publication, and failure atomicity.                                  |
| Atomic initial metadata                                                 | Open rejects `initialSize`; directory creation rejects `times`.                                                                                                                                                                 | Initial size/owner/literal times and their rollback checks.                                                         |
| Special modes, custom symlink modes, wide owners, empty symlink targets | Direct probes reject unsupported bits, symlink mode changes, owners above unsigned 32-bit range, and empty targets.                                                                                                             | Existing rich fixtures, snapshot round trips, transfer fidelity, and Node symlink tests. No metadata is normalized. |
| Caller-authorized orphan metadata                                       | A file retained by a creator handle remains observable, but a different authorized owner cannot update it by public reference after unlink. Using the creator's privileged handle would change the invoking caller's authority. | Orphan handle metadata authority.                                                                                   |
| Relatime                                                                | A second recent read updates atime again.                                                                                                                                                                                       | File, handle, directory, and transfer atime tests.                                                                  |
| Readable, nonsearchable directory listing                               | Public no-atime walk requires search permission before listing. Binding listings require search; name-only listings lack object references and touch atime.                                                                     | Walk, recursive listing, and transfer failure-prefix tests.                                                         |

The direct probes preserve typed error fields and require successful baseline operations. Masked finalizer cleanup was a demonstrated upstream defect and is now fixed by `patches/0001-preserve-caller-interruptibility.patch` in the preview package. Admission and the pre-publication interruption checkpoint restore the caller's interruption setting instead of forcing interruption. Regression tests prove that interrupted-child cleanup and masked writes finish, while the existing ordinary-write interruption test still proves rollback before publication. This needs no adapter changes or detached cleanup fibers. Regeneration verifies the contribution checksum, applies it to upstream paths with zero fuzz, and checks generated output against the patched source.

Recursive mkdir dot-component traversal is fixed by `patches/0002-recursive-mkdir-dot-components.patch`. Unguarded recursive paths resolve terminal `.` and `..` through the existing transactional walker, including its constrained-budget path. Guarded dot targets retain their existing malformed-name rejection because entry conditions require a named slot. Ten upstream cases cover ordinary and byte paths, rooted symlink traversal, transient budgets, permission and entry-limit rollback, and entry conditions. Seven fail without this patch; the three condition-preservation cases already pass. The unchanged core dot-component regression now passes, and both the mkdir and masked-cleanup direct comparisons agree with the baseline. Memory event tests still require the missing watch API.

Current-time attribute updates are supported by `patches/0003-current-time-attributes.patch`. `Attributes.atime` and `mtime` accept literal instants or `"now"`. Both current-time markers and ctime share the transaction clock sample; omission preserves a field. A non-owner may touch both times with write permission, while literal or mixed now/omit requests still require ownership. Each other requested field retains its prestate authority check. Core preserves the markers rather than converting them into literals before calling the preview. Eleven new runtime cases and two public type tests pass and detect the missing feature without the patch; they cover caller, operation-session, file-handle and synchronous entry points, transaction sampling, unchanged revisions, stale guards, authority and interruption rollback. Four existing core failures now pass. The direct current-time probe uses the new marker; numeric literals remain ownership-protected. Combined size/time requests are now supported by the atomic resize contribution below.

Atomic resize is supported by `patches/0004-atomic-resize-attributes.patch`. `Attributes.size` accepts the existing byte-size input format. Every metadata field is authorized against prestate before write access and size limits; zero-filled growth or shrinking is staged with metadata and timestamps in one transaction. Paths and references use current write permission; retained file handles use their open-time write grant. Setting size preserves object identity, aliases, and all handle cursors, including handles configured to clamp on explicit truncate. Literal timestamps override automatic resize mtime. Core forwards combined requests directly while retaining its revision, error-precedence, and unlocated quota-error conventions. Sixteen new runtime and two public type tests detect the missing feature and pass with the patch. Ten existing core failures and the direct size/metadata comparison now pass. Watch-event verification, special mode bits, and atomic creation metadata retain their separate blockers.

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
