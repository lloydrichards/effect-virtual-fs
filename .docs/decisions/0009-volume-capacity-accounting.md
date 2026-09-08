# Volume capacity accounting

Status: accepted, 8 September 2026. Resolves part of D04 and D07.

## Decision

Use separate limits for stored file-content bytes and directory entries. Count each file's contents once per inode,
regardless of how many hard-link names reference it. Count each directory entry separately.

When a file loses its final name but remains open, retain its byte charge until its last handle closes and the file
can be reclaimed. Snapshot copies and encoding memory are additional costs outside the live volume's quota.

These limits describe logical filesystem usage, not a hard bound on JavaScript heap memory. Numeric defaults will
be chosen after measurement, including dependency-heavy project trees with many small files.

## Example

Three hard-link names reference one 10 MB file. They consume 10 MB of file-content capacity and three directory
entries. Removing two names leaves the content charge unchanged. Removing the final name releases its entry charge,
but an open handle keeps the file content charged until the file is reclaimed.

## Alternatives and basis

Charging content per path would count hard-linked data repeatedly. Releasing byte charges on final unlink would
leave still-accessible open-file storage unaccounted for. The user accepted per-inode content accounting, per-name
entry accounting, and lifetime-aware reclamation instead.

This refines the configurable capacity commitment in the [design](../design/VirtualFileSystem-design.md). It is a
project accounting policy, not a claim that POSIX defines this quota model.

## Remaining contracts and evidence

Decide numeric defaults, zero-filled gap accounting, symlink target charges, name/metadata limits, root and implicit
dot-entry treatment, and any separate inode or handle limits. Partial writes under capacity pressure still need
standards verification and a per-operation contract. This decision does not select all-or-nothing write behavior.

Required tests show that adding hard-link aliases changes entry usage without duplicating content usage, writes
through any alias affect the same content charge, and unlink while open retains charges until reclamation. Verify
entry capacity independently with many small files. Test rejected mutations for consistent accounting after their
commit and failure contracts are settled. See the [capacity research](../context/snapshots-and-consumers.md).

No limits, accounting implementation, benchmarks, or tests were added for this decision.
