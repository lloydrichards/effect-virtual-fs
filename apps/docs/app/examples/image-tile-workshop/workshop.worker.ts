import * as Vfs from "@effect-vfs/core/VirtualFileSystem"
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner"
import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import {
  boundsOf,
  type Filter,
  grids,
  outputPath,
  RenderEvent,
  type RenderSetup,
  type Source,
  tilePath,
  type TileVersion,
  WorkerJob,
  WorkerReply,
  type WorkshopError,
  WorkshopRpc
} from "./domain.ts"
import { expectBytes, runJob, spawnImageWorker, spawnTileClient, workshopError } from "./worker-client.ts"

interface Session {
  readonly source: Source
  readonly setup: RenderSetup
  readonly workers: ReadonlyArray<Effect.Success<ReturnType<typeof spawnTileClient>>>
  readonly scope: Scope.Closeable
  readonly filesystem: Vfs.Caller
  readonly visible: Map<number, TileVersion>
  order: ReadonlyArray<number>
  readonly committed: Map<number, number>
}

type Events = Queue.Queue<RenderEvent, WorkshopError | Cause.Done>

const handlers = WorkshopRpc.toLayer(Effect.gen(function*() {
  const ownerScope = yield* Scope.Scope
  const compositor = yield* spawnImageWorker("Compositor")
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
        const png = yield* current.workers[worker - 1]!.renderTile({ source: current.source, bounds, filter }).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(workshopError)
        )

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

        const opened = yield* runJob(
          compositor,
          WorkerJob.cases.apply.make({
            tile,
            path,
            bounds: boundsOf(current.source, current.order.indexOf(tile), grids[current.setup.grid])
          }),
          (requested) => current.filesystem.readFile(requested).pipe(Effect.mapError(workshopError))
        ).pipe(Effect.flatMap(expectBytes))

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

  return WorkshopRpc.of({
    render: ({ source, filter, setup }) =>
      Stream.callback<RenderEvent, WorkshopError>((events) =>
        Effect.gen(function*() {
          if (source.pixels.byteLength !== source.width * source.height * 4) {
            return yield* workshopError("The shared buffer size does not match the image dimensions.")
          }

          const volume = yield* Vfs.make().pipe(Effect.provide(BrowserCrypto.layer))
          const filesystem = yield* volume.caller()
          yield* filesystem.mkdir("/staging")
          yield* filesystem.mkdir("/tiles")
          yield* filesystem.mkdir("/output")
          const previous = session
          session = undefined

          if (previous) yield* Scope.close(previous.scope, Exit.void)
          yield* runJob(compositor, WorkerJob.cases.reset.make({ width: source.width, height: source.height }))
          const scope = yield* Scope.fork(ownerScope)

          const workers = yield* Effect.forEach(
            Array.from({ length: setup.workers }, (_, index) => index + 1),
            spawnTileClient
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
    rebuild: ({ tiles, filter }) =>
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
    swap: Effect.fnUntraced(function*({ tile, position }) {
      const current = session
      const other = current?.order[position]

      if (!current || other === undefined || !current.visible.has(tile) || !current.visible.has(other)) {
        return yield* workshopError("Render both tiles before swapping them.")
      }

      if (tile === other) return current.order

      const previous = current.order.indexOf(tile)
      const grid = grids[current.setup.grid]

      const reply = yield* runJob(
        compositor,
        WorkerJob.cases.swap.make({
          first: { tile, bounds: boundsOf(current.source, position, grid) },
          second: { tile: other, bounds: boundsOf(current.source, previous, grid) }
        })
      )

      if (!WorkerReply.guards.done(reply)) return yield* workshopError("The compositor did not confirm the swap.")

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

      const png = yield* runJob(compositor, WorkerJob.cases.encode.make({})).pipe(Effect.flatMap(expectBytes))
      yield* current.filesystem.writeFile(outputPath, png, { access: "write", create: "ifMissing", truncate: true })

      return yield* current.filesystem.readFile(outputPath)
    }, Effect.mapError(workshopError))
  })
}))

const live = RpcServer.layer(WorkshopRpc, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BrowserWorkerRunner.layer)
)

Effect.runFork(Layer.launch(live))
