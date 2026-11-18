import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { FileReply, type TileBounds, WorkerJob, WorkerReply } from "./domain.ts"

interface Composition {
  readonly canvas: OffscreenCanvas
  readonly tiles: Map<number, OffscreenCanvas>
}

let composition: Composition | undefined

function context(canvas: OffscreenCanvas) {
  const context = canvas.getContext("2d")

  if (!context) throw new Error("The worker could not open a 2D canvas.")

  return context
}

function encode(canvas: OffscreenCanvas) {
  return Effect.tryPromise({
    try: () =>
      canvas.convertToBlob({ type: "image/png" }).then((blob) => blob.arrayBuffer()).then((bytes) =>
        new Uint8Array(bytes)
      ),
    catch: String
  })
}

function reply(port: MessagePort, value: WorkerReply) {
  const buffer = WorkerReply.guards.bytes(value) ? value.bytes.buffer : undefined
  port.postMessage(value, buffer instanceof ArrayBuffer ? [buffer] : [])
}

function drawTile(canvas: OffscreenCanvas, tile: OffscreenCanvas, { height, width, x, y }: TileBounds) {
  const target = context(canvas)
  target.clearRect(x, y, width, height)
  target.drawImage(tile, x, y, width, height)
}

const apply = Effect.fnUntraced(function*(job: typeof WorkerJob.cases.apply.Type, port: MessagePort) {
  const current = composition

  if (!current) return yield* Effect.fail("Start a render before applying tiles.")

  const input = yield* Effect.callback<unknown>((resume, signal) => {
    port.addEventListener("message", (event) => resume(Effect.succeed(event.data)), { once: true, signal })
    port.start()
    reply(port, WorkerReply.cases.read.make({ path: job.path }))
  }).pipe(Effect.timeout("15 seconds"))

  const file = yield* Schema.decodeUnknownEffect(FileReply)(input)

  if (FileReply.guards.error(file)) return yield* Effect.fail(file.message)

  const image = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => createImageBitmap(new Blob([new Uint8Array(file.bytes)], { type: "image/png" })),
      catch: String
    }),
    (image) => Effect.sync(() => image.close())
  )

  const tile = new OffscreenCanvas(image.width, image.height)
  context(tile).drawImage(image, 0, 0)
  drawTile(current.canvas, tile, job.bounds)
  current.tiles.set(job.tile, tile)

  return WorkerReply.cases.bytes.make({ bytes: file.bytes })
}, Effect.scoped)

function execute(job: WorkerJob, port: MessagePort) {
  return WorkerJob.match(job, {
    reset: ({ height, width }) =>
      Effect.sync(() => {
        composition = { canvas: new OffscreenCanvas(width, height), tiles: new Map() }

        return WorkerReply.cases.done.make({})
      }),
    apply: (job) => apply(job, port),
    swap: Effect.fnUntraced(function*({ first, second }) {
      const left = composition?.tiles.get(first.tile)
      const right = composition?.tiles.get(second.tile)

      if (!composition || !left || !right) return yield* Effect.fail("Render both tiles before swapping them.")

      drawTile(composition.canvas, left, first.bounds)
      drawTile(composition.canvas, right, second.bounds)

      return WorkerReply.cases.done.make({})
    }),
    encode: Effect.fnUntraced(function*() {
      if (!composition) return yield* Effect.fail("Start a render before exporting.")

      const bytes = yield* encode(composition.canvas)

      return WorkerReply.cases.bytes.make({ bytes })
    })
  })
}

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const port = event.ports[0]

  if (!port) return

  Effect.runFork(
    Schema.decodeUnknownEffect(WorkerJob)(event.data).pipe(
      Effect.flatMap((job) => execute(job, port)),
      Effect.tap((value) => Effect.sync(() => reply(port, value))),
      Effect.catchCause((cause) =>
        Effect.sync(() => reply(port, WorkerReply.cases.error.make({ message: String(Cause.squash(cause)) })))
      ),
      Effect.ensuring(Effect.sync(() => port.close()))
    )
  )
})
