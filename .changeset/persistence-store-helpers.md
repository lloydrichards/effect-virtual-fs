---
"@effect-vfs/persistence": minor
---

Every persistence failure names its entry point in `operation`. `CheckpointError.operation` is now `CheckpointStore.save`, `CheckpointStore.load` or `CheckpointStore.migrate` instead of `save`, `load` or `migrate`. The `VfsError`s `CheckpointStore` raises, including snapshot encode and decode failures, name `CheckpointStore.make`, `CheckpointStore.save` or `CheckpointStore.load` instead of `load`, `encodeSnapshot` or `decodeSnapshot`. The live stores report `SqliteLiveImageStore.layer`, `SqliteLiveImageStore.loadOrCreate`, `R2LiveImageStore.layer`, `R2LiveImageStore.loadOrCreate` or `R2LiveImageStore.fromS3` instead of the bare store name.

```ts
// before
if (error._tag === "CheckpointError" && error.operation === "load") {}
// after
if (error._tag === "CheckpointError" && error.operation === "CheckpointStore.load") {}
```

A live-store commit that lands after another commit froze the store no longer unfreezes it.
