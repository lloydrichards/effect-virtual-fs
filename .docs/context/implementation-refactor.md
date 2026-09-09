# Implementation refactor

9 September 2026. This review started from clean `main` at `c720099`, after the implementation and compatibility
repairs landed. New work belongs to `codex/implementation-refactor`. The original design at `f06c2f0` describes the
outcome; accepted decisions and the implemented profile govern behavior. The completion ledger is historical
evidence, not proof that every edge case works.

## Lookup and copy policy

Internal lookup previously accepted three positional booleans. Calls such as `true, false, true` required reading
the resolver to understand which part of a path they selected. Named options now identify final-symlink following,
missing final entries, and parent lookup. The single traversal algorithm remains because dot components, link
expansion, permission checks, and exact suffix accounting must advance together. Separate resolvers or overloads
would add more places to maintain those rules. The optional lookup result remains internal.

The adapter repeated the atomic content-and-source-mode settings in three regular-file copy branches.
`writeCopiedFile` owns those shared settings. Each call still states whether creation is exclusive, whether a final
symlink is replaced, and which directory supplies the base. Identity checks, recursive traversal, and error mapping
remain with the operation that owns them.

The accepted `writeFile` controls `replaceFinalSymlink` and `finalMode` remain unchanged. A separate copy operation
could replace them publicly, but would change accepted callers and require a compatibility decision. Internally,
the single whole-file commit still protects failed replacement, destination identity, quota reuse, and one update
per reachable alias.

`permittedMode` now shares owner authorization and regular-file set-group-ID filtering between `chmod` and
`writeFile`. The latter computes its final mode before capacity checks and publication, retaining failure order,
creation ownership, and atomic bytes/mode updates. A helper that mutated metadata itself would mix policy with
timestamps and event delivery; returning the permitted mode lets each operation keep its own commit boundary.

## Test and comment audit

| Test or cluster                      | Observable behaviour                                       | Current owner | Decision | Evidence and risk                                                                      |
| ------------------------------------ | ---------------------------------------------------------- | ------------- | -------- | -------------------------------------------------------------------------------------- |
| Core path, link and namespace suites | Traversal order, authority, path bases and atomic mutation | contract      | keep     | Named options preserve the existing resolver; public observations protect its behavior |
| `Replacement.test.ts`                | Atomic replacement, quota reuse and mode authority         | contract      | keep     | These cases protect accepted whole-file controls                                       |
| `AdapterCompatibility.test.ts`       | Root removal and copy state/event preservation             | regression    | keep     | Prior failures justify distinct adapter regressions                                    |
| `CoreBinding.test.ts`                | Shared volumes, watcher conversion and adapter cursors     | adapter       | keep     | Adapter offsets deliberately differ from core offsets                                  |
| `Snapshot.test.ts`                   | Isolation, strict validation and independent restoration   | contract      | keep     | Encoding refactors must preserve the wire format and ownership                         |

No existing tests were deleted, combined or renamed. Their public assertions are useful despite some large cases.
The finalizer-registration and interruption comments remain: they explain ordering that cannot safely be replaced
with routine acquisition boilerplate. The cohesive volume implementation remains together so state, accounting,
publication, and release share one coordinator; file size alone does not justify splitting it.

## Baseline

The forced baseline built successfully and executed all 177 tests. Formatting, lint, documentation compilation,
executable models, and forced workspace types also passed. Frozen installation succeeded using Bun 1.4.0 and Node
24.10.0 without dependency changes. The repository pins Bun 1.2.21; that runtime and Linux CI were not run here.

## Snapshot encoding

The pinned Effect base64 encoder builds its output by concatenating individual characters. Encoding bounded
12,288-byte chunks and joining them avoids retaining those long intermediate string chains across payloads.
The chunk size is a multiple of three so only the final chunk can contain padding. All six fixture/capture
encoding sites use the same internal helper. Input copying, strict validation, snapshot ownership, and the v1
wire format remain unchanged; this is neither a new codec nor copy-on-write storage.

The added public snapshot case checks exact canonical output and independent restoration for patterned bytes
with each possible padding length across chunk boundaries. Changing the chunk size to 12,289 made that test
fail with `InvalidEncoding`; the source was restored immediately. The [red log](../evidence/implementation-refactor/base64-boundary-red.log)
records that targeted proof.

The unchanged `node apps/virtual-build/src/measure.ts` workload ran in separate sequential Node 24.10.0 processes
on macOS arm64, without forced collection. Both runs used 2,431 files, 50,721,951 source bytes, and 68,108,683 encoded
bytes with the same installed package versions. [Before](../evidence/implementation-refactor/snapshot-before.json)
and [after encoding refactor](../evidence/implementation-refactor/snapshot-after-encoding.json) record all phases.

| Metric               | Before              | After encoding refactor |
| -------------------- | ------------------- | ----------------------- |
| Process peak RSS     | 3,056,074,752 bytes | 2,093,056,000 bytes     |
| Fixture construction | 4,357.40 ms         | 1,468.65 ms             |
| Snapshot capture     | 3,405.55 ms         | 1,217.98 ms             |

Peak RSS fell 31.5% in this single pair. These are whole-process measurements including imports, preparation,
retained fixture buffers, and restoration. Preparation was faster in the second run, 276 ms versus 657 ms, so
timings include cache and run-order effects. The result is not a portable performance guarantee or heap bound;
a single large file can still require substantial transient storage.

## Large snapshot decoder repair

A valid snapshot with a 12,000,000-byte file and sufficient decode limits caused `RangeError: Maximum call stack
size exceeded`. The canonical base64 regexp repeated a four-character group across the full payload. The
[public regression failed](../evidence/implementation-refactor/large-decode-red.log) before repair. Validation now
scans the alphabet before the final quartet and checks padding and unused bits only in that bounded quartet.
Unknown fields, graph checks, budgets, error classification, and validation order remain unchanged.

`SnapshotDecoding.test.ts` restores that large payload and rejects malformed alphabets, interior padding, whitespace,
and noncanonical unused bits. The focused snapshot suites then [passed nine tests](../evidence/implementation-refactor/large-decode-green.log).
An independent review also compared public decoding against canonical base64 roundtrips for 1,276 valid and malformed
inputs; it found no mismatch.

A [final benchmark](../evidence/implementation-refactor/snapshot-after-final.json) after this repair reported
1,919,533,056 bytes peak RSS, 37.2% below the same baseline, with identical source and encoded byte counts. Fixture
construction took 1,381.66 ms and capture took 1,188.75 ms. This is another single run with warm input caches;
the difference from the encoding-only result cannot be attributed solely to the decoder repair.

## Final validation

[Recorded commands and exits](../evidence/implementation-refactor/results.json) and sibling logs retain the baseline,
slice checks, and final results. Final builds, types, and tests were forced, with zero Turbo cache hits. All 180 tests
passed: 70 core, 107 adapter, and three virtual-build consumer tests. Formatting, lint, documentation compilation,
and executable model checks passed. The separate independent review ran 14 focused metadata/replacement/decoder
tests and ten snapshot boundary/ownership probes without finding a regression.

Build validation includes the browser-target bundle smoke executed under Node. It does not establish browser/worker
runtime behavior. Linux CI and Bun 1.2.21 remain untested locally. Existing type/build cache use in intermediate logs
is distinct from the forced final results. No dependencies, lockfile, package privacy, or public signatures changed.

## Accepted adapter timestamp policy

The review also reproduced an adapter failure through public APIs: writing a file, assigning core access time
`10n ** 100n` with `caller.utimes`, binding that volume with `MemoryFileSystem.bind`, and calling adapter `stat`
produces a defect, `IllegalArgumentError: Invalid date`. The timestamp is inside the accepted core/snapshot domain,
but outside JavaScript Date's range. The [probe output](../evidence/implementation-refactor/adapter-timestamp-red.log)
records the failure.

The user accepted a typed `InvalidData` failure for the entire stat operation. Path and handle stat now report
the offending atimeNs, mtimeNs, or birthtimeNs field with path/descriptor context. Core timestamps and snapshot
values remain unchanged. Valid Date boundaries and truncation to whole milliseconds retain their existing behavior.
[Decision 0023](../decisions/0023-adapter-timestamp-overflow.md) records the policy and its rationale.

The seven public adapter regressions first reproduced the defect, then passed with the repair. They cover both
overflow signs for all three returned timestamp fields, path and handle stat, unchanged core metadata, exact Date
boundaries, fractional negative milliseconds, and independently owned Date results. ctime is not exposed by Effect
Info and does not participate in this conversion. Evidence is in [timestamp validation](../evidence/adapter-timestamps/results.json).
