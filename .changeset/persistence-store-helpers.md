---
"@effect-vfs/persistence": minor
---

Persistence errors now name the full entry point in `operation`, such as `CheckpointStore.load` instead of `load`. Update comparisons against `CheckpointError.operation` and `VfsError.operation`:

```ts
// Before
error.operation === "load"

// After
error.operation === "CheckpointStore.load"
```

The live stores use names such as `SqliteLiveImageStore.loadOrCreate` and `R2LiveImageStore.loadOrCreate` instead of a bare store name.
