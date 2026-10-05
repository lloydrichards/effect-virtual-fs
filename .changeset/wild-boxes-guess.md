---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
"@effect-vfs/persistence": minor
---

Selected core, memory, and persistence APIs now support data-first and data-last calls, including snapshot construction and deltas, transfer sources and sinks, filesystem bindings, and S3 adapter construction.

For example:

```ts
const report = snapshotEffect.pipe(Effect.flatMap(Search.glob(query)))
const volume = entries.pipe(TreeTransfer.toVolume({ owner: true }))
```
