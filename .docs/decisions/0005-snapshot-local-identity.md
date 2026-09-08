# Snapshot-local file identity

Status: accepted, 8 September 2026. Resolves the identity-policy portion of D05.

## Decision

Snapshots use image-local identifiers to represent file identity and hard-link relationships. Restoring a snapshot
may assign fresh runtime inode numbers. Numeric inode values are not persistent identifiers across save and restore.

Multiple directory entries referencing one file in the snapshot must reference one shared file in the restored
volume. Loading the snapshot twice creates independent volumes, each with its own runtime identity namespace.
Fresh allocation is permitted, not required to produce numerically different values from the original volume.

## Example

`/a.txt` and `/b.txt` reference one file. A snapshot stores both entries pointing to the same image record. After
restoration, writing through `/a.txt` changes the contents read through `/b.txt`, regardless of the restored inode
number. Writing in one restored volume does not change another restore or the snapshot.

## Alternatives and basis

Preserving runtime inode numbers would add allocator and collision rules and create a persistent numeric identity
guarantee. The user selected preserved relationships with fresh runtime numbers allowed instead. This settles the
open identifier policy in the [design](../design/VirtualFileSystem-design.md).

## Remaining contracts and evidence

Identifier representation, validation limits, and format evolution remain open. Subsequent
[decision 0006](0006-json-base64-snapshots.md) selects JSON/base64 encoding. This identity decision does
not require stable snapshot record numbering or deterministic encoded bytes.

Required tests restore hard-link aliases and prove shared content and correct link counts within the new volume.
Separate restores must remain independent. Tests must not require original and restored inode numbers to match or
to differ. Link these cases to `POSIX-N04` and `POSIX-M01` in the
[profile ledger](../context/posix-profile.md) and the [snapshot requirements](../context/snapshots-and-consumers.md).
No tests were implemented or run for this decision.
