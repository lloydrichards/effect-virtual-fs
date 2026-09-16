import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Socket from "effect/unstable/socket/Socket"
import type * as SocketServer from "effect/unstable/socket/SocketServer"
import { encodeRecord, RecordDecoder, type RecordLimits, RecordMarkingError } from "./recordMarking.js"
import { type Connection, handleCall, type RpcHandlers, type RpcLimits } from "./rpc.js"

export interface ServerLimits extends RecordLimits, RpcLimits {
  readonly maxConnections: number
}

export interface ServerOptions {
  readonly limits: ServerLimits
}

/**
 * Opens and immediately closes a connection the server has no permit for. Acquiring the reader is
 * what opens the underlying socket; a refusal that never acquires one leaves the connection
 * accepted by the platform but abandoned, holding a file descriptor until the process exits.
 */
const refuseConnection = (socket: Socket.Socket): Effect.Effect<void> =>
  Effect.ignore(Effect.scoped(Effect.asVoid(socket.reader)))

const handleConnection = (
  connection: Connection,
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
            const response = yield* handleCall(connection, record, limits, handlers)

            if (response !== undefined) yield* writer.write(encodeRecord(response))
          }
        }
      }
    })
  ).pipe(
    Effect.catchTag("RecordMarkingError", () => Effect.void),
    Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
    // A connection that ends for any reason releases the session state it was associated with.
    // FIX(#70): this finalizer runs uninterruptibly and waits on the handler's state gate, so
    // shutdown can stall behind an in-flight compound.
    // https://github.com/lloydrichards/effect-virtual-fs/issues/70
    Effect.ensuring(handlers.disconnect(connection))
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
    let connectionSerial = 0
    yield* server.run((socket) => {
      const connection: Connection = { id: connectionSerial++ }

      return Semaphore.withPermitsIfAvailable(
        connections,
        1,
        handleConnection(connection, socket, options.limits, handlers)
      ).pipe(
        // A refusal never runs `handleConnection`, so the socket is still unopened here and must
        // be closed explicitly rather than left for the server finalizer, which only tracks
        // connections that arrived before `run` started.
        Effect.flatMap(Option.match({
          onNone: () => refuseConnection(socket),
          onSome: () => Effect.void
        }))
      )
    }).pipe(Effect.forkScoped)
  })
