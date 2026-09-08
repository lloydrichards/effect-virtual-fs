import { MemoryFileSystem } from "@effect-vfs/memory"
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect, FileSystem } from "effect"

Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem.makeDirectory("/workspace", { recursive: true })
  yield* fileSystem.writeFileString("/workspace/hello.txt", "Hello from @effect-vfs/memory")
  yield* Console.log(yield* fileSystem.readFileString("/workspace/hello.txt"))
}).pipe(Effect.provide(MemoryFileSystem.layer), BunRuntime.runMain)
