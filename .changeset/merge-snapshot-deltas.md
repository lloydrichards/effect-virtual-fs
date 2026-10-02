---
"@effect-vfs/core": minor
---

`mergeSnapshotDeltas` combines changes from two deltas built against the same base snapshot. Conflicts appear in the result, and `resolutions` can select either side for each conflict.

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const volume = yield* Vfs.fromFixture({ entries: [] })
  const base = yield* volume.snapshot
  const ours = yield* Vfs.makeOverlay(base)
  const theirs = yield* Vfs.makeOverlay(base)
  const bytes = new TextEncoder().encode("hello")
  yield* (yield* ours.caller()).writeFile("/ours.txt", bytes, { access: "write", create: "exclusive" })
  yield* (yield* theirs.caller()).writeFile("/theirs.txt", bytes, { access: "write", create: "exclusive" })
  const result = yield* Vfs.mergeSnapshotDeltas(
    base,
    yield* Vfs.diffSnapshots(base, (yield* ours.capture()).snapshot),
    yield* Vfs.diffSnapshots(base, (yield* theirs.capture()).snapshot)
  )
  const merged = yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(base, result.delta))
  return new TextDecoder().decode(yield* (yield* merged.caller()).readFile("/theirs.txt"))
})

Effect.runPromise(program.pipe(Effect.provide(BunCrypto.layer))).then(console.log)
// hello
```
