---
"@effect-vfs/core": minor
---

Filesystem, snapshot, and snapshot-delta byte limits now use Effect's `ByteSize` type.

Pass values such as `ByteSize.mebibytes(4)` instead of raw byte counts when configuring `VolumeOptions`,
`Snapshot.DecodeLimits`, or `SnapshotDeltaLimits`.
