# Regular-file I/O contract proposal

Status: researched proposal, 8 September 2026. No implementation or executed tests. This narrows POSIX-H05 through POSIX-H11 in the [profile ledger](posix-profile.md).

## Accepted inputs and remaining choices

The user accepted per-inode stored-byte accounting and per-entry namespace limits. Hard-link names therefore share the content charge. Explicit privilege and JSON/base64 snapshots are also accepted, but do not decide I/O transfer behavior.

The rules below distinguish verified standards requirements from recommended project policy. API names, numeric ranges, and cancellation details still need an implementation contract.

## Verified Issue 8 rules

Direct public HTML retrieval succeeded through `curl` on 8 September 2026 after the web tool returned 403. The page headers identify Issue 8 and IEEE Std 1003.1-2024. The relevant DESCRIPTION, RETURN VALUE, and ERRORS sections were read in full for `write`, `ftruncate`, `close`, and `lseek`.

- Capacity-limited write must transfer the available prefix. Positional writes use the supplied position and preserve the handle offset, including with append enabled. Nonempty successful writes mark modification/status timestamps; zero-length writes may check errors. [write/pwrite, DESCRIPTION and ERRORS](https://pubs.opengroup.org/onlinepubs/9799919799/functions/write.html)
- Truncate requires writable access, preserves the offset, zero-fills growth, and leaves the file unchanged on failure. Successful regular-file truncation marks modification/status timestamps even when length is unchanged. Clearing set-ID bits is permitted. [ftruncate, DESCRIPTION](https://pubs.opengroup.org/onlinepubs/9799919799/functions/ftruncate.html)
- Closing the last handle releases an unlinked file. Invalid close fails with `EBADF`. Issue 8 separately specifies signal-interrupted close outcomes; these do not define Effect interruption. [close, DESCRIPTION and ERRORS](https://pubs.opengroup.org/onlinepubs/9799919799/functions/close.html)
- Relevant descriptor operations, including write, positional I/O, seek, truncate, and close, have mutually atomic specified effects. [XSH 2.9.7](https://pubs.opengroup.org/onlinepubs/9799919799/functions/V2_chap02.html#tag_16_09_07)

## Recommended capacity algorithm

This algorithm is a project design derived from the accepted accounting model. POSIX does not prescribe this storage formula.

For a nonempty regular-file write, let:

- `L` be the current file length.
- `F` be unused volume byte capacity under the chosen accounting policy.
- `O` be the operation's destination offset.
- `N` be the requested byte count.
- `M` be the maximum permitted file length.

Set `B = min(M, L + F)` and `K = min(N, max(0, B - O))`, using checked arithmetic. `K` is the prefix length that fits. This assumes regular-file charge equals logical length, including zero-filled gaps. Confirm that assumption when defining “stored bytes”; sparse storage is deferred.

If `K > 0`, commit those bytes once and return `K`. Charge only `max(0, O + K - L)`. If `K = 0`, report the applicable capacity or size error without mutation. Resolve overlapping error causes with a documented project ordering.

This has useful consequences:

| Scenario                                                       | Expected result under this proposal                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Four-byte file, two bytes of spare quota, append five bytes    | Return 2; length becomes 6.                                                                                    |
| Same file, full quota, overwrite two bytes at offset 1         | Return 2; length and charge remain unchanged.                                                                  |
| Four-byte file, two spare bytes, write one byte at offset 6    | Fail without growing the file. The gap consumes all spare capacity.                                            |
| Four-byte file, three spare bytes, write two bytes at offset 6 | Return 1; length becomes 7, including the two-byte gap.                                                        |
| Two hard-link names for one file                               | Writing through either uses the same `L` and content charge.                                                   |
| Last name removed while a handle is open                       | Retain its content charge until final close; otherwise repeated unlink/open sequences evade the logical quota. |

The last row is accepted in [decision 0009](../decisions/0009-volume-capacity-accounting.md). Entry removal releases
the name charge while retained content still consumes bytes. Logical gap accounting remains a recommendation.

Use an `ENOSPC`-equivalent failure for volume capacity and `EFBIG`-equivalent failure for maximum file length. These names identify backend distinctions; they do not require numeric errno values. Entry exhaustion affects creation, not an overwrite through an existing handle. Handle-count limits remain separate.

## Operation boundaries

Recommend one mutation boundary for each transfer. Compute destination, allowable prefix, byte changes, length, quota, metadata, and resulting position against the same committed state.

For append, choose the destination inside that boundary. Separate handles must not both reserve the same previous EOF. For positional I/O, do not change the stored position as an intermediate step.

A short successful transfer and an atomic operation are compatible: the committed operation consists of exactly the returned prefix. A retry is a new operation. A helper that loops until all bytes are written needs a separate contract describing partial progress before a later failure.

Recommend validating the handle, access mode, and numeric arguments before the zero-length fast path. Then return zero without changing bytes, length, quota, position, or timestamps. This resolves the permitted validation choice and avoids append moving a cursor on an empty request.

For Effect interruption, propose an interruptible wait for the mutation boundary and an uninterruptible commit. Scope cleanup must close retained handles. The API documentation must still explain how a caller learns the outcome when interruption arrives immediately after commit; atomicity alone does not promise successful result delivery or rollback.

## Truncate and close

Recommend all-or-error truncation. Preflight the whole growth charge. A failed growth preserves bytes, length, metadata, and position; shrinking releases the removed logical bytes. Choose `EBADF` for a handle without writable access and `EFBIG` for a size beyond the configured file maximum, among the standard's permitted alternatives. Negative length maps to `EINVAL`.

Volume-quota growth failure needs an `ENOSPC`-equivalent project extension: the `ftruncate` ERRORS list does not name it. Issue 8 allows additional errors unless an operation explicitly disallows them. Record this as a profile extension, not a listed `ftruncate` error. [XSH 2.3, Error Numbers](https://pubs.opengroup.org/onlinepubs/9799919799/functions/V2_chap02.html#tag_16_03)

Accepted [decision 0013](../decisions/0013-explicit-close-and-scope-cleanup.md) makes public close strict and scope
cleanup privately tolerant of prior release. Explicit-close-then-scope-exit succeeds; repeated explicit close fails.
Do not implement finalization by swallowing arbitrary errors.

Serialize close against handle operations. If a transfer commits first, its result precedes close; if close commits first, the transfer fails the lifetime check. Release an unlinked inode's quota exactly once after its final handle closes. Foreign-volume handles should fail validation before mutation, with a documented backend error.

## Dense-file seek proposal

Include `SEEK_DATA` and `SEEK_HOLE` using the dense-file interpretation permitted by Issue 8. For `0 <= offset < length`, DATA returns `offset` and HOLE returns `length`. At or beyond EOF, both fail with `ENXIO`; failure leaves the position unchanged. Zero bytes within content need not be classified as holes. [lseek, DESCRIPTION and ERRORS](https://pubs.opengroup.org/onlinepubs/9799919799/functions/lseek.html)

Reject negative offsets for these modes as project input policy before lookup. Ordinary SET/CUR/END continue to allow positions beyond EOF subject to the supported integer range. File-size capacity is charged by growth, not seeking.

## Focused proof cases

These cases are proposed; none has run.

1. Quota crossing, zero-room failure, full-quota overwrite, and gap accounting using the table above.
2. Append from competing handles, asserting final bytes, returned counts, and resulting handle positions under a permitted serial order.
3. Positional write on an append handle, asserting supplied placement and unchanged stored position.
4. Short transfer followed by retry failure, preserving the earlier successful prefix.
5. Quota-limited truncate failure, successful shrink, and same-length timestamp behavior.
6. Last unlink followed by open-handle I/O and final close, checking byte charge and exactly-once release.
7. Explicit close then scoped cleanup; repeated explicit close; close racing a transfer.
8. DATA/HOLE on empty, nonempty, and zero-containing files, including unchanged position on errors.

## Exact points still open

- Maximum file length and transfer size, integer representation, and overflow error policy.
- Whether logical length is the byte charge for regular files and how symlink targets are charged. Open-unlinked byte retention is already accepted.
- Foreign-volume handle error and same-handle concurrent operation result shape. Public close policy is accepted in decision 0013.
- Commit-result delivery under Effect interruption, including an interrupted scoped acquisition after the handle has been created.
- Timestamp precision and special-bit policy. The standard permits clearing set-ID bits on write/truncate; this proposal does not choose when.
- Whether to accept the dense-file seek proposal. No sparse allocation tracking is needed for it.
