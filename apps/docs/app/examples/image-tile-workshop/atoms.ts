import * as BrowserWorker from "@effect/platform-browser/BrowserWorker"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Atom from "effect/reactivity/Atom"
import * as AtomRpc from "effect/reactivity/AtomRpc"
import * as RpcClient from "effect/rpc/RpcClient"
import * as Stream from "effect/Stream"
import * as WorkerPlatform from "effect/workers/Worker"
import { defaultSetup, type Filter, grids, RenderEvent, type RenderSetup, WorkshopError } from "./domain.ts"
import { WorkshopRpc } from "./protocol.ts"
import { downloadPng, type Picture, sharePixels } from "./source.ts"

const workshopWorker = Layer.effect(
  WorkerPlatform.Spawner,
  Effect.acquireRelease(
    Effect.sync(() =>
      new Worker(new URL("./workshop.worker.ts", import.meta.url), { type: "module", name: "VFS owner" })
    ),
    (worker) => Effect.sync(() => worker.terminate())
  ).pipe(Effect.map((worker) => () => worker))
)

class WorkshopClient extends AtomRpc.Service<WorkshopClient>()("WorkshopClient", {
  group: WorkshopRpc,
  protocol: RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
    Layer.provide(Layer.merge(BrowserWorker.layerPlatform, workshopWorker))
  )
}) {}

type TileEvent = Exclude<RenderEvent, { _tag: "started" | "planned" }>

type Applied = Extract<TileEvent, { _tag: "applied" }>

export type TileStatus = Exclude<TileEvent, Applied> | Omit<Applied, "png">

export type TileView = {
  readonly visible: Applied | undefined
  readonly latest: TileStatus
  readonly committed: Extract<TileEvent, { _tag: "committed" }> | undefined
  readonly history: ReadonlyArray<TileStatus>
}

export type WorkshopView = {
  readonly sharedBytes: number
  readonly order: ReadonlyArray<number>
  readonly setup: RenderSetup
  readonly tasks: ReadonlyArray<
    { readonly tile: number; readonly worker: number; readonly status: TileStatus | undefined }
  >
  readonly exported: boolean
  readonly tiles: Readonly<Partial<Record<number, TileView>>>
}

export const initialWorkshop: WorkshopView = {
  sharedBytes: 0,
  order: [],
  setup: defaultSetup,
  tiles: {},
  tasks: [],
  exported: false
}

export const workshopAtom = Atom.make(initialWorkshop)

export const selectionAtom = Atom.make<ReadonlyArray<number>>([])

export const busyAtom = Atom.make<"render" | "rebuild" | "download" | "swap" | null>(null)

export const errorAtom = Atom.make("")

function omitPixels({ png: _png, ...status }: Applied): Omit<Applied, "png"> {
  return status
}

function applyEvent(state: WorkshopView, event: RenderEvent): WorkshopView {
  if (RenderEvent.guards.started(event)) {
    const { columns, rows } = grids[event.setup.grid]

    return {
      ...initialWorkshop,
      sharedBytes: event.sharedBytes,
      setup: event.setup,
      order: Array.from({ length: columns * rows }, (_, tile) => tile)
    }
  }

  if (RenderEvent.guards.planned(event)) {
    return { ...state, tasks: event.tasks.map((task) => ({ ...task, status: undefined })) }
  }

  const previous = state.tiles[event.tile]
  const applied = RenderEvent.guards.applied(event)
  const status = applied ? omitPixels(event) : event
  const visible = applied ? event : previous?.visible

  return {
    ...state,
    tasks: state.tasks.map((task) => task.tile === event.tile ? { ...task, status } : task),
    tiles: {
      ...state.tiles,
      [event.tile]: {
        visible,
        committed: RenderEvent.guards.committed(event) ? event : previous?.committed,
        latest: status,
        history: [...(previous?.history ?? []), status].slice(-30)
      }
    }
  }
}

type Action =
  | { readonly kind: "render"; readonly picture: Picture; readonly filter: Filter; readonly setup: RenderSetup }
  | { readonly kind: "rebuild"; readonly tiles: ReadonlyArray<number>; readonly filter: Filter }
  | { readonly kind: "swap"; readonly tile: number; readonly position: number }
  | { readonly kind: "download" }

const perform = Effect.fnUntraced(function*(action: Action) {
  const client = yield* WorkshopClient

  if (action.kind === "swap") {
    const order = yield* client("swap", { tile: action.tile, position: action.position }).pipe(
      Effect.timeout("20 seconds")
    )

    yield* Atom.update(workshopAtom, (view) => ({ ...view, order }))

    return
  }

  if (action.kind === "download") {
    const bytes = yield* client("download", undefined).pipe(Effect.timeout("20 seconds"))
    yield* Atom.update(workshopAtom, (view) => ({ ...view, exported: true }))
    yield* Effect.sync(() => downloadPng(bytes))

    return
  }

  const events = yield* Effect.gen(function*() {
    if (action.kind === "rebuild") return client("rebuild", { tiles: action.tiles, filter: action.filter })
    const source = yield* Effect.try({ try: () => sharePixels(action.picture), catch: (error) => String(error) })
    yield* Atom.set(workshopAtom, initialWorkshop)
    yield* Atom.set(selectionAtom, [])

    return client("render", { source, filter: action.filter, setup: action.setup })
  })

  yield* events.pipe(
    Stream.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Stream.fail(new WorkshopError({ message: "Timed out waiting for render progress." }))
    }),
    Stream.runForEach(Effect.fnUntraced(function*(event) {
      yield* Atom.update(workshopAtom, (state) => applyEvent(state, event))

      // Pace presentation so the real RPC events can be inspected as they arrive.
      if (
        action.kind === "rebuild" && action.tiles.length === 1 &&
        (RenderEvent.guards.assigned(event) || RenderEvent.guards.committed(event))
      ) {
        yield* Effect.sleep("450 millis")
      } else if (RenderEvent.guards.applied(event)) {
        yield* Effect.sleep("90 millis")
      }
    }))
  )
})

export const actionAtom = WorkshopClient.runtime.fn(Effect.fnUntraced(function*(action: Action) {
  if (yield* Atom.get(busyAtom)) return
  yield* Atom.set(busyAtom, action.kind)
  yield* Atom.set(errorAtom, "")
  yield* Effect.exit(perform(action)).pipe(
    Effect.flatMap((exit) =>
      Exit.isFailure(exit)
        ? Atom.set(errorAtom, String(Cause.squash(exit.cause)))
        : Effect.void
    ),
    Effect.ensuring(Atom.set(busyAtom, null))
  )
}))
