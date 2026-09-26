---
"@effect-vfs/memory": minor
---

`TreeTransfer` streams directory trees between callers, snapshots, and new volumes. A transfer to an existing caller destination fails by default and removes a new partial destination if the transfer fails.

```ts
const source = TreeTransfer.fromCaller(sourceCaller, "/project")
yield * Stream.run(source, TreeTransfer.toCaller(workspace, "/workspace"))
```

`MemoryFileSystem.copy` now preserves hard links within a copied tree when overwriting and removes a partial destination on failure when `overwrite` is false.
