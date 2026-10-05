---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
---

Selected core and memory APIs now support data-first and data-last calls.

For example:

```ts
const report = snapshotEffect.pipe(Effect.flatMap(Search.glob(query)))
const volume = entries.pipe(TreeTransfer.toVolume({ owner: true }))
```
