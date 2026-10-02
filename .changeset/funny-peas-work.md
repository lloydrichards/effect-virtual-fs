---
"@effect-vfs/memory": minor
---

`MemoryFileSystem.layerFromFixture` provides a filesystem layer from an existing core fixture ([#244](https://github.com/lloydrichards/effect-virtual-fs/issues/244)).

```ts
const seeded = MemoryFileSystem.layerFromFixture({
  entries: [{ kind: "file", path: "/hello.txt", bytes: new TextEncoder().encode("hello") }]
})
```
