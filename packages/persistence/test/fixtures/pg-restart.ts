import { LiveVolume } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as PgClient from "@effect/sql-pg/PgClient"
import { ByteSize, Config, Console, Effect, Layer, Redacted } from "effect"
import * as Pg from "../../src/PgLiveImageStore.js"

const program = Effect.gen(function*() {
  const url = yield* Config.String("VFS_PG_TEST_URL")
  const key = yield* Config.String("VFS_PG_RESTART_KEY")
  const mode = yield* Config.String("VFS_PG_RESTART_MODE")

  yield* Effect.scoped(Effect.gen(function*() {
    const volume = yield* LiveVolume.open({
      maxImageBytes: ByteSize.kibibytes(64),
      volume: {
        maxEntries: 100,
        maxBytes: ByteSize.kibibytes(32),
        maxFileBytes: ByteSize.kibibytes(16),
        maxPathBytes: ByteSize.bytes(1024)
      }
    })

    const caller = yield* volume.caller()

    if (mode === "write") {
      yield* caller.writeFile("/acknowledged", new Uint8Array([42]), { access: "write", create: "exclusive" })
      yield* Console.log("acknowledged")

      return yield* Effect.never
    } else {
      const bytes = yield* caller.readFile("/acknowledged")
      yield* Console.log(`restored:${bytes.join(",")}`)
    }
  })).pipe(Effect.provide(
    Pg.layer({
      key,
      maxImageBytes: ByteSize.kibibytes(64)
    }).pipe(Layer.provide(PgClient.layerFrom(PgClient.makeClient({
      url: Redacted.make(url),
      ssl: false,
      multiplex: false
    }))))
  ))
})

await Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer)))
