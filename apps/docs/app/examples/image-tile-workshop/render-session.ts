import type * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import {
  boundsOf,
  type Filter,
  grids,
  outputPath,
  type Placement,
  RenderEvent,
  type RenderSetup,
  type Source,
  type TileBounds,
  tilePath,
  type TileVersion
} from "./domain.ts"
import { type WorkshopError, workshopError } from "./errors.ts"

export type RenderTile = (
  input: { readonly source: Source; readonly bounds: TileBounds; readonly filter: Filter }
) => Effect.Effect<Uint8Array, WorkshopError>

type Compositor = {
  readonly reset: (size: Pick<Source, "width" | "height">) => Effect.Effect<void, WorkshopError>
  readonly apply: (
    tile: number,
    path: string,
    bounds: TileBounds,
    read: (path: string) => Effect.Effect<Uint8Array, WorkshopError>
  ) => Effect.Effect<Uint8Array, WorkshopError>
  readonly swap: (first: typeof Placement.Type, second: typeof Placement.Type) => Effect.Effect<void, WorkshopError>
  readonly encode: Effect.Effect<Uint8Array, WorkshopError>
}

interface Session {
  readonly source: Source
  readonly setup: RenderSetup
  readonly workers: ReadonlyArray<RenderTile>
  readonly scope: Scope.Closeable
  readonly filesystem: Vfs.Caller
  readonly visible: Map<number, TileVersion>
  order: ReadonlyArray<number>
  readonly committed: Map<number, number>
}

type Events = Queue.Queue<RenderEvent, WorkshopError | Cause.Done>

export const makeRenderSession = Effect.fnUntraced(function*(
  makeVolume: Effect.Effect<Vfs.Volume, WorkshopError>,
  compositor: Compositor,
  spawnTileRenderer: (id: number) => Effect.Effect<RenderTile, WorkshopError, Scope.Scope>
) {
  const ownerScope = yield* Scope.Scope
  let session: Session | undefined

  const renderTile = Effect.fnUntraced(
    function*(current: Session, tile: number, worker: number, filter: Filter, events: Events) {
      const previous = current.visible.get(tile)
      const version = (current.committed.get(tile) ?? 0) + 1
      const identity = { tile, worker, version, filter }
      const bounds = boundsOf(current.source, tile, grids[current.setup.grid])
      const path = tilePath(tile, grids[current.setup.grid].columns)
      yield* Queue.offer(
        events,
        RenderEvent.cases.assigned.make({ ...identity, previousWorker: previous?.worker ?? null })
      )
      let stage: "compute" | "publish" | "compose" = "compute"

      const process = Effect.gen(function*() {
        const png = yield* current.workers[worker - 1]!({ source: current.source, bounds, filter })

        stage = "publish"
        const stagingPath = `/staging/${tile}-${version}.png`
        yield* Effect.acquireRelease(
          current.filesystem.writeFile(stagingPath, png, { access: "write", create: "exclusive" }),
          () => current.filesystem.remove(stagingPath, { force: true }).pipe(Effect.ignore)
        ).pipe(
          Effect.andThen(current.filesystem.rename(stagingPath, path)),
          Effect.scoped
        )
        current.committed.set(tile, version)
        yield* Queue.offer(events, RenderEvent.cases.committed.make(identity))
        stage = "compose"

        const opened = yield* compositor.apply(
          tile,
          path,
          boundsOf(current.source, current.order.indexOf(tile), grids[current.setup.grid]),
          (requested) => current.filesystem.readFile(requested).pipe(Effect.mapError(workshopError))
        )

        current.visible.set(tile, identity)
        yield* Queue.offer(events, RenderEvent.cases.applied.make({ ...identity, png: opened }))
      })

      yield* process.pipe(
        Effect.mapError(workshopError),
        Effect.catch((error) =>
          Queue.offer(events, RenderEvent.cases.failed.make({ ...identity, stage, message: error.message }))
        )
      )
    }
  )

  const renderBatch = Effect.fnUntraced(function*(
    current: Session,
    tiles: ReadonlyArray<number>,
    filter: Filter,
    events: Events
  ) {
    const tasks = tiles.map((tile) => {
      const prior = current.visible.get(tile)
      const worker = prior ? (prior.worker % current.workers.length) + 1 : (tile % current.workers.length) + 1

      return { tile, worker }
    })

    yield* Queue.offer(events, RenderEvent.cases.planned.make({ tasks }))
    yield* Effect.forEach(current.workers, (_, index) =>
      Effect.forEach(
        tasks.filter(({ worker }) => worker === index + 1),
        ({ tile, worker }) => renderTile(current, tile, worker, filter, events),
        { discard: true }
      ), { concurrency: "unbounded", discard: true })
    yield* Queue.end(events)
  })

  return {
    render: ({ source, filter, setup }: { source: Source; filter: Filter; setup: RenderSetup }) =>
      Stream.callback<RenderEvent, WorkshopError>((events) =>
        Effect.gen(function*() {
          if (source.pixels.byteLength !== source.width * source.height * 4) {
            return yield* workshopError("The shared buffer size does not match the image dimensions.")
          }

          const volume = yield* makeVolume
          const filesystem = yield* volume.caller()
          yield* filesystem.mkdir("/staging")
          yield* filesystem.mkdir("/tiles")
          yield* filesystem.mkdir("/output")
          const previous = session
          session = undefined

          if (previous) yield* Scope.close(previous.scope, Exit.void)
          yield* compositor.reset({ width: source.width, height: source.height })
          const scope = yield* Scope.fork(ownerScope)

          const workers = yield* Effect.forEach(
            Array.from({ length: setup.workers }, (_, index) => index + 1),
            spawnTileRenderer
          ).pipe(
            Scope.provide(scope),
            Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)))
          )

          const { columns, rows } = grids[setup.grid]
          const order = Array.from({ length: columns * rows }, (_, tile) => tile)

          const current: Session = {
            source,
            setup,
            workers,
            scope,
            filesystem,
            visible: new Map(),
            committed: new Map(),
            order
          }

          session = current
          yield* Queue.offer(events, RenderEvent.cases.started.make({ sharedBytes: source.pixels.byteLength, setup }))
          yield* renderBatch(current, order, filter, events)
        }).pipe(Effect.mapError(workshopError))
      ),
    rebuild: ({ tiles, filter }: { tiles: ReadonlyArray<number>; filter: Filter }) =>
      Stream.callback<RenderEvent, WorkshopError>((events) =>
        Effect.gen(function*() {
          const current = session

          if (!current) return yield* workshopError("Start a render before rebuilding a tile.")
          const { columns, rows } = grids[current.setup.grid]

          if (tiles.some((tile) => tile >= columns * rows)) {
            return yield* workshopError("The selected tile is outside the current grid.")
          }

          yield* renderBatch(current, [...new Set(tiles)], filter, events)
        })
      ),
    swap: Effect.fnUntraced(function*({ tile, position }: { tile: number; position: number }) {
      const current = session
      const other = current?.order[position]

      if (!current || other === undefined || !current.visible.has(tile) || !current.visible.has(other)) {
        return yield* workshopError("Render both tiles before swapping them.")
      }

      if (tile === other) return current.order

      const previous = current.order.indexOf(tile)
      const grid = grids[current.setup.grid]

      yield* compositor.swap(
        { tile, bounds: boundsOf(current.source, position, grid) },
        { tile: other, bounds: boundsOf(current.source, previous, grid) }
      )

      const order = [...current.order]
      order[position] = tile
      order[previous] = other
      current.order = order

      return order
    }),
    download: Effect.fnUntraced(function*() {
      const current = session

      const grid = current && grids[current.setup.grid]

      if (!grid || current.visible.size !== grid.columns * grid.rows) {
        return yield* workshopError("Render every tile before downloading.")
      }

      const png = yield* compositor.encode
      yield* current.filesystem.writeFile(outputPath, png, { access: "write", create: "ifMissing", truncate: true })

      return yield* current.filesystem.readFile(outputPath)
    }, Effect.mapError(workshopError))
  }
})
