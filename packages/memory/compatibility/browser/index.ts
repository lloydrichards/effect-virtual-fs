import { Effect } from "effect"
import { MemoryFileSystem } from "../../dist/index.js"

// Keep a real operation reachable so the browser build cannot pass with a discarded implementation.
export const smoke = () =>
  Effect.runPromise(Effect.gen(function*() {
    const fs = yield* MemoryFileSystem.make
    yield* fs.writeFileString("/smoke", "browser bundle")
    return yield* fs.readFileString("/smoke")
  }))
