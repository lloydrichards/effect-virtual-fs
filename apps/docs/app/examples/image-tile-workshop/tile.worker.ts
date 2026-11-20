import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RpcServer from "effect/rpc/RpcServer"
import { workshopError } from "./domain.ts"
import { filterTile } from "./pixels.ts"
import { TileRpc } from "./protocol.ts"

const handlers = TileRpc.toLayer({
  renderTile: Effect.fnUntraced(function*({ bounds, source, filter }) {
    const canvas = yield* Effect.try({
      try: () => {
        const canvas = new OffscreenCanvas(bounds.width, bounds.height)
        const context = canvas.getContext("2d")

        if (!context) throw new Error("The tile worker could not open a 2D canvas.")

        const pixels = filterTile(source, bounds, filter)
        context.putImageData(new ImageData(pixels, bounds.width, bounds.height), 0, 0)

        return canvas
      },
      catch: workshopError
    })

    return yield* Effect.tryPromise({
      try: () =>
        canvas.convertToBlob({ type: "image/png" }).then((png) => png.arrayBuffer()).then((bytes) =>
          new Uint8Array(bytes)
        ),
      catch: workshopError
    })
  })
})

const live = RpcServer.layer(TileRpc, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BrowserWorkerRunner.layer)
)

Effect.runFork(Layer.launch(live))
