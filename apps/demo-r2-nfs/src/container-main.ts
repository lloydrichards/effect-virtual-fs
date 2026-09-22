import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer"
import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { loadConfig } from "./config.js"
import { serveHttp } from "./container-http.js"
import { gateway } from "./gateway.js"

const mountPoint = "/mnt/r2"

class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly command: string
  readonly code: number
}> {}

const program = Effect.scoped(Effect.gen(function*() {
  const config = yield* loadConfig()

  const readOnly = (yield* Config.schema(Schema.Literals(["0", "1"]), "NFS_MOUNT_READ_ONLY").pipe(
    Config.withDefault("0")
  )) === "1"

  const live = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const runCommand = Effect.fn("R2Demo.runCommand")(function*(command: string, args: ReadonlyArray<string>) {
      const code = yield* spawner.exitCode(ChildProcess.make(command, args, { stdout: "inherit", stderr: "inherit" }))

      if (code !== 0) return yield* new CommandFailed({ command, code })
    })

    yield* gateway(config)
    yield* fs.makeDirectory(mountPoint, { recursive: true })

    const options = ["nfsvers=4.1", "tcp", "sec=sys", `port=${config.port}`, "actimeo=1"]

    if (readOnly) options.push("ro")

    yield* runCommand("mount", ["-t", "nfs", "-o", options.join(","), "127.0.0.1:/", mountPoint]).pipe(
      Effect.timeout("30 seconds")
    )
    yield* Effect.addFinalizer(() =>
      runCommand("umount", [mountPoint]).pipe(
        Effect.catch((error) => Effect.logWarning(`Could not unmount ${mountPoint}: ${error.message}`))
      )
    )

    yield* Effect.log(`Mounted Effect VFS at ${mountPoint}`)
    yield* Effect.log(`Mounted entries: ${(yield* fs.readDirectory(mountPoint)).join(", ")}`)

    return yield* Layer.launch(
      serveHttp(config.volumeOptions.volume.maxFileBytes).pipe(
        Layer.provide(BunHttpServer.layer({ port: 8080 }))
      )
    )
  })

  return yield* live.pipe(Effect.provide(Layer.merge(
    BunServices.layer,
    BunSocketServer.layer({ host: "127.0.0.1", port: config.port })
  )))
}))

BunRuntime.runMain(program)
