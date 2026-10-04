---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
---

Scoped `Caller.withRoot` confines paths, references, handles, and watches to a directory identity. `MemoryFileSystem.bindCaller` preserves that boundary, working directory, credentials, and umask.

```ts
const agent = yield * admin.withRoot("/workspaces/run-42")
const fs = yield * MemoryFileSystem.bindCaller(agent)
yield * fs.writeFileString("/output.txt", "done")
```

Existing hard links may share contents across roots. `withDirectory` keeps its working-directory meaning. Scoped temporary cleanup follows renamed directories and never removes a replacement at the original path. Custom structural Caller implementations must provide the new `withRoot`, `watch`, and `limits` members.
