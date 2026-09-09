# VirtualFileSystem development context

Research baseline: 8 September 2026. Implementation status: 9 September 2026. The accepted private milestones are
implemented and locally validated. Start with the [implemented profile and evidence ledger](implemented-profile.md)
for the current API, limits, tests, exclusions and runtime caveats. Earlier slice documents are dated evidence.

## Start here

1. Read the [decision register](decisions.md) for accepted choices and remaining work.
2. Read the [design](../design/VirtualFileSystem-design.md) for the underlying behavior and exclusions, refined by those decisions.
3. Read the [first implementation evidence](first-core-implementation.md) for the original directory behavior and checks.
4. Use the documents below for evidence, unresolved decisions, and implementation gates.

| Document                                                   | Use it when                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [POSIX profile](posix-profile.md)                          | Defining an operation's behavior, errors, or tests.                            |
| [I/O contract research](posix-io-contract.md)              | Resolving partial transfers, append, positional writes, truncation, and close. |
| [Public interface draft](public-api-draft.md)              | Reviewing construction, service provision, handles, and proposed operations.   |
| [Permissions and metadata](permissions-and-metadata.md)    | Defining access checks, privilege exceptions, and metadata changes.            |
| [Effect compatibility](effect-compatibility.md)            | Reusing current code or adapting core into Effect's `FileSystem`.              |
| [Snapshots and consumers](snapshots-and-consumers.md)      | Designing persistence, byte ownership, capacity, or build acceptance.          |
| [Decision register](decisions.md)                          | Preparing API proposals or discussing unresolved product choices.              |
| [Implementation and evidence plan](implementation-plan.md) | Choosing a development slice and its completion checks.                        |

See the [snapshot validation contract](snapshot-validation-contract.md) when implementing image decoding and restoration.

For the next development boundary, use the [first core slice](first-core-slice.md). It lists the initial operations,
accepted contracts and observable evidence required before widening implementation.

Use the [path and directory-base contract](path-and-base-contract.md) for input representation and lookup-base decisions.

The [consolidated first-core review](first-core-contract-review.md) groups the remaining initial contracts into one
proposal. Sections 1-4 are accepted under decision 0020; decision 0021 resolves the path-length gate.

The [preimplementation evidence](preimplementation-evidence.md) records current dependency-tree measurements,
89 passing memory tests, and the initial baseline failures. The [baseline cleanup](baseline-cleanup.md) now records
a passing configured check sequence.

## Authority and evidence

The [Effect modeling research](effect-modeling.md) explains where interfaces, Schema, and Data fit, using the exact
pinned library source. Decision 0014 records the approved modeling approach; individual constraints remain proposals.

[Interface declarations, models, and consumers](../contracts/README.md) now check the proposed interface against the pinned
Effect and TypeScript versions. This verifies composition and selected type rejections, not filesystem behavior. Executable model checks also verify field constraints and the documented snapshot roundtrip.

For detailed interface review, use the [resource and byte contract](resource-and-byte-contract.md) and
[fixture/snapshot format example](snapshot-format-draft.md). They turn open engineering choices into concrete
proposals without marking them accepted or implemented.

The user authorized the design, initial directory slice, and then continued implementation and commits through all
accepted milestones. Decisions 0001-0021 plus [implementation policy 0022](../decisions/0022-remaining-implementation-profile.md)
define the private profile. The basic and bounded-package consumer gates both pass. Older research/prototype
signatures remain historical proposals; use actual exports and the implemented profile for new work.

Use these labels consistently:

- **Scope commitment:** behavior required by the design, still to be implemented.
- **Source observation:** behavior found in this checkout, with a symbol or test pointer.
- **Verified reference:** a requirement or integration detail checked against an external primary source.
- **Recommendation:** a proposed choice, awaiting a recorded decision.
- **Open:** a question without a settled answer or sufficient evidence.
- **Historical evidence:** a previous run described in the imported research, not rerun here.

Research proposals do not override the design or accepted decisions. Record accepted choices in `.docs/decisions/`, then update the affected
context documents and tests. If a normative requirement conflicts with a proposed convenience, resolve the profile
or API explicitly before implementation.

## Current repository

- The [implementation refactor](implementation-refactor.md) records subsequent internal simplifications,
  comparable snapshot memory measurements, and review findings. Earlier validation remains dated evidence.

- Core is private at 0.0.0 and memory is private at 0.1.0. Effect remains pinned to 4.0.0-rc.112.
- The core, memory and consumer suites pass, including the subsequent [review regressions](review-fixes.md). The memory suites run through core.
- The private Vite app imports built package exports. See [consumer evidence](consumer-implementation.md).
- [Latest review validation](../evidence/review-fixes/results.json) records the configured checks. Browser-target bundling plus a Node
  smoke is distinct from browser runtime testing. Linux CI and the repository-pinned Bun 1.2.21 were not executed here.
- The local run used Bun 1.4.0 and Node 24.10.0 without upgrading existing dependencies.
- Historical first-slice, baseline and research documents preserve the checks and open questions from their dates.

## Stable boundaries

The dependency direction is `@effect-vfs/memory` to `@effect-vfs/core` to Effect. Core must not depend on the
memory adapter or host filesystem services.

| Owner             | Responsibility                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Volume            | Namespace, file identity, contents, metadata, capacity accounting, and mutation coordination.            |
| Caller context    | Credentials, supplementary groups, directory identity for cwd, and umask. Defaults are host-independent. |
| Handle            | Volume association, access mode, offset, and lifetime. Separate opens have independent offsets.          |
| Memory adapter    | Effect cursor compatibility, string API behavior, `PlatformError` translation, and adapter conveniences. |
| Snapshot codec    | Versioned, validated representation of persistent state. No live handles or caller state.                |
| External consumer | Host persistence or build integration, using public APIs.                                                |

Core includes regular files, directories, symlinks and hard links, a bounded POSIX profile, fixtures, isolated snapshots,
and a virtual module build/rebuild demonstration. Mounts, FUSE/Vim, network filesystems, overlay, host tree import/export,
special files, advisory locks, descriptor duplication, restricted roots, copy-on-write optimization, and crash durability
remain deferred.

## Keep this context useful

Before a development task, read only this index and the relevant contract documents. Check the current source before
relying on the dated baseline. Link new tests to requirement IDs and record the exact command and result when claiming
coverage. Keep proposed tests separate from executed evidence. Update the decision register when a question is settled;
do not let an implementation default silently become policy.
