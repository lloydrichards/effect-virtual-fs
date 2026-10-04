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

    const owner = yield* volume.caller()
    const work = yield* owner.withRoot("/workspace")
    const fileSystem = yield* MemoryFileSystem.bindCaller(work)

    // The borrowed binding follows the assigned directory through rename.
    yield* owner.rename("/workspace", "/renamed-workspace")

    return fileSystem
  })
)

const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem

  yield* fileSystem.writeFileString("/hello.txt", "Hello from @effect-vfs/memory") // echo "Hello from @effect-vfs/memory" > /hello.txt
  yield* Console.log(yield* fileSystem.readFileString("/hello.txt")) // cat /hello.txt

  const config = yield* fileSystem.readFileString("/package.json") // cat /package.json
  yield* Console.log(config)
})

BunRuntime.runMain(program.pipe(Effect.provide(SeededMemoryFileSystem.pipe(Layer.provide(BunCrypto.layer)))))
