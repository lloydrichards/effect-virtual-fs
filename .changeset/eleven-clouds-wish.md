---
"@effect-vfs/core": minor
---

Search filenames over immutable snapshots with Unicode globs, bounded Streams and coverage reports ([#256](https://github.com/lloydrichards/effect-virtual-fs/issues/256)).

```ts
const collect = Search.glob(snapshot, { root: "/", include: ["**/*.ts"] })
const paths = Search.scanGlob(snapshot, { root: "/", include: ["?.ts"] })
```
