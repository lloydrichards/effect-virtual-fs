# First core implementation slice

Status: implemented directory boundary, 9 September 2026, following the user's start instruction.
See [implementation evidence](first-core-implementation.md). Earlier proposal and open-choice sections below
record the planning sequence; decisions 0020 and 0021 supersede them. This is not a reduced release scope. Use the
[implementation plan](implementation-plan.md) for later slices.

## Intended result

Create a private volume, construct two callers with independent credentials, create directories through one caller,
and resolve them through the other. Derive scoped callers with independent cwd references. Exercise search permission
and directory creation permission through the public API before adding regular-file I/O.

This establishes shared namespace identity, caller authority, lazy execution, and directory resource ownership.
It does not yet satisfy the full first slice in the broader plan: cwd behavior across rename needs the namespace slice.
No placeholder successful implementations should stand in for operations that are not available yet.

## Proposed operation boundary

| Include                              | Purpose                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `VirtualFileSystem.make`             | Create an independent volume with an implicit root directory.           |
| `volume.caller`                      | Create a root-based caller with validated identity and umask.           |
| `pathFromBytes` / `pathToBytes`      | Establish validated path ownership and lossless byte access.            |
| `caller.stat`                        | Observe directory identity and metadata through pathname lookup.        |
| `caller.mkdir`                       | Create one directory, checking its parent and applying creation policy. |
| `caller.withDirectory`               | Acquire a caller with an independently retained cwd.                    |
| `caller.openDirectory`               | Acquire a directory identity usable as a relative lookup base.          |
| `directory.stat` / `directory.close` | Observe handle identity and exercise accepted close semantics.          |
| `CurrentFileSystem` provision        | Prove the same caller works through the optional service.               |

Implement regular-file open/read/write, links, symlinks, rename, removal, metadata mutation, snapshots, fixtures, and
adapter migration in later slices. The resolver must process components in order and have an explicit point for
symlink traversal later. Do not normalize away `..` as a shortcut that would constrain the full implementation.
Directory enumeration is unnecessary for this initial result; `stat` provides the observable namespace checks.

## Construction lifetime

`VirtualFileSystem.make(options)` returns a fresh volume each time its Effect runs. `volume.caller(options)` returns a
root-based caller whose lifetime follows the volume, with no Scope requirement and no public close operation. Root
callers require no separately releasable cwd reference because the volume always owns its root directory.

`withDirectory` returns a scoped caller. Its parent must be live at execution, but the derived caller owns its own cwd
reference. Directory handles similarly own their acquired references. Accepted independent lifetimes and close rules
apply. Root callers do not keep a registry of child callers or handles that must be closed together.

Copy identity group arrays and other mutable configuration at Effect execution, before retaining them. Schema validation
alone is not ownership. Root ownership metadata and caller credentials are separate: creating a caller does not change
the root's owner, group, or mode. Caller construction never grants privilege merely because its uid is zero.

Scope-free root callers are accepted in [decision 0016](../decisions/0016-scope-free-root-callers.md). Derived-resource
independence is accepted in [decision 0011](../decisions/0011-independent-resource-lifetimes.md). Fresh execution and
configuration-capture details above remain proposals where not covered by earlier decisions.

The [consolidated review](first-core-contract-review.md) recommends the remaining defaults, authority checks, error
boundaries, and commit semantics together. Its measurement gate remains explicit.

## Contracts that must be resolved before coding

| Contract          | Existing basis                                                     | Specific remaining choice                                                                                             |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Root construction | Proposal above; [resource contract](resource-and-byte-contract.md) | Exact root and caller metadata defaults; scope-free root callers are accepted.                                        |
| Path input        | Accepted owned bytes and strict string results                     | Shared backing, path limits, and exact failures. Base selection and input policy are accepted in decisions 0017-0018. |
| Directory access  | [permission research](permissions-and-metadata.md)                 | Ordinary mode-bit profile, lookup-only handle checks, and complete `mkdir` parent checks.                             |
| Creation metadata | Permission research                                                | Parent-group inheritance, supported special bits, root defaults, clock source, and timestamp precision.               |
| Errors            | Data error constructors and existing proposed codes                | Map each included operation's failures; define validation ordering only where callers need a guarantee.               |
| Entry capacity    | Accepted per-name accounting                                       | Whether root is charged, zero-limit construction, and rejection before publishing a new directory.                    |
| Coordination      | Accepted consistent mutations and owned inputs                     | Commit/cancellation rules for creation, acquisition, and close.                                                       |

Do not infer acceptance of these details from their TypeScript representation. Numeric defaults remain proposals;
capacity measurements for large workloads are not required to prove explicitly configured small limits.

## Required evidence

These are planned behavior cases, not current test results.

- Run the existing memory suite and configured baseline checks with pinned dependencies before changing its dependency
  path. Record actual results and distinguish setup failures from behavior failures.
- Construct two volumes and prove creating `/work` in one does not create it in the other.
- Construct two callers on one volume and prove a successful `mkdir` is visible to both through `stat`.
- Derive `/work` as one caller's cwd and prove another caller still resolves relative paths from root.
- Exercise an unprivileged uid-zero caller and a privileged nonzero caller under controlled directory modes.
- Reject denied traversal even when the target directory's own permissions would allow access.
- Close a parent derived caller's scope while its child's scope remains live; the child still resolves from its cwd.
- Execute an Effect through a finalized derived caller and observe a typed closed-caller failure.
- Repeat explicit directory close and observe invalid-handle failure; leaving its scope after early close succeeds.
- Reject a foreign or closed directory base for relative paths under decision 0017 without publishing a mutation.
- Mutate the source identity groups and path bytes after capture and prove stored authority/path identity is unchanged.
- Reject invalid input or capacity exhaustion without adding an entry or changing parent metadata.

Use public operations to establish and observe each case. Coordinate lifetime and concurrency tests explicitly. A
compilation check cannot establish resource liveness, isolation, permission enforcement, or cancellation behavior.

The [path and base proposal](path-and-base-contract.md) supplies the next concrete review, with verified Issue 8
evidence and separate project choices.

## Review sequence

Root caller lifetime, base selection, and path-input policy are settled. Next settle path limits and the directory creation matrix, including
metadata and entry accounting. Keep error and cancellation rules beside those operations. Only after those gates are
closed should the first core implementation begin. Broader release requirements remain in the decision register.

The [path-limit proposal](path-limits.md) records provisional component/traversal defaults and the measurements needed before selecting a total path bound.

The latest [path-limit recommendation](path-limits.md) is an optional per-volume bound, omitted by default, based on
both installed-tree measurements and the existing 12,000-byte adapter regression. Decision 0021 accepts it.

## Ready for implementation review

Decisions 0020 and 0021 settle the initial contract package and total-path gate. The
[baseline cleanup](baseline-cleanup.md) records passing local checks. Earlier open-choice tables above are historical
planning context where superseded by those decisions. The user subsequently instructed implementation. The
[implementation report](first-core-implementation.md) records the completed directory slice and remaining work.
