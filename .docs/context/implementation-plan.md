# Implementation and evidence plan

Status: proposed sequence, 8 September 2026. No core implementation is authorized by this documentation plan alone.
Use the [decision register](decisions.md) and [POSIX profile](posix-profile.md) to resolve contracts before coding.

Product choices from the discussion are now recorded in decisions 0002-0021. The review artifacts are the
[public interface draft](public-api-draft.md) and [regular-file I/O proposal](posix-io-contract.md). Their proposed
names and technical policies are not accepted merely because they appear in examples.

The [interface and data model prototype](../contracts/README.md) now passes against the exact pinned dependencies,
including ten negative call cases and executable data-model checks. This closes the initial composition check, not the full API design or any
behavioral gate below. Keep it aligned with subsequent interface decisions, then replace it with real package imports.

## Evidence rules

Each supported requirement needs a source or project decision, an observable example, a test, and an execution result.
Suggested ledger fields are `requirement ID`, `source section`, `applicability`, `decision`, `test name`, `command`,
`result`, and `source revision`. Keep source verification and implementation status in separate fields.

- An absent API is a gap. A TODO is a plan. An expected failure is an unmet requirement.
- Start a behavior change with a focused regression that fails for the expected behavior, not an import or setup error.
- For new APIs, first establish the test entry point; record when an initial failure merely reflects missing API shape.
- Compare applicable POSIX behavior against native operations only where the host implements the selected requirement.
  The Effect Node adapter's synthesized cursor is not an oracle for backend offsets.
- Record host and runtime versions for differential checks. A host disagreement may be a permitted alternative or host
  deviation; resolve it using the selected standard before changing the contract.
- Use deterministic concurrency coordination rather than sleeps. Assert observable state and failures, not lock choice.
- Keep backend, adapter, snapshot, and consumer evidence separate so one green suite cannot hide another missing layer.

The [first core slice](first-core-slice.md) narrows the opening work to construction and directories. It does not
remove later namespace or file-I/O requirements, and lists the decisions still needed before coding.

## Development slices

| Slice                                | Work                                                                                                                                                                           | Completion evidence                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0. Contracts and baseline            | Resolve the first decisions, draft public use examples, select the supported operation/flag list, and install the pinned workspace dependencies when beginning development.    | Recorded decisions; reviewed API examples; current memory tests and configured checks run with exact results.                                                                              |
| 1. Volume and caller identity        | Introduce private core construction, owned bytes, namespace identity, caller contexts, precise errors, and basic path operations. Preserve directory identity as paths change. | Two callers share files but retain separate cwd/credentials. Renaming a cwd does not redirect it to a replacement directory at the old path. Failed mutations leave state consistent.      |
| 2. Handles and namespace semantics   | Implement open modes, lifetime, positional and sequential I/O, seeking, append, truncation, links, rename, and distinct unlink/rmdir operations.                               | Core offset requirements pass; independent opens, unlink while open, zero-filled gaps, link identity, and failure atomicity have focused tests.                                            |
| 3. Permissions, metadata, and limits | Complete the selected profile, including traversal permissions, namespace permission checks, timestamps, capacity accounting, and selected partial-transfer behavior.          | Requirement ledger has executable cases for supported behavior and exact error distinctions. Rejected operations preserve the promised state.                                              |
| 4. Effect adaptation                 | Make memory bind core while preserving its public API and conveniences. Resolve watch publication for every writer.                                                            | Existing shared and memory-specific suites pass through core. Add focused tests for shared-volume bindings and direct-core changes visible through the adapter.                            |
| 5. Fixtures and snapshots            | Add atomic fixture loading, isolated capture, a versioned codec, validation, and fresh-volume restoration.                                                                     | Overwrite-after-capture, hostile inputs, byte names, metadata, hard-link topology, independent restores, capacity failures, and concurrent rename/capture cases pass.                      |
| 6. Standalone consumer               | Build and rebuild a virtual entry module with a relative dependency through public core APIs. Demonstrate saving encoded snapshot bytes through an external storage service.   | Assert both bundles reflect their respective dependency contents; missing imports fail clearly; no source tree is copied to host disk. Snapshot save/read/decode/load round-trip succeeds. |
| 7. Release evidence                  | Review the implemented profile and exclusions; verify package boundaries and runtime claims.                                                                                   | Applicable ledger rows have current evidence; configured type-check, test, lint, format, and build checks pass. Run actual target-runtime tests before claiming runtime validation.        |

These slices are dependency guidance, not separate release promises. Permission and error requirements must inform
path/handle design from the start, even if their exhaustive coverage arrives in slice 3. `@effect-vfs/core` remains
private until the release evidence exists. The memory release order follows [decision 0001](../decisions/0001-package-boundaries.md).

## High-value regressions

After the basic consumer case, [decision 0007](../decisions/0007-virtual-package-acceptance.md) adds a virtual package
import milestone. Record its supported resolution subset and prove the selected package comes from the volume.
Its status as a first-release gate remains open.

Prioritize behavior that can look correct in simple read/write tests while violating the design:

- Resolve symlinks before processing later `..` components; enforce directory traversal for trailing separators.
- Truncate below a core handle's offset without moving it; preserve the adapter's distinct cursor behavior.
- Append atomically at current EOF and update the appropriate core offset; positional I/O leaves the ordinary offset alone.
- Close or unlink one reference without invalidating unrelated live references.
- Distinguish permission failure, wrong file kind, missing entry, invalid handle, and capacity exhaustion.
- Preserve separate byte names that replacement decoding would collapse.
- Keep a captured snapshot unchanged after an in-place overwrite of the original volume.
- Charge hard-linked bytes once, retain charges for unlinked open files, and reclaim them at the defined lifetime boundary.
- Make a snapshot concurrent with rename describe one consistent namespace.

## Current validation boundary

This documentation pass inspects source and external references. It does not execute the existing memory suite, install
dependencies, add core tests, or prove conformance. During implementation, use the commands in the root
[`package.json`](../../package.json) and [CI workflow](../../.github/workflows/pr-validation.yml); record focused test
commands alongside the relevant requirement instead of copying historical run counts into new evidence.

## Subsequent baseline execution

The [preimplementation evidence](preimplementation-evidence.md) supersedes the initial no-execution status above.
An isolated copy passes 89 memory tests but fails the full configured baseline. Resolve the recorded setup, lint,
and type-check failures before starting core. Dependency-tree samples are measured; the final path bound remains open.

The subsequent [baseline cleanup](baseline-cleanup.md) resolves those setup, lint, and type errors. Frozen install,
formatting, lint, contract checks, type-check, 89 memory tests, and build pass locally.

## First implementation execution

The user subsequently authorized the private directory slice. Its [implementation evidence](first-core-implementation.md)
records 27 passing core tests, actual-package consumers, and the configured checks. Slice 0 is complete for this
boundary. Slice 1 has directory identity, caller authority, owned paths, and scoped references; file sharing and
cwd identity across rename still require the namespace/I/O work. The memory adapter remains independent.

## Directory namespace execution

The continued implementation request authorized later slices. Directory rename/removal now preserve cwd identity
across rename, update parent ancestry and link counts, retain removed handles, enforce namespace permissions, and
reclaim entry quota. The [namespace evidence](directory-namespace-implementation.md) records nine additional cases
and the pending I/O capacity question. This completes directory identity across rename in slice 1 and part of
slice 2; file sharing, regular-file handles, links, adapter migration, and snapshots remain absent.
