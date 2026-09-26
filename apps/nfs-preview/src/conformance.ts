import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { NfsServer } from "@effect-vfs/nfs"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * Serves a fixture shaped like the pynfs `--maketree` layout with generous client and
 * session limits, so an external suite that opens a fresh client per test does not hit
 * the preview's small default capacities. Read-only: the suite must run with `--noinit`.
 */
const port = 2049

const program = Effect.scoped(
  Effect.gen(function*() {
    const volume = yield* Vfs.fromFixture({
      entries: [
        { kind: "directory", path: "/tmp" },
        { kind: "directory", path: "/tree" },
        { kind: "directory", path: "/tree/dir" },
        { kind: "file", path: "/tree/file", bytes: new TextEncoder().encode("this is the file test data\n") },
        { kind: "symlink", path: "/tree/link", target: "/tree/file" }
      ]
    })

    const caller = yield* volume.caller()

    const server = yield* NfsServer.make({
      volume,
      caller,
      leaseDurationSeconds: 10,
      limits: {
        maxClients: 4096,
        maxPendingClientReplacements: 64,
        maxSessions: 4096,
        maxOpens: 8192
      }
    })

    if ("path" in server.address) {
      return yield* Effect.die(new Error("pynfs needs a TCP port, but the fixture is bound to a UNIX-domain socket"))
    }

    yield* Effect.log(`NFS conformance fixture listening at ${server.address.host}:${server.address.port}`)
    yield* Effect.log(
      `pynfs: nfs4.1/testserver.py 127.0.0.1:${server.address.port}/ --minorversion 1 --security sys --noinit --nocleanup --force all noreboot nocourteous`
    )

    return yield* Effect.never
  })
).pipe(
  Effect.provide(Layer.merge(
    BunCrypto.layer,
    BunSocketServer.layer({ host: "127.0.0.1", port })
  ))
)

BunRuntime.runMain(program)
