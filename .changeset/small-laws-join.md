---
"@effect-vfs/memory": minor
---

`FileSystemTesting.make` adds handlers that observe or reject calls before they reach a backing Effect `FileSystem`.

Count writes while preserving the real file contents:

```ts
import { FileSystemTesting, MemoryFileSystem } from "@effect-vfs/memory"
import { Effect, Ref } from "effect"

const program = Effect.gen(function*() {
  const base = yield* MemoryFileSystem.make
  const { fileSystem, state } = yield* FileSystemTesting.make(
    base,
    Effect.fnUntraced(function*() {
      const writes = yield* Ref.make(0)
      return {
        state: writes,
        handlers: { writeFile: () => Ref.update(writes, (count) => count + 1) }
      }
    })
  )
  yield* fileSystem.writeFileString("/output.txt", "done")
  return yield* Ref.get(state) // 1
})
```

`writeFileString` routes through the `writeFile` handler. Allocate state inside the factory to give each build its own counter.
