---
"@effect-vfs/core": patch
---

`applySnapshotDelta` now orders directory entries by byte value regardless of the runtime.

Applied snapshots previously sorted entry names with `localeCompare`, so the same delta could yield differently ordered entries on ICU and non-ICU Node builds. Entries now follow the byte order used everywhere else in the delta layer. Deltas themselves are unaffected, since they never carried entry order.
