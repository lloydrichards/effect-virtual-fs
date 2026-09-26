---
"@effect-vfs/core": minor
---

`Caller` can walk a tree, create missing directories recursively, and remove a directory tree. Recursive `mkdir` applies all created directories together; recursive `remove` stops at the first failure.

```ts
yield * caller.mkdir("/work/src/lib", { recursive: true })
const entries = yield * Stream.runCollect(caller.walk("/work"))
yield * caller.remove("/work", { recursive: true })
```

`walk` reports symbolic links without following them and accepts depth, entry, and byte limits. `remove` with `force` ignores only a missing target, not a missing descendant.
