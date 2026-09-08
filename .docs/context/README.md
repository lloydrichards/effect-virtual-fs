# VirtualFileSystem development context

Research baseline: 8 September 2026. Implementation status: 9 September 2026. The private directory-only
core, including rename/removal, is implemented; the complete public API and release profile remain unfinished.

## Start here

1. Read the [decision register](decisions.md) for accepted choices and remaining work.
2. Read the [design](../design/VirtualFileSystem-design.md) for the underlying behavior and exclusions, refined by those decisions.
3. Read the [first implementation evidence](first-core-implementation.md) for current behavior and checks.
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

The user confirmed the design direction, authorized research and context documentation, and subsequently
authorized the first private directory implementation.
Accepted decisions 0001-0021 refine the design; exact signatures and unresolved policy questions remain open.
The design plus accepted decisions define current scope. Decision 0007 adds a bounded virtual-package acceptance
milestone, with release gating still open. The older [research](../design/VirtualFileSystem-research.md) records exploration
and includes goals that the design subsequently deferred. Its FUSE/Vim implementation sequence is not the current plan.

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

Baseline commits include `623416d` for the memory package, `cdf83c3` for the core placeholder and scratchpad,
and `5e93650` for the imported design and research. The working tree was clean before this documentation work.

- [`@effect-vfs/core`](../../packages/core/README.md) exports the directory-only VirtualFileSystem module.
  Its package remains private at `0.0.0`; 36 core behavior tests pass. See the
  [directory namespace evidence](directory-namespace-implementation.md).
- [`@effect-vfs/memory`](../../packages/memory/README.md) is configured at `0.1.0` and implements Effect's existing
  service. Publication status has not been checked. Effect is pinned to `4.0.0-rc.112`.
- The memory package contains a shared contract suite and memory-specific tests. Its build script includes browser
  bundling and NodeNext type compatibility checks. These are distinct from runtime tests in browsers or workers.
- [CI](../../.github/workflows/pr-validation.yml) defines formatting, lint, type-check, test, and build commands.
- The [scratchpad](../../apps/scratchpad/src/index.ts) exercises the current memory adapter, not standalone core.
- [Pinned reference repositories](../references.md) are optional research inputs. They were not bootstrapped for this
  pass. The original exploratory POSIX and acceptance-test files are absent from this checkout.

The initial documentation pass installed no workspace dependencies or filesystem tests. A later isolated workspace
copy established the initial evidence. Baseline cleanup subsequently installed repository dependencies and added
bun.lock; the configured checks now pass. Prototype checks are also included in CI. The imported counts of
100 passes, four expected failures, and 28 TODOs describe a different checkout. They establish no current core coverage.

The initial documentation pass checked 36 local file links; subsequent passes check the expanded document set.
Markdown formatting is checked with the configured
`markdown-0.20.0.wasm` plugin through a temporary Markdown-only configuration. The initial full formatter was blocked by a malformed plugin URL. Baseline cleanup corrected the URL and the full
format check now passes.

## Stable boundaries

The dependency direction will be `@effect-vfs/memory` to `@effect-vfs/core` to Effect. Core must not depend on the
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
