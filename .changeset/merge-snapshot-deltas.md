---
"@effect-vfs/core": minor
---

Merge two snapshot deltas from one base with `mergeSnapshotDeltas`, which takes every undisputed change, combines metadata fields changed on one side with content changed on the other, and reports path-level conflicts as data instead of failing ([#174](https://github.com/lloydrichards/effect-virtual-fs/issues/174)).

```ts
const program = Effect.gen(function*() {
  const { delta, conflicts } = yield* Vfs.mergeSnapshotDeltas(base, ours, theirs)
  const merged = yield* Vfs.applySnapshotDelta(base, delta)
  const settled = yield* Vfs.mergeSnapshotDeltas(base, ours, theirs, {
    resolutions: conflicts.map((conflict) => ({ path: conflict.path, take: "theirs" }))
  })
})
```
