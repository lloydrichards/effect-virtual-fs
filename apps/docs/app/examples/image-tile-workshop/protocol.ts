import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as Schema from "effect/Schema"
import { Transferable } from "effect/workers"
import { Filter, largestGrid, Placement, Png, RenderEvent, RenderSetup, Source, TileBounds, TileId } from "./domain.ts"
import { WorkshopError } from "./errors.ts"

export class WorkshopRpc extends RpcGroup.make(
  Rpc.make("render", {
    payload: { source: Source, filter: Filter, setup: RenderSetup },
    success: RenderEvent,
    error: WorkshopError,
    stream: true
  }),
  Rpc.make("rebuild", {
    payload: {
      tiles: Schema.Array(TileId).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(largestGrid.columns * largestGrid.rows)
      ),
      filter: Filter
    },
    success: RenderEvent,
    error: WorkshopError,
    stream: true
  }),
  Rpc.make("swap", {
    payload: { tile: TileId, position: TileId },
    success: Schema.Array(TileId),
    error: WorkshopError
  }),
  Rpc.make("download", { success: Png, error: WorkshopError })
) {}

export class TileRpc extends RpcGroup.make(
  Rpc.make("renderTile", {
    payload: { source: Source, bounds: TileBounds, filter: Filter },
    success: Transferable.Uint8Array,
    error: WorkshopError
  })
) {}

export const CompositorJob = Schema.TaggedUnion({
  reset: { width: Schema.Int, height: Schema.Int },
  apply: { ...Placement.fields, path: Schema.String },
  swap: { first: Placement, second: Placement },
  encode: {}
})

export type CompositorJob = typeof CompositorJob.Type

export const CompositorReply = Schema.TaggedUnion({
  bytes: { bytes: Schema.Uint8Array },
  done: {},
  read: { path: Schema.String },
  error: { message: Schema.String }
})

export type CompositorReply = typeof CompositorReply.Type

export const FileReply = Schema.TaggedUnion({
  bytes: { bytes: Schema.Uint8Array },
  error: { message: Schema.String }
})

export type FileReply = typeof FileReply.Type
