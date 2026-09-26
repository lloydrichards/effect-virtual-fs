/** Local, single-gateway writable NFS experiment. Never publish this constructor as an NFS profile. */
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { loadConfig } from "./config.js"
import { gateway } from "./gateway.js"

const program = Effect.scoped(Effect.gen(function*() {
  const config = yield* loadConfig()

  const live = Effect.gen(function*() {
    yield* gateway(config)

    yield* Effect.log("Use one gateway only. Unmount before stopping or restarting this process.")

    return yield* Effect.never
  })

  return yield* live.pipe(Effect.provide(Layer.merge(
    BunCrypto.layer,
    BunSocketServer.layer({ host: config.bindAddress, port: config.port })
  )))
}))

BunRuntime.runMain(program)
