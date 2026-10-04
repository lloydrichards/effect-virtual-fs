---
"@effect-vfs/memory": minor
---

`FileSystemTesting` observes or rejects selected filesystem calls while delegating successful operations to real storage.

For example, count string writes through the `writeFile` handler:

```ts
const observeWrites = (base: FileSystem.FileSystem) =>
  FileSystemTesting.make(
    base,
    Effect.fnUntraced(function*() {
      const writes = yield* Ref.make(0)
      return { state: writes, handlers: { writeFile: () => Ref.update(writes, (count) => count + 1) } }
    })
  )
```
