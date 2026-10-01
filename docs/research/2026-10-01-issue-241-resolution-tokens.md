# Issue 241: resolution and token lifecycle research

Researched 2026-10-01 against the current checkout and GitHub issue bodies. The investigation proposed the boundaries below. The user accepted all three boundary decisions, and the implementation now follows them without changing the public API.

## Scope and existing decisions

[Issue 241](https://github.com/lloydrichards/effect-virtual-fs/issues/241) asks for one resolution module, one WeakMap-backed token registry, tagged resolution outcomes, explicit handle lifecycle states, and direct internal tests. [Issue 179](https://github.com/lloydrichards/effect-virtual-fs/issues/179) and [issue 180](https://github.com/lloydrichards/effect-virtual-fs/issues/180) are closed. Their historical implementation prescriptions should not override the newer accepted contracts or current race handling.

Public API decision 4 fixes check precedence: resolve the directory, check search permission before looking up names, then reserved/existing-name checks, trailing slashes and rename constraints, then write permission. Missing objects render by addressing form. The resolver must preserve operation/path context as well as node identity. Extracting traversal without authorization would lose an observable security property. Source: [public API decision](../../.okf/decisions/core/public-api-targets-services-and-errors.md).

Engine mutation state must stay together. The module-level reference WeakMap is deliberately retained because it validates possession of an opaque token rather than trusting copyable inode data. Inode retention and open counts belong in immutable `VolumeState`, not a second mutable registry copy. Sources: [persistent-tree decision](../../.okf/decisions/core/persistent-tree-rebuild.md), [current engine](../../packages/core/src/internal/virtualFileSystem.ts), [tree model](../../packages/core/src/internal/tree.ts).

## A single liveness rule still needs operation policies

The general object-reference rule is: an absent node is stale; an unlinked directory is stale immediately; an unlinked regular file remains observable while an already-open handle retains its inode. Final handle close reclaims content and stales its reference. Opening another handle or linking the retained file back into the namespace remains forbidden. Source: [object-reference contract](../../.okf/contracts/object-references.md).

Scoped watch has a deliberately stricter registration rule: an object with no name left is stale, even if an existing open file handle retains it. Its removal ends the stream. This is an accepted semantic distinction, rather than an accidental duplicate liveness check. Source: [scoped-watch decision, decisions 1 and 6](../../.okf/decisions/core/scoped-watch.md).

Directory handles and derived callers may retain detached directories for cleanup. General handle resolution currently accepts a retained directory, while traversal from it reports `NotFound` and adding entries is forbidden. The registry should resolve the retained capability; resolution mode or verb policy should decide whether a named directory is required. Sources: [engine `handleNode`, `lookup`, and `entryDirectory`](../../packages/core/src/internal/virtualFileSystem.ts), [operation behavior table](../../packages/core/test/behaviour/operations.test.ts).

Recommendation: centralize token authenticity, volume ownership, released-handle checks and general object-reference liveness. Apply explicit named-object eligibility checks for watch, reopen, relink and traversal from a detached directory. Keep foreign-before-stale precedence. Do not make every `nlink === 0` object stale, or allow every live token to open/create/watch: either would change public behavior.

## Directory base validation

`Target.Path.relativeTo` publicly accepts a `DirectoryHandle`, and current traversal looks only in the directory-handle WeakMap. Passing a file handle through an untyped boundary currently reports `InvalidHandle`. General `Target.Handle` resolution accepts both maps. The issue calls this two-map difference a defect, but changing a file base to `NotDirectory` would change runtime behavior for invalid inputs. Resolve both kinds centrally if useful, then preserve the directory-base capability restriction unless a separately approved behavior change is intended. Sources: [Target API](../../packages/core/src/Target.ts), [current `lookup` and `handleNode`](../../packages/core/src/internal/virtualFileSystem.ts), [issue 241](https://github.com/lloydrichards/effect-virtual-fs/issues/241).

## Lifecycle requirements

Explicit double close fails; scope cleanup is idempotent. An interrupted close waiting for admission or a close rejected with `VolumeBusy` leaves the file handle open for retry. Commit failure still releases the handle and reports failure. Cleanup bypasses full admission and becomes local-only after volume unavailability. A scope that closes before or during acquisition interrupts it; a commit that already published keeps its filesystem effect even when acquisition returns interrupted. Sources: [explicit-close decision](../../.okf/decisions/core/explicit-close-and-scope-cleanup.md), [FileHandle lifecycle tests](../../packages/core/test/FileHandle.test.ts).

Current `finalizeFile` intentionally keys on inode publication rather than `closed`, because a finalizer may run before an acquisition commit publishes. A rerun must still release a late-published retained inode. A lifecycle union must represent this ordering explicitly; simply turning `closed` into a terminal state can leak the inode. The issue's proposed `releasedPendingCommit` needs an exact state-transition meaning, including publication after cleanup. Sources: [engine `acquireHandle`, `bindFile`, `closeFile`, and `finalizeFile`](../../packages/core/src/internal/virtualFileSystem.ts), [explicit-close decision](../../.okf/decisions/core/explicit-close-and-scope-cleanup.md).

Independent scopes remain independent: closing the caller that created a file or directory handle must not revoke separately scoped handles or derived callers. Metadata authority belongs to the invoking caller; file I/O keeps open-time access. Root callers remain scope-free. Sources: [independent-resource decision](../../.okf/decisions/core/independent-resource-lifetimes.md), [scope-free root callers](../../.okf/decisions/core/scope-free-root-callers.md), [resource contract](../../.okf/contracts/resources-and-authority.md).

## Recommended implementation decisions

1. Treat this as a behavior-preserving refactor. Record that one liveness rule means general token resolution plus explicit operation eligibility policies.
2. Make a token registry own WeakMaps and tagged token states. Give it callbacks for retain/release and publication, so immutable open counts and durable commits remain engine-owned. Do not let an extracted registry perform an independent state installation.
3. Specify the lifecycle transition table before coding. Cover scope closure before acquisition, during commit, after publication, admission rejection, interruption, commit rejection and unavailable-volume cleanup. Keep offset and access facts separate from the lifecycle tag.
4. Extract resolution with a transition-aware node getter and identity. Preserve authorization and diagnostic context, symlink budget, trailing slashes, missing-parent creation and absolute-path treatment of a base handle. A static captured `VolumeState` must not hide nodes created in a current draft.
5. Keep public tests unchanged. Direct module tests should prove the token/lifecycle transition table and mode result invariants; existing operation-family tests remain the proof of externally visible check precedence.

These recommendations follow the requested module split without changing public signatures, token lifetime, error codes or durable cleanup. No external library or new filesystem standard is needed: the unsettled questions concern the boundaries between existing accepted repository contracts.

## Phased implementation plan

1. **Fix the design boundary.** Record the liveness versus eligibility distinction, preserve invalid file-base rejection, and specify lifecycle transitions. Keep the proposed three public internal modes, but allow a callback-backed recursive-parent traversal policy: recursive `mkdir` currently uses `lookup.createMissing`, and `Node`, `Parent`, and `OrCreate` alone cannot express that behavior. The engine must keep ownership of each created node and the transition. Source: [engine `LookupOptions`, `lookup`, and recursive `mkdir`](../../packages/core/src/internal/virtualFileSystem.ts).
2. **Extract token resolution first.** Replace `referencedNode`, `handleNode`, directory-base lookup and `addressable` with registry outcomes over a supplied node getter. Keep watch's named-scope check explicit. Add direct authenticity, foreign-volume, removed-directory and retained-file tests. Keep reference interning and key resolution behavior. Sources: [engine](../../packages/core/src/internal/virtualFileSystem.ts), [reference-key tests](../../packages/core/test/Volume.test.ts).
3. **Extract traversal and creation resolution.** Return tagged root/node/existing-entry/missing-entry results rather than optional node/parent/name combinations. Preserve diagnostic context and authorization. Preserve caller-specific ordering around `expected`, `expectedChild`, exclusivity and symlink traversal: `openEntry` performs conditional guards before the exclusive check/direct symlink following, while the entry form of `writeFile` currently checks exclusive after traversal. Sharing mechanics does not require reordering these checks. Source: [engine `openEntry` and `writeFile`](../../packages/core/src/internal/virtualFileSystem.ts).
4. **Move lifecycle into the registry.** Replace independent mutable flags with the agreed lifecycle union and route explicit close and cleanup through one release operation. Retain engine callbacks for transition-local retention, reclamation, after-install publication and durable cleanup. Add direct transition tests alongside the existing race tests. Sources: [engine `acquireHandle`, `releaseFile`, `closeFile`, `finalizeFile`](../../packages/core/src/internal/virtualFileSystem.ts), [FileHandle tests](../../packages/core/test/FileHandle.test.ts).
5. **Remove dispatch casts and validate.** Use real TypeScript overload wrappers for `open` and `remove`; moving the resolver alone cannot establish their overload return types. Run type checking, the unchanged core suite and repository-required checks; review all call sites and confirm there is one token-resolution rule and no `as Caller[...]` cast. Source: [Caller signatures](../../packages/core/src/VirtualFileSystem.ts), [engine dispatch](../../packages/core/src/internal/virtualFileSystem.ts), [issue acceptance criteria](https://github.com/lloydrichards/effect-virtual-fs/issues/241).

The parent investigation ran the unchanged full core suite successfully: 24 files and 572 tests passed with `bun run --cwd packages/core test`. This establishes a baseline, not proof that the planned extraction preserves races or failure ordering. At investigation time, `packages/core/test/LiveVolume.test.ts` had unrelated local changes. Those changes were no longer present when implementation began; this work has not edited existing public tests.

## Accepted lifecycle transitions

| Current state                                | Event                                           | Next state                                                                                |
| -------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `acquiring`                                  | Acquisition publishes                           | `open` with inode.                                                                        |
| `acquiring`                                  | Scope cleanup before publication                | `releasedPendingCommit` without inode.                                                    |
| `releasedPendingCommit` without inode        | Cleanup reruns before publication               | The release request remains pending.                                                      |
| `releasedPendingCommit` without inode        | Acquisition publishes late                      | `releasedPendingCommit` with inode; the handle stays unavailable.                         |
| `open`                                       | Explicit file close waits or stages its release | `open` until installation. Admission refusal or waiting interruption leaves it retryable. |
| `open` or `releasedPendingCommit` with inode | Release publishes                               | `closed`; the engine releases and reclaims through its callback.                          |
| Pending acquisition without inode            | Acquisition fails and cleanup completes         | `closed`.                                                                                 |
| `closed`                                     | Scope cleanup reruns                            | `closed`, with no second inode release.                                                   |

Directory release publishes its local closed state before reclamation so a rejected cleanup cannot leave the handle usable. File release normally publishes after installation; its failure fallback completes local cleanup. The existing public lifecycle tests continue to exercise durable commit races.

Removing the dispatch casts also exposed two inferred type problems: acquisition coordination must remove the transition-local `Draft` requirement, and unbounded recursive removal must not inherit a bounded walk's `LimitExceeded` failure. The coordinator now has its own output environment type, and the walker takes a typed limit policy. `open` and `remove` use ordinary overload wrappers over their traced dispatch functions.

Final review added a regression for exclusive entry writes through a symlink to a directory. The extracted resolver initially returned `AlreadyExists`; the original engine returned `IsDirectory` before checking exclusivity. The direct test failed before the resolver correction and passed afterward. A temporary differential comparison then matched 768 cases against the original engine for error codes and paths, successful results, file content, selected metadata, and usage. It covered both open and writeFile, path and three entry-directory addressing forms, all creation modes, both final-symlink settings, eight child states, and privileged versus search-denied callers. This comparison does not replace the retained public lifecycle race tests.

## Implementation validation

The final repository suite passed 1,164 tests across 42 files. Core includes 33 new direct module tests; the existing public tests remain unchanged.

Commands that passed:

- `bun run build`, including documentation generation and runnable examples.
- `bun run type-check`, including the core public type contracts.
- `bun run lint`.
- `bun run lint:effects`, with existing unstable-API warnings and one informational message about the generic walk error.
- `bun run format:check`.
- `bun scripts/check-generated-api.mjs`.
- `bun run test`.
- `git diff --check`.
- `.agents/skills/okf/scripts/check.sh architecture/volume-caller-handle-model decisions/core/explicit-close-and-scope-cleanup decisions/core/path-base-selection decisions/core/public-api-targets-services-and-errors decisions/core/recursive-tree-operations`.

OKF validation reports no issues, broken links, or isolated concepts. Evaluation retains the existing duplicate-title finding for the two tree-transfer concepts. The refactor changes no public behavior or signature, so it requires no changeset.
