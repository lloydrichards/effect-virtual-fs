import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { MemoryFileSystem } from "@effect-vfs/memory"
import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Schema } from "effect"

const utf8 = new TextEncoder()

const Config = Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String }))

const SeededMemoryFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function*() {
    const volume = yield* Vfs.fromFixture({
      entries: [
        { kind: "directory", path: "/workspace" },
        {
          kind: "file",
          path: "/workspace/package.json",
          bytes: utf8.encode(yield* Schema.encodeEffect(Config)({ name: "example", version: "1.2.3" }))
        }
      ]
    })

    return yield* MemoryFileSystem.bind(volume)
  })
).pipe(Layer.provide(BunCrypto.layer))

const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem

  yield* fileSystem.makeDirectory("/workspace", { recursive: true }) // mkdir -p /workspace
  yield* fileSystem.writeFileString("/workspace/hello.txt", "Hello from @effect-vfs/memory") // echo "Hello from @effect-vfs/memory" > /workspace/hello.txt
  yield* Console.log(yield* fileSystem.readFileString("/workspace/hello.txt")) // cat /workspace/hello.txt

  const config = yield* fileSystem.readFileString("/workspace/package.json") // cat /workspace/package.json
  yield* Console.log(config)
})

BunRuntime.runMain(program.pipe(Effect.provide(SeededMemoryFileSystem)))
