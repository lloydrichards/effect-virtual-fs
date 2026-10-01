import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunStdio from "@effect/platform-bun/BunStdio"
import { Cause, Effect, Layer } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { handlersFor, VolumeTools } from "./tools.js"
import { makeWorkspace } from "./workspace.js"

const server = Effect.scoped(Effect.gen(function*() {
  const { caller, baseCaller } = yield* makeWorkspace()

  const tools = McpServer.toolkit(VolumeTools).pipe(
    Layer.provide(VolumeTools.toLayer(handlersFor(caller, baseCaller))),
    Layer.provide(McpServer.layerStdio({
      name: "effect-vfs-agent-tools",
      version: "0.0.0",
      protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18]
    })),
    Layer.provide(BunStdio.layer)
  )

  return yield* Layer.launch(tools)
})).pipe(Effect.provide(BunCrypto.layer))

// Keep stdout exclusively for MCP. Interrupted shutdown runs Effect's scoped finalizers.
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
