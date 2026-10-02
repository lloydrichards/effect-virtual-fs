---
"@effect-vfs/memory": minor
---

`MemoryFileSystem.layerFromFixture` creates an Effect `FileSystem` layer from core fixture entries.

```ts
import { MemoryFileSystem } from "@effect-vfs/memory"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Effect, FileSystem } from "effect"

const seeded = MemoryFileSystem.layerFromFixture({
  entries: [{ kind: "file", path: "/hello.txt", bytes: new TextEncoder().encode("hello") }]
})
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString("/hello.txt")
})

Effect.runPromise(program.pipe(Effect.provide(seeded), Effect.provide(BunCrypto.layer))).then(console.log)
// hello
```
