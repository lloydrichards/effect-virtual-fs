import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Socket from "effect/unstable/socket/Socket"
import * as SocketServer from "effect/unstable/socket/SocketServer"
import { encodeRecord, RecordDecoder, type RecordLimits, RecordMarkingError } from "./recordMarking.js"
import { handleCall, type RpcHandlers, type RpcLimits } from "./rpc.js"

export interface ServerLimits extends RecordLimits, RpcLimits {
  readonly maxConnections: number
}

export interface ServerOptions {
  readonly limits: ServerLimits
}

const handleConnection = (
  socket: Socket.Socket,
  limits: ServerLimits,
  handlers: RpcHandlers
): Effect.Effect<void, Socket.SocketError> =>
  Effect.scoped(
    Effect.gen(function*() {
      const pull = yield* Socket.readerBytes(socket)
      const writer = yield* socket.writer
      const decoder = new RecordDecoder(limits)

      while (true) {
        const chunks = yield* pull

        for (const chunk of chunks) {
          const records = yield* Effect.suspend(() => {
            try {
              return Effect.succeed(decoder.push(chunk))
            } catch (cause) {
              if (cause instanceof RecordMarkingError) return Effect.fail(cause)
              throw cause
            }
          })

          for (const record of records) {
            const response = yield* handleCall(record, limits, handlers)

            if (response !== undefined) yield* writer.write(encodeRecord(response))
          }
        }
      }
    })
  ).pipe(
    Effect.catchTag("RecordMarkingError", () => Effect.void),
    Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void)
  )

export const startServer = (
  server: SocketServer.SocketServer["Service"],
  options: ServerOptions,
  handlers: RpcHandlers
): Effect.Effect<
  void,
  SocketServer.SocketServerError,
  Scope.Scope
> =>
  Effect.gen(function*() {
    const connections = yield* Semaphore.make(options.limits.maxConnections)
    yield* server.run((socket) =>
      Semaphore.withPermitsIfAvailable(connections, 1, handleConnection(socket, options.limits, handlers)).pipe(
        Effect.asVoid
      )
    ).pipe(Effect.forkScoped)
  })
