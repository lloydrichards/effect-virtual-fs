import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { NfsServer } from "@effect-vfs/nfs"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const capacityGate = Bun.env["EFFECT_VFS_NFS_CAPACITY_GATE"] === "1"

const program = Effect.scoped(
  Effect.gen(function*() {
    const volume = yield* Vfs.fromFixture({
      entries: [
        { kind: "directory", path: "/notes" },
        { kind: "file", path: "/hello.txt", bytes: new TextEncoder().encode("hello from Effect VFS\n") },
        { kind: "hardLink", path: "/hello-alias.txt", target: "/hello.txt" },
        { kind: "file", path: "/notes/live.txt", bytes: new TextEncoder().encode("agents may update me\n") },
        { kind: "symlink", path: "/latest", target: "notes/live.txt" }
      ]
    }, capacityGate ? { maxBytes: ByteSize.mebibytes(16), maxEntries: 100 } : undefined)

    const caller = yield* volume.caller()
    yield* Effect.forkScoped(
      Effect.gen(function*() {
        let revision = 1

        while (true) {
          yield* Effect.sleep("2 seconds")
          revision += 1
          yield* caller.writeFile(
            "/notes/live.txt",
            new TextEncoder().encode(`live revision ${revision}\n`),
            { access: "write", truncate: true }
          )
        }
      })
    )
    yield* caller.root

    const server = yield* NfsServer.make({
      volume,
      caller
    })

    const listening = "path" in server.address
      ? server.address.path
      : `${server.address.host}:${String(server.address.port)}`

    yield* Effect.log(`NFS preview listening at ${listening}`)
    yield* Effect.log("Mount separately on macOS:")
    yield* Effect.log(
      "sudo mount_nfs -o vers=4.1,tcp,sec=sys,port=2049,actimeo=1,noowners 127.0.0.1:/ /Volumes/effect-vfs-nfs-preview"
    )

    return yield* Effect.never
  })
).pipe(
  Effect.provide(Layer.merge(
    BunCrypto.layer,
    BunSocketServer.layer({ host: "127.0.0.1", port: 2049 })
  ))
)

BunRuntime.runMain(program)
