---
"@effect-vfs/core": minor
---

`Search.glob` finds snapshot paths with Unicode-aware globs and reports coverage and skipped entries. Use `Search.scanGlob` to stream paths.

```ts
import { Search, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Effect, Stream } from "effect"

const program = Effect.gen(function*() {
  const volume = yield* Vfs.fromFixture({
    entries: [{ kind: "file", path: "/😀.ts", bytes: new Uint8Array() }]
  })
  const snapshot = yield* volume.snapshot
  const query = { root: "/", include: ["?.ts"] } as const
  const report = yield* Search.glob(snapshot, query)
  const paths = yield* Stream.runCollect(Search.scanGlob(snapshot, query))
  return { report, paths }
})

Effect.runPromise(program.pipe(Effect.provide(BunCrypto.layer))).then(console.log)
```
