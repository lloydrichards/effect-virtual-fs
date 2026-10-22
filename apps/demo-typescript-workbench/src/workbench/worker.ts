import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RpcServer from "effect/rpc/RpcServer"
import { WorkerRpc } from "./domain.ts"
import { makeWorkspace } from "./workspace.ts"

const handlers = WorkerRpc.toLayer(
  Effect.map(makeWorkspace, (workspace) => WorkerRpc.of({ execute: workspace.execute }))
)

const live = RpcServer.layer(WorkerRpc, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer)
)

Effect.runFork(Layer.launch(live))
