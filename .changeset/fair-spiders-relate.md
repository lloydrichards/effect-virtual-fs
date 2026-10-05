---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
---

`Caller.withRoot` confines a caller's paths, references, handles, and watches to a directory. `MemoryFileSystem.bindCaller` exposes that caller as an Effect `FileSystem` with the same root, working directory, credentials, and umask.

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { MemoryFileSystem } from "@effect-vfs/memory"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const volume = yield* Vfs.make()
  const admin = yield* volume.caller()
  yield* admin.mkdir("/workspace")
  const agent = yield* admin.withRoot("/workspace")
  const fs = yield* MemoryFileSystem.bindCaller(agent)
  yield* fs.writeFileString("/output.txt", "done")
  return yield* admin.readFile("/workspace/output.txt")
}).pipe(Effect.scoped)
```

The root follows the directory's identity after a rename. Existing hard links can still share file contents across roots. `withDirectory` continues to change only the working directory.

Scoped temporary cleanup follows renamed directories and preserves replacements at the original path. Custom structural `Caller` implementations must provide `withRoot`, `watch`, and `limits`.
