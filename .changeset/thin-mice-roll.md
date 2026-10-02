---
"@effect-vfs/core": minor
---

Search snapshot content as matching lines, filenames, or exact per-file line counts, with bounded Streams and coverage reports ([#257](https://github.com/lloydrichards/effect-virtual-fs/issues/257)).

```ts
const query = { root: "/", include: ["**/*.ts"], pattern: Search.PatternLiteral.make({ pattern: "TODO" }) } as const
const report = Search.lines(snapshot, query)
const paths = Search.scanFiles(snapshot, query)
```
