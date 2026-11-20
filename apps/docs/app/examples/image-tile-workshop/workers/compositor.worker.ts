import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { TileBounds } from "../domain.ts"
import { WorkshopError, workshopError } from "../errors.ts"
import { CompositorJob, CompositorReply, FileReply } from "../protocol.ts"
import { canvasContext, encodePng, makeCanvas } from "./canvas.ts"

interface Composition {
  readonly canvas: OffscreenCanvas
  readonly tiles: Map<number, OffscreenCanvas>
}

let composition: Composition | undefined

function reply(port: MessagePort, value: CompositorReply) {
  const buffer = CompositorReply.guards.bytes(value) ? value.bytes.buffer : undefined
  port.postMessage(value, buffer instanceof ArrayBuffer ? [buffer] : [])
}

const drawTile = Effect.fnUntraced(function*(
  canvas: OffscreenCanvas,
  tile: OffscreenCanvas,
  { height, width, x, y }: TileBounds
) {
  const target = yield* canvasContext(canvas)

  yield* Effect.try({
    try: () => {
      target.clearRect(x, y, width, height)
      target.drawImage(tile, x, y, width, height)
    },
    catch: workshopError
  })
})

const apply = Effect.fnUntraced(function*(job: typeof CompositorJob.cases.apply.Type, port: MessagePort) {
  const current = composition

  if (!current) return yield* new WorkshopError({ message: "Start a render before applying tiles." })

  const input = yield* Effect.callback<unknown, WorkshopError>((resume, signal) => {
    try {
      port.addEventListener("message", (event) => resume(Effect.succeed(event.data)), { once: true, signal })
      port.start()
      reply(port, CompositorReply.cases.read.make({ path: job.path }))
    } catch (cause) {
      resume(Effect.fail(workshopError(cause)))
    }
  }).pipe(Effect.timeout("15 seconds"))

  const file = yield* Schema.decodeUnknownEffect(FileReply)(input)

  if (FileReply.guards.error(file)) return yield* new WorkshopError({ message: file.message })

  const image = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => createImageBitmap(new Blob([new Uint8Array(file.bytes)], { type: "image/png" })),
      catch: workshopError
    }),
    (image) => Effect.sync(() => image.close())
  )

  const tile = yield* makeCanvas(image.width, image.height)
  const context = yield* canvasContext(tile)

  yield* Effect.try({ try: () => context.drawImage(image, 0, 0), catch: workshopError })
  yield* drawTile(current.canvas, tile, job.bounds)
  current.tiles.set(job.tile, tile)

  return CompositorReply.cases.bytes.make({ bytes: file.bytes })
}, Effect.scoped)

function execute(job: CompositorJob, port: MessagePort) {
  return CompositorJob.match(job, {
    reset: Effect.fnUntraced(function*({ height, width }) {
      const canvas = yield* makeCanvas(width, height)
      yield* canvasContext(canvas)
      composition = { canvas, tiles: new Map() }

      return CompositorReply.cases.done.make({})
    }),
    apply: (job) => apply(job, port),
    swap: Effect.fnUntraced(function*({ first, second }) {
      const left = composition?.tiles.get(first.tile)
      const right = composition?.tiles.get(second.tile)

      if (!composition || !left || !right) {
        return yield* new WorkshopError({ message: "Render both tiles before swapping them." })
      }

      yield* drawTile(composition.canvas, left, first.bounds)
      yield* drawTile(composition.canvas, right, second.bounds)

      return CompositorReply.cases.done.make({})
    }),
    encode: Effect.fnUntraced(function*() {
      if (!composition) return yield* new WorkshopError({ message: "Start a render before exporting." })

      const bytes = yield* encodePng(composition.canvas)

      return CompositorReply.cases.bytes.make({ bytes })
    })
  })
}

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const port = event.ports[0]

  if (!port) return

  Effect.runFork(
    Schema.decodeUnknownEffect(CompositorJob)(event.data).pipe(
      Effect.flatMap((job) => execute(job, port)),
      Effect.tap((value) => Effect.try({ try: () => reply(port, value), catch: workshopError })),
      Effect.tapDefect((defect) => Effect.logError(defect)),
      Effect.catchCause((cause) =>
        Effect.try({
          try: () =>
            reply(port, CompositorReply.cases.error.make({ message: workshopError(Cause.squash(cause)).message })),
          catch: workshopError
        }).pipe(Effect.catch((error) => Effect.logError(error)))
      ),
      Effect.ensuring(Effect.sync(() => port.close()))
    )
  )
})
