---
"@effect-vfs/core": minor
---

`typedMode` combines `Metadata.kind` and permission bits into a POSIX `st_mode`. `Metadata.mode` continues to contain permission bits only.

```ts
import { S_IFDIR, S_IFMT, typedMode } from "@effect-vfs/core/Metadata"

const stMode = typedMode(yield * caller.stat("/src"))
const isDirectory = (stMode & S_IFMT) === S_IFDIR
```
