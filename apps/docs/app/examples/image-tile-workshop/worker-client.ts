import * as BrowserWorker from "@effect/platform-browser/BrowserWorker"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Result from "effect/Result"
import * as RpcClient from "effect/rpc/RpcClient"
import * as Schema from "effect/Schema"
import { FileReply, TileRpc, WorkerJob, WorkerReply, WorkshopError } from "./domain.ts"

export const workshopError = (cause: unknown) =>
  Schema.is(WorkshopError)(cause) ? cause : new WorkshopError({ message: String(cause) })

export const spawnImageWorker = (name: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => new Worker(new URL("./image.worker.ts", import.meta.url), { type: "module", name }),
      catch: workshopError
    }),
    (worker) => Effect.sync(() => worker.terminate())
  )

export const spawnTileClient = Effect.fnUntraced(function*(id: number) {
  const worker = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        new Worker(new URL("./tile.worker.ts", import.meta.url), { type: "module", name: `Tile worker ${id}` }),
      catch: workshopError
    }),
    (worker) => Effect.sync(() => worker.terminate())
  )

  const protocol = RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
    Layer.provide(BrowserWorker.layer(() => worker))
  )

  const context = yield* Layer.build(protocol)

  return yield* RpcClient.make(TileRpc).pipe(Effect.provideContext(context))
})

// A job owns its reply port. The compositor uses it to open the committed tile by path.
export const runJob = Effect.fnUntraced(
  function*(
    worker: Worker,
    job: WorkerJob,
    read?: (path: string) => Effect.Effect<Uint8Array, WorkshopError>
  ) {
    const queue = yield* Queue.unbounded<WorkerReply>()

    const port = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const { port1, port2 } = new MessageChannel()

          try {
            worker.postMessage(job, [port2])

            return port1
          } catch (error) {
            port1.close()
            port2.close()
            throw error
          }
        },
        catch: workshopError
      }),
      (port) => Effect.sync(() => port.close())
    )

    const onWorkerError = (error: ErrorEvent) => {
      Queue.offerUnsafe(queue, WorkerReply.cases.error.make({ message: error.message || "The image worker crashed." }))
    }

    yield* Effect.addFinalizer(() => Effect.sync(() => worker.removeEventListener("error", onWorkerError)))
    worker.addEventListener("error", onWorkerError)
    port.onmessage = (event: MessageEvent<unknown>) => {
      const decoded = Schema.decodeUnknownResult(WorkerReply)(event.data)

      if (Result.isSuccess(decoded)) Queue.offerUnsafe(queue, decoded.success)
      else {
        Queue.offerUnsafe(
          queue,
          WorkerReply.cases.error.make({ message: "The worker returned an invalid response." })
        )
      }
    }

    port.onmessageerror = () => {
      Queue.offerUnsafe(
        queue,
        WorkerReply.cases.error.make({ message: "The browser could not decode the worker response." })
      )
    }

    let reply = yield* Queue.take(queue)

    if (WorkerReply.guards.read(reply)) {
      if (!read || !WorkerJob.guards.apply(job) || reply.path !== job.path) {
        return yield* workshopError("The compositor requested an unexpected path.")
      }

      const file = yield* Effect.exit(read(reply.path))
      yield* Effect.try({
        try: () => {
          if (Exit.isFailure(file)) {
            const error = FileReply.cases.error.make({ message: "The VFS could not open the committed tile." })
            port.postMessage(error)

            return
          }

          // readFile returns an owned copy. Transfer only a regular ArrayBuffer.
          const buffer = file.value.buffer
          const response = FileReply.cases.bytes.make({ bytes: file.value })
          port.postMessage(response, buffer instanceof ArrayBuffer ? [buffer] : [])
        },
        catch: workshopError
      })

      if (Exit.isFailure(file)) return yield* Effect.failCause(file.cause)
      reply = yield* Queue.take(queue)
    }

    if (WorkerReply.guards.error(reply)) return yield* workshopError(reply.message)

    if (WorkerReply.guards.read(reply)) return yield* workshopError("The compositor requested the same tile twice.")

    return reply
  },
  Effect.scoped,
  Effect.timeout("15 seconds"),
  Effect.mapError(workshopError)
)

export const expectBytes = Effect.fnUntraced(function*(reply: Effect.Success<ReturnType<typeof runJob>>) {
  if (!WorkerReply.guards.bytes(reply)) return yield* workshopError("The worker did not return PNG bytes.")

  return reply.bytes
})
