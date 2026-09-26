---
"@effect-vfs/core": minor
---

`Volume.watch({ scope })` watches one object and its subtree, following the object through renames. `Volume.watch` is now a function, so existing volume-wide watches must call `volume.watch()`.

```ts
const allChanges = yield * volume.watch()
const work = yield * caller.lookup("/work")
const workChanges = yield * volume.watch({ scope: work })
```

A scoped stream ends when its object loses its last name. Pass `recursive: false` to watch only the object itself.
