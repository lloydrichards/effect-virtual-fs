---
"@effect-vfs/core": minor
---

A `Testing` module, importable as `@effect-vfs/core/Testing`, holds three plain Effect helpers for tests with no test-runner dependency: `layer(options?)` provides a fresh volume (empty or seeded from a fixture) and a root caller on it, `callerAs(identity)` makes a caller with other credentials on the volume in context, and `collectChanges(stream, n)` starts collecting a watch stream's first changes and returns an effect that waits for them.

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as Testing from "@effect-vfs/core/Testing"
import { Effect } from "effect"

const test = Effect.gen(function*() {
  const volume = yield* Vfs.Volume
  const changes = yield* Testing.collectChanges(yield* volume.watch, 1)

  yield* (yield* Vfs.Caller).mkdir("/work")

  return yield* changes
}).pipe(Effect.scoped, Effect.provide(Testing.layer()))
```
