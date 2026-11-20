import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RpcServer from "effect/rpc/RpcServer"
import { workshopError } from "../errors.ts"
import { filterTile } from "../pixels.ts"
import { TileRpc } from "../protocol.ts"
import { canvasContext, encodePng, makeCanvas } from "./canvas.ts"

const handlers = TileRpc.toLayer({
  renderTile: Effect.fnUntraced(function*({ bounds, source, filter }) {
    const canvas = yield* makeCanvas(bounds.width, bounds.height)
    const context = yield* canvasContext(canvas)
    const pixels = filterTile(source, bounds, filter)

    yield* Effect.try({
      try: () => context.putImageData(new ImageData(pixels, bounds.width, bounds.height), 0, 0),
      catch: workshopError
    })

    return yield* encodePng(canvas)
  })
})

const live = RpcServer.layer(TileRpc, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BrowserWorkerRunner.layer)
)

Effect.runFork(Layer.launch(live))
