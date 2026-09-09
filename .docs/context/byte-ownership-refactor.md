# Byte ownership refactor

9 September 2026. Follow-up audit of `refactor/implementation`, starting at `07313f6`.
The earlier [implementation refactor](implementation-refactor.md) already addressed lookup options,
copy policy, mode authorization, and snapshot encoding. Independent core, adapter, and snapshot audits
found no new confirmed defect. The fresh baseline executed all 190 tests.

## Whole-file storage

`writeFile` copied its input at execution and then copied that owned buffer into another allocation,
even when those bytes were the complete new contents. It now commits the captured buffer directly
when the write covers the complete result. Partial overwrite and append still allocate and merge
with existing contents. A storage helper or copy-on-write representation would add machinery without
improving this local ownership transfer.

Input copying remains before the permit wait. Capacity, authority, and timestamp checks still precede
publication. Existing inode identity, alias events, and failed-replacement behavior are unchanged.
This is an allocation removal, with no measured write-throughput or RSS claim.

| Test or cluster                | Observable behaviour                                                                      | Current owner | Decision | Evidence and risk                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ------------- | -------- | --------------------------------------------------------------------------- |
| `WholeFile.test.ts`            | Each execution captures independent bytes; reads own their buffers                        | contract      | keep     | New public test fails when the input copy is deliberately removed           |
| `Replacement.test.ts`          | Failed replacement preserves state; successful replacement preserves quotas and authority | regression    | keep     | Existing regressions exercise the unchanged preflight and publication rules |
| Adapter copy and cursor suites | Copy identity/events and intentionally different cursor semantics                         | adapter       | keep     | These contracts remain distinct from core storage ownership                 |

No existing tests were deleted or merged. The coordinator, resolver, finalizer ordering, adapter cursor,
and public `replaceFinalSymlink`/`finalMode` controls remain because they protect accepted contracts.

## Fixture declarations

Fixture construction previously stored an entry and optional encoded data in an intermediate array.
The file branch later used `data ?? ""`, hiding the invariant that every file had already been encoded.
It now encodes bytes directly into the file declaration. Keeping a second discriminated representation
would also remove the fallback, but would retain an unnecessary intermediate collection.

All file buffers are still checked before path validation. Successful declaration construction is
synchronous, so encoding produces immutable strings before yielding the image for validation. The
temporary byte copy before synchronous encoding is unnecessary. Forward hard links, metadata defaults,
strict image validation, and independent restoration remain unchanged.

`FixtureOwnership.test.ts` is a separate contract test for execution-time capture of subarray views,
repeated construction, later input mutation, and independent volumes. Existing fixture/snapshot tests
remain intact. Deliberately encoding the whole backing buffer made the new test fail on extra bytes;
the source was restored. Independent review found no regression in either implementation slice.

## Measurement

The unchanged `node apps/virtual-build/src/measure.ts` command ran in separate sequential Node 24.10.0
processes on macOS arm64 before and after this follow-up. Both runs processed 2,431 files containing
50,721,951 source bytes and produced 68,108,683 encoded bytes, with identical package versions and no
forced collection. The workload exercises fixture construction and snapshots, not `writeFile`.

| Metric               | Before              | After               |
| -------------------- | ------------------- | ------------------- |
| Process peak RSS     | 2,170,142,720 bytes | 2,021,982,208 bytes |
| Fixture construction | 1,399.14 ms         | 1,421.73 ms         |

Peak RSS was 6.8% lower in this single pair; fixture construction was slightly slower. These results
do not establish a repeatable speedup or attribute all memory variation to the removed allocation.
RSS covers preparation and the entire pipeline, including retained inputs. The exact
[before](../evidence/byte-ownership-refactor/before.json) and
[after](../evidence/byte-ownership-refactor/after.json) measurements preserve the comparison.

## Validation

Frozen installation passed without dependency or lockfile changes. Formatting, Oxlint, dedicated Effect
diagnostics, documentation compilation, and executable model checks passed. Forced builds, types, and
tests passed with zero Turbo cache hits. The first slice passed 191 tests; the final suite passed 192,
comprising 75 core, 114 memory, and three consumer tests. No existing tests were deleted or renamed.

The new ownership tests were each checked against a deliberate production regression, then rerun with
the correct source. These probes demonstrate test sensitivity; neither was a newly discovered defect.
[Evidence](../evidence/byte-ownership-refactor/results.json) records the commands and retained red logs.

Tools remain Bun 1.4.0, Node 24.10.0, and pinned Effect 4.0.0-rc.112. Bun 1.2.21 and Linux CI were not run.
The browser-target smoke executes under Node; no browser runtime was tested. Dprint passed despite
a denied write to its optional external incremental cache. Packages remain private. There are no
unresolved API decisions or remaining changes from this bounded audit.
