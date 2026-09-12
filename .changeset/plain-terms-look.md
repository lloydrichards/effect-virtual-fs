---
"@effect-vfs/core": minor
---

Create, inspect, Schema-encode, decode, and apply portable snapshot deltas with finite resource policies and Effect's
platform-neutral `Crypto.Crypto` service for base identity.

For example:

```ts
const delta = yield * Vfs.diffSnapshots(base, target)
const bytes = yield * Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)
const restored = yield * Vfs.applySnapshotDelta(
  base,
  yield * Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(bytes)
)
```
