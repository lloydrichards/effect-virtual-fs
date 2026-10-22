// Node HTTP and Vite startup are native boundaries; layers own the server and workspace lifetimes.
/* eslint-disable effecttsgo/node-builtin-import, effecttsgo/new-promise */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { Workbench } from "./coordinator.ts"
import { WorkbenchRpc } from "./domain.ts"

const appRoot = fileURLToPath(new URL("../../", import.meta.url))

const production = process.argv.includes("--production")

const handlers = WorkbenchRpc.toLayer(
  Effect.map(Workbench, (workspace) => WorkbenchRpc.of({ command: workspace.command }))
)

const program = Effect.gen(function*() {
  const port = yield* Config.Number("PORT").pipe(Config.withDefault(4310))
  const apiPort = port + 2
  const origin = `http://127.0.0.1:${port}`
  const vite = yield* Effect.promise(() => import("vite"))

  if (production) {
    yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        vite.preview({
          root: appRoot,
          preview: { host: "127.0.0.1", port, strictPort: true, proxy: { "/rpc": `http://127.0.0.1:${apiPort}` } }
        })
      ),
      (server) => Effect.promise(() => new Promise<void>((resolve) => server.httpServer.close(() => resolve())))
    )
  } else {
    const server = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        vite.createServer({
          root: appRoot,
          server: { host: "127.0.0.1", port, strictPort: true, proxy: { "/rpc": `http://127.0.0.1:${apiPort}` } }
        })
      ),
      (server) => Effect.promise(() => server.close())
    )

    yield* Effect.tryPromise(() => server.listen())
  }

  const guard = HttpRouter.middleware((next) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest

      if (request.headers["origin"] && request.headers["origin"] !== origin) {
        return HttpServerResponse.empty({ status: 403 })
      }

      return yield* next
    })
  ).layer

  const api = RpcServer.layerHttp({ group: WorkbenchRpc, path: "/rpc", protocol: "http" }).pipe(
    Layer.provide(handlers),
    Layer.provide(Workbench.layer),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(guard)
  )

  yield* Effect.log(`TypeScript workbench · ${origin}`)

  return yield* Layer.launch(
    HttpRouter.serve(api).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: apiPort, host: "127.0.0.1" })))
  )
})

NodeRuntime.runMain(Effect.scoped(program))
