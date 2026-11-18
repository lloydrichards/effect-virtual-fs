import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as Schema from "effect/Schema"
import { SharedMemory, Transferable } from "effect/workers"

export const TileGrid = Schema.Literals(["2x2", "4x3", "6x4"])

export const grids = {
  "2x2": { columns: 2, rows: 2 },
  "4x3": { columns: 4, rows: 3 },
  "6x4": { columns: 6, rows: 4 }
} as const

export const WorkerCount = Schema.Literals([2, 3, 4])

export const RenderSetup = Schema.Struct({ grid: TileGrid, workers: WorkerCount })

export type RenderSetup = typeof RenderSetup.Type

export const defaultSetup: RenderSetup = { grid: "4x3", workers: 3 }

export const largestGrid = grids["6x4"]

export const maxImageEdge = 1200

export const outputPath = "/output/result.png"

const Png = Schema.Uint8Array.annotate({ toCodecJson: () => undefined })

const Source = Schema.Struct({
  width: Schema.Int.check(Schema.isBetween({ minimum: largestGrid.columns, maximum: maxImageEdge })),
  height: Schema.Int.check(Schema.isBetween({ minimum: largestGrid.rows, maximum: maxImageEdge })),
  pixels: SharedMemory.schema(Uint8ClampedArray)
})

export type Source = typeof Source.Type

const TileId = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: largestGrid.columns * largestGrid.rows - 1 }))

export const Filter = Schema.Literals(["normal", "blur", "grayscale", "invert", "sepia"])

export type Filter = typeof Filter.Type

export const filterLabels = {
  normal: "Normal",
  blur: "Blur",
  grayscale: "Grayscale",
  invert: "Invert colors",
  sepia: "Sepia"
} satisfies Record<
  Filter,
  string
>

const TileTask = Schema.Struct({ tile: TileId, worker: Schema.Int })

const TileVersion = {
  tile: TileId,
  worker: Schema.Int,
  version: Schema.Int,
  filter: Filter
}

export const RenderEvent = Schema.TaggedUnion({
  started: { sharedBytes: Schema.Int, setup: RenderSetup },
  planned: { tasks: Schema.Array(TileTask) },
  assigned: { ...TileVersion, previousWorker: Schema.NullOr(Schema.Int) },
  committed: TileVersion,
  applied: { ...TileVersion, png: Png },
  failed: { ...TileVersion, stage: Schema.Literals(["compute", "publish", "compose"]), message: Schema.String }
})

export type RenderEvent = typeof RenderEvent.Type

export type TileVersion = Pick<Extract<RenderEvent, { _tag: "assigned" }>, "tile" | "worker" | "version" | "filter">

export class WorkshopError extends Schema.TaggedError<WorkshopError>()("WorkshopError", {
  message: Schema.String
}) {}

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

export const TileBounds = Schema.Struct({ x: Schema.Int, y: Schema.Int, width: Schema.Int, height: Schema.Int })

export type TileBounds = typeof TileBounds.Type

export function boundsOf(
  source: Pick<Source, "width" | "height">,
  tile: number,
  { columns, rows }: { readonly columns: number; readonly rows: number }
): TileBounds {
  const column = tile % columns
  const row = Math.floor(tile / columns)
  const x = Math.floor(column * source.width / columns)
  const y = Math.floor(row * source.height / rows)

  return {
    x,
    y,
    width: Math.floor((column + 1) * source.width / columns) - x,
    height: Math.floor((row + 1) * source.height / rows) - y
  }
}

export function tilePath(tile: number, columns: number) {
  return `/tiles/${Math.floor(tile / columns) + 1}-${tile % columns + 1}.png`
}

const Placement = Schema.Struct({ tile: TileId, bounds: TileBounds })

export class TileRpc extends RpcGroup.make(
  Rpc.make("renderTile", {
    payload: { source: Source, bounds: TileBounds, filter: Filter },
    success: Transferable.Uint8Array,
    error: WorkshopError
  })
) {}

export const WorkerJob = Schema.TaggedUnion({
  reset: { width: Schema.Int, height: Schema.Int },
  apply: { ...Placement.fields, path: Schema.String },
  swap: { first: Placement, second: Placement },
  encode: {}
})

export type WorkerJob = typeof WorkerJob.Type

export const WorkerReply = Schema.TaggedUnion({
  bytes: { bytes: Schema.Uint8Array },
  done: {},
  read: { path: Schema.String },
  error: { message: Schema.String }
})

export type WorkerReply = typeof WorkerReply.Type

export const FileReply = Schema.TaggedUnion({
  bytes: { bytes: Schema.Uint8Array },
  error: { message: Schema.String }
})

export type FileReply = typeof FileReply.Type
