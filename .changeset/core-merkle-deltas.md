---
"@effect-vfs/core": minor
---

Snapshot deltas now contain one change per changed path, and snapshot identities have new values. Deltas saved by earlier releases no longer decode or validate. Recompute stored deltas from the snapshots they connect:

```ts
const fresh = yield * Vfs.diffSnapshots(base, target)
const bytes = yield * Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(fresh)
```

`maxDeltaRecords` now counts changes. `maxOutputRecords` and `maxInheritedRecords` limit nodes in the applied target and nodes retained from the base. These limits are checked when you create or apply a delta, so review any custom limits before upgrading.
