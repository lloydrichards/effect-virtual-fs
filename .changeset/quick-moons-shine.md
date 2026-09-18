---
"@effect-vfs/memory": minor
---

Add `MemoryFileSystem.makeCrypto` and `MemoryFileSystem.layerCrypto`, self-contained variants that carry their own `Crypto` implementation. An in-memory filesystem no longer needs a platform crypto layer:

```ts
import { MemoryFileSystem } from "@effect-vfs/memory"
import { Effect, FileSystem } from "effect"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem

  return yield* fs.exists("/tmp")
}).pipe(Effect.provide(MemoryFileSystem.layerCrypto))
```

The built-in implementation mints the volume's identity and incarnation from a reproducible sequence, not a cryptographically secure one. `make` and `layer` are unchanged and still take a `Crypto.Crypto` service, so use those with `NodeCrypto`, `BunCrypto`, or your own implementation when those values must be unpredictable.
