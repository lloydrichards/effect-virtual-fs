import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RpcServer from "effect/rpc/RpcServer"
import { workshopError } from "./domain.ts"
import { WorkshopRpc } from "./protocol.ts"
import { makeRenderSession } from "./render-session.ts"
import { spawnCompositor, spawnTileRenderer } from "./worker-client.ts"

const makeVolume = Vfs.make().pipe(
  Effect.provide([BrowserCrypto.layerDigest, BrowserCrypto.layerSecureRandom]),
  Effect.mapError(workshopError)
)

const handlers = WorkshopRpc.toLayer(Effect.gen(function*() {
  const compositor = yield* spawnCompositor
  const session = yield* makeRenderSession(makeVolume, compositor, spawnTileRenderer)

  return WorkshopRpc.of(session)
}))

// One owner request at a time protects session state. Tile work runs concurrently inside a render.
const live = RpcServer.layer(WorkshopRpc, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BrowserWorkerRunner.layer)
)

Effect.runFork(Layer.launch(live))
