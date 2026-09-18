import { MemoryFileSystem } from "@effect-vfs/memory"
import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer } from "effect"

const memoryLayer = MemoryFileSystem.layer.pipe(Layer.provide(BunCrypto.layer))

Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem.makeDirectory("/workspace", { recursive: true })
  yield* fileSystem.writeFileString("/workspace/hello.txt", "Hello from @effect-vfs/memory")
  yield* Console.log(yield* fileSystem.readFileString("/workspace/hello.txt"))
}).pipe(Effect.provide(memoryLayer), BunRuntime.runMain)
