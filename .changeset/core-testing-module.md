---
"@effect-vfs/core": minor
---

`@effect-vfs/core/Testing` provides a fresh volume and caller for Effect tests, plus helpers for callers with other identities and watch streams.

```ts
import * as Testing from "@effect-vfs/core/Testing"

const test = Effect.gen(function*() {
  const caller = yield* Vfs.Caller
  yield* caller.mkdir("/work")
}).pipe(Effect.scoped, Effect.provide(Testing.layer()))
```
