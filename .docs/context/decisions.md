# Decision register

Current implementation update (9 September 2026): the accepted core milestones are implemented and locally
validated. Checkpoint persistence under decision 0025 is implemented.
The [implemented profile](implemented-profile.md) supersedes the historical core statuses and open questions
below; policy 0022 records remaining core implementation choices. Earlier text preserves the research/sequence history.

Status: 9 September 2026. Accepted decisions below refine the original design; proposals in research and
interface drafts remain proposals. The [directory-only core](first-core-implementation.md) and
[directory rename/removal](directory-namespace-implementation.md) are implemented.
Earlier descriptions of open questions record what each decision left unsettled at that point.

## Accepted direction

| Topic                   | Accepted choice                                                                                                       | Record                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Packages                | Core met its evidence gate; publish core 0.1.0 before memory 0.1.0 because memory depends on core.                    | [0001](../decisions/0001-package-boundaries.md)               |
| Access styles           | Explicit objects plus a thin optional Effect service layer, both available initially.                                 | [0002](../decisions/0002-explicit-api-and-effect-services.md) |
| String filename results | Fail with structured errors when a required filename cannot be represented faithfully. Preserve raw-byte access.      | [0003](../decisions/0003-strict-string-filename-boundary.md)  |
| Privilege               | Explicit caller setting independent of user/group IDs; default caller is privileged.                                  | [0004](../decisions/0004-explicit-caller-privilege.md)        |
| Snapshot identity       | Preserve hard-link relationships through image-local IDs; runtime inode numbers may change.                           | [0005](../decisions/0005-snapshot-local-identity.md)          |
| Snapshot encoding       | JSON/base64 initially; measure dependency-heavy Vite project trees.                                                   | [0006](../decisions/0006-json-base64-snapshots.md)            |
| Consumer acceptance     | Basic module build/rebuild first, then a bounded package import from virtual `node_modules`.                          | [0007](../decisions/0007-virtual-package-acceptance.md)       |
| Fixtures                | Order-independent final-state declarations, predictable metadata defaults, validation before exposure.                | [0008](../decisions/0008-final-state-fixtures.md)             |
| Capacity                | Per-inode file-content bytes and per-name entries; retain unlinked-open content charges; snapshot memory is separate. | [0009](../decisions/0009-volume-capacity-accounting.md)       |
| Rebuild triggering      | Explicit build calls initially; automatic watching is a follow-up integration.                                        | [0010](../decisions/0010-explicit-build-rebuilds.md)          |

These records settle their stated portions of the earlier D01-D16 questions. They do not settle every related detail.

[Decision 0011](../decisions/0011-independent-resource-lifetimes.md) accepts independent caller/handle lifetimes,
open-time file access, and invoking-caller authority for metadata changes and ordinary directory-base lookup.
Exact construction and close/error policies remain open; byte and snapshot-schema proposals are not accepted by it.

[Decision 0012](../decisions/0012-copying-byte-ownership.md) subsequently accepts execution-time input copying and
independent read buffers. Detailed capture timing, shared-memory policy, and snapshot schema remain open.

[Decision 0013](../decisions/0013-explicit-close-and-scope-cleanup.md) accepts invalid-handle failure for repeated
explicit close and scope cleanup that tolerates prior release. Error shape and operation ordering remain open.
The virtual package milestone's first-release gating is the remaining product scheduling choice; it need not block
core contract work. Full virtual package resolution, installation, and arbitrary plugin support are not accepted scope.

[Decision 0014](../decisions/0014-schema-data-and-capability-modeling.md) accepts schema-derived data models,
Data errors, and capability interfaces for the documentation prototype. It does not accept every proposed schema
constraint. The [snapshot validation contract](snapshot-validation-contract.md) separates field decoding from
complete image validation and details the remaining codec work.

[Decision 0015](../decisions/0015-strict-snapshot-v1-decoding.md) accepts canonical base64 and decimal integer
spelling and rejection of unknown fields at every schema-defined object level for version 1. Graph validation,
numeric ranges, error mapping, and validation order remain open.

[Decision 0016](../decisions/0016-scope-free-root-callers.md) accepts root callers without Scope or public close;
derived callers and directory handles remain independently scoped. Defaults and path/base rules remain open.

[Decision 0017](../decisions/0017-path-base-selection.md) accepts ignoring directory bases for absolute paths and
requiring live, same-volume bases for relative paths. Invoking-caller authority applies in both cases. Path-input
representation, limits, and detailed error precedence remain open.

[Decision 0018](../decisions/0018-path-input-policy.md) accepts strict UTF-8 string input, exact byte paths, rejection
of empty/NUL/lone-surrogate input, runtime-independent separators, lookup-time dot resolution, and root clamping.
Path limits, shared backing, raw symlink targets, and exact error mapping remain open.

[Decision 0019](../decisions/0019-provisional-path-limits.md) retains 255 component bytes and 40 symlink traversals
as provisional defaults. The earlier 4096-byte total path recommendation is deferred pending dependency-tree
measurements; it is not an accepted limit.

[Decision 0020](../decisions/0020-first-core-contracts.md) accepts the consolidated first-slice contracts. The remaining
initial work is dependency-tree measurement and pinned baseline verification; later-feature questions below stay open.

[Decision 0021](../decisions/0021-optional-total-path-limit.md) accepts optional maxPathBytes, omitted by default,
with explicit input and expansion counting. This resolves the initial total-path policy gate; the local baseline
is green. The first directory implementation now has [executed evidence](first-core-implementation.md).

## Engineering contracts still to settle

Preserve the original D IDs so existing references remain useful. The next step is concrete proposals supported by
source evidence, rather than another round of broad preference questions.

| ID  | Settled portion                                             | Remaining work and expected artifact                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D01 | Both access styles, separate volume/caller/handles.         | Review [interface examples](public-api-draft.md); specify operation/flag whitelist, directory references, and seek modes. The [initial declaration check](../contracts/README.md) passes; complete the remaining variants before implementation. |
| D02 | Strict filename results.                                    | Specify input validation for lone surrogates, byte-path ownership, error mapping, raw symlink targets, and watch-stream reporting.                                                                                                               |
| D03 | Explicit privilege with a privileged default.               | Complete the [permission and metadata matrix](permissions-and-metadata.md): owner/group selection, search and namespace checks, sticky/set-ID rules, group inheritance, metadata changes, and privilege exceptions.                              |
| D04 | Basic capacity accounting.                                  | Use [I/O research](posix-io-contract.md) to specify short transfers, no-progress errors, quotas versus maximum file size, append, positional writes, and cancellation.                                                                           |
| D05 | JSON/base64 and image-local IDs.                            | Specify envelope/version, exact base64 rules, numeric fields, decoder failures, and evolution policy. No binary format comparison is needed for the first codec.                                                                                 |
| D06 | Snapshot isolation is required.                             | Define copy timing for lazy Effects, owned read buffers, path bytes, fixture inputs, snapshot inspection, and shared-memory input restrictions.                                                                                                  |
| D07 | Separate content/entry quotas.                              | Choose gap and symlink accounting, root/dot-entry rules, inode/handle/decoder limits, and numeric defaults after workload measurements.                                                                                                          |
| D08 | Supported timestamps survive snapshots.                     | Define representation, precision, clock dependency, and per-operation update matrix, including zero-length I/O and metadata-only operations.                                                                                                     |
| D09 | Scoped resources and explicit close are required.           | Set caller/directory lifetime, cross-volume handles, repeat-close behavior, removed cwd behavior, and scope-finalizer policy. Type signatures alone do not prevent use after scope exit.                                                         |
| D10 | Atomic namespace operations and consistent capture.         | Specify commit points and cancellation outcomes. Review partial I/O separately; a multi-call sequence is not a transaction.                                                                                                                      |
| D11 | Structured backend failures; separate Effect mapping.       | Write code/tag and context shapes plus a mapping table. Distinguish typed failure, defects, interruption, and snapshot decoding errors.                                                                                                          |
| D12 | Existing memory watches and conveniences survive migration. | Define committed mutation notifications from every consumer, ordering and overflow, and helper operation boundaries.                                                                                                                             |
| D13 | Final-state fixtures.                                       | Choose fixture syntax, hard-link references, parent declarations, exact defaults, and validation; specify destination-controlled restore limits.                                                                                                 |
| D14 | Explicit rebuild and bounded package milestone.             | Pin tooling and specify the package manifest/module subset. Release gating for the second milestone remains open.                                                                                                                                |
| D15 | Fresh memory construction remains compatible.               | Decide shared-volume binding initialization, `/tmp` handling, optional caller selection, and caller ownership by layers.                                                                                                                         |
| D16 | Core and adapter offset contracts differ.                   | Decide preservation of source-only negative/closed seek behavior. Exact adapter truncation distinctions are in the compatibility audit.                                                                                                          |

## Suggested next contract slices

Use the [consolidated first-core review](first-core-contract-review.md) for one grouped review of the remaining
initial choices. It supersedes the piecemeal review sequence below for that slice; sections 1-4 are now accepted under decision 0020.

The [declaration review](../contracts/README.md) now compiles against the exact pinned Effect and TypeScript versions,
including ten negative call cases. It does not settle proposed numeric types, field names, or omitted operation variants.

The [resource and byte proposal](resource-and-byte-contract.md) now specifies candidate lifetime, authority, input
consumption, and error rules. The [snapshot format example](snapshot-format-draft.md) supplies concrete JSON data.
Review these proposed policies before treating their field names, defaults, or authority rules as accepted.

1. Review the proposed public construction and resource lifetime examples, together with structured errors and byte
   ownership. Do not implement an API that cannot express the accepted ownership model.
2. Finalize I/O and namespace requirements from verified Issue 8 sources. Record implementation choices where the
   standard permits alternatives. Do not ask the user to override a requirement accidentally.
3. Write the permission and timestamp matrices and a concrete JSON fixture/snapshot example. Numeric defaults need
   measurement; proposed numbers are not compatibility promises.
4. Establish the pinned runtime baseline and turn accepted examples into compilation and behavior gates when
   implementation is authorized. Keep the existing memory adapter suite as a separate compatibility gate.

## Recording an answer

Add an accepted decision only for a settled choice. Link its D ID, source basis, concrete example, and required tests.
Technical recommendations can live in contract drafts until reviewed. Update this register and affected context
without erasing historical observations. Keep proposed tests and executed evidence separate.

## Continued implementation

[Implementation policy 0022](../decisions/0022-remaining-implementation-profile.md) records the regular-file choices
used after the user instructed continued implementation through completion. It resolves the capacity question raised
after directory rename/removal without reopening the accepted ownership, authority, or cancellation contracts.

## Adapter timestamp representation

[Decision 0023](../decisions/0023-adapter-timestamp-overflow.md) accepts typed `InvalidData` failures from path and
handle stat when a returned timestamp cannot be represented as a JavaScript Date, preserving core and snapshot values.

## Reusable capability effects

[Decision 0024](../decisions/0024-reusable-capability-effects.md) migrates the seven zero-argument core operations
to reusable Effect properties and records the generator cleanup and narrowed lint exceptions.

## Named checkpoint persistence

[Decision 0025](../decisions/0025-checkpoint-persistence.md) accepts a separate `@effect-vfs/persistence` package
with create-only named checkpoints, required decode limits, application-provided SQLite and an explicit migration.
Bun SQLite passes the separate-process restart check.
