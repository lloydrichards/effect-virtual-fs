---
"@effect-vfs/core": minor
---

Search snapshot content with `Search.lines`, `Search.files`, or `Search.countLines`. Each returns a report with coverage and skipped entries. Their `scan*` counterparts stream results.

```ts
import { Search, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Effect, Stream } from "effect"

const program = Effect.gen(function*() {
  const volume = yield* Vfs.fromFixture({
    entries: [{ kind: "file", path: "/note.ts", bytes: new TextEncoder().encode("// TODO: finish\n") }]
  })
  const snapshot = yield* volume.snapshot
  const query = {
    root: "/",
    include: ["**/*.ts"],
    pattern: Search.Pattern.cases.Literal.make({ pattern: "TODO" })
  } as const
  const report = yield* Search.lines(snapshot, query)
  const paths = yield* Stream.runCollect(Search.scanFiles(snapshot, query))
  return { report, paths }
})

Effect.runPromise(program.pipe(Effect.provide(BunCrypto.layer))).then(console.log)
```
