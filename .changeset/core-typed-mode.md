---
"@effect-vfs/core": minor
---

`Metadata` exports `typedMode` and the file-type constants `S_IFMT`, `S_IFREG`, `S_IFDIR` and `S_IFLNK`. `Metadata.mode` still holds permission bits only; `typedMode` joins it with the bits for the object's `kind` to give the POSIX `st_mode`.

```ts
import { S_IFDIR, S_IFMT, typedMode } from "@effect-vfs/core/Metadata"

const stMode = typedMode(yield* caller.stat("/src")) // 0o40755
const isDirectory = (stMode & S_IFMT) === S_IFDIR
```
