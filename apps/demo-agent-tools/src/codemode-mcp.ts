import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunStdio from "@effect/platform-bun/BunStdio"
import { Cause, Effect, Layer } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { codeModeHandlers, CodeModeTools } from "./codemode.js"

const stdio = McpServer.layerStdio({
  name: "effect-vfs-codemode",
  version: "0.0.0",
  protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18]
}).pipe(Layer.provide(BunStdio.layer))

const server = Effect.scoped(Effect.gen(function*() {
  const handlers = yield* codeModeHandlers

  return yield* Layer.launch(
    McpServer.toolkit(CodeModeTools).pipe(
      Layer.provide(CodeModeTools.toLayer(handlers)),
      Layer.provide(stdio)
    )
  )
})).pipe(Effect.provide(BunCrypto.layer))

BunRuntime.runMain(
  server.pipe(Effect.catchCause((cause) =>
    Effect.sync(() => {
      if (Cause.hasInterrupts(cause)) return
      process.stderr.write(`${Cause.pretty(cause)}\n`)
      process.exitCode = 1
    })
  )),
  { disableErrorReporting: true }
)
