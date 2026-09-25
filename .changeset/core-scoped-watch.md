---
"@effect-vfs/core": minor
---

`Volume.watch` is now a function that takes `{ scope?, recursive? }`. `volume.watch()` is the volume-wide watch it was; `scope` narrows it to one object reference and, unless `recursive` is `false`, its subtree. Changes outside the scope never count toward the subscriber's queue, the scope follows renames of the object and its ancestors, a move out arrives as `Remove` and a move in as `Create`, `Rescan` names the scope's current path, and the stream ends after `Remove` for the object once its last name is gone, even when its queue is full.

```ts
const program = Effect.gen(function*() {
  const volume = yield* Vfs.Volume
  const caller = yield* Vfs.Caller

  // before: yield* volume.watch
  const everything = yield* volume.watch()
  const work = yield* volume.watch({ scope: yield* caller.lookup("/work") })
})
```
