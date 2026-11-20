import * as Schema from "effect/Schema"
import { SharedMemory } from "effect/workers"

export const TileGrid = Schema.Literals(["2x2", "4x3", "6x4"])

export const grids = {
  "2x2": { columns: 2, rows: 2 },
  "4x3": { columns: 4, rows: 3 },
  "6x4": { columns: 6, rows: 4 }
} as const satisfies Record<typeof TileGrid.Type, { readonly columns: number; readonly rows: number }>

export const WorkerCount = Schema.Literals([2, 3, 4])

export const RenderSetup = Schema.Struct({ grid: TileGrid, workers: WorkerCount })

export type RenderSetup = typeof RenderSetup.Type

export const defaultSetup: RenderSetup = { grid: "4x3", workers: 3 }

export const largestGrid = grids["6x4"]

export const maxImageEdge = 1200

export const outputPath = "/output/result.png"

// Page replies keep PNG bytes as binary on the structured-clone transport.
export const Png = Schema.Uint8Array.annotate({ toCodecJson: () => undefined })

export const Source = Schema.Struct({
  width: Schema.Int.check(Schema.isBetween({ minimum: largestGrid.columns, maximum: maxImageEdge })),
  height: Schema.Int.check(Schema.isBetween({ minimum: largestGrid.rows, maximum: maxImageEdge })),
  pixels: SharedMemory.schema(Uint8ClampedArray)
})

export type Source = typeof Source.Type

export const TileId = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: largestGrid.columns * largestGrid.rows - 1 })
)

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

export const Placement = Schema.Struct({ tile: TileId, bounds: TileBounds })
