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
