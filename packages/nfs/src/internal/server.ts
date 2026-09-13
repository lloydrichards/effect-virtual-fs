import * as BunSocketServer from "@effect/platform-bun/BunSocketServer"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Socket from "effect/unstable/socket/Socket"
import type * as SocketServer from "effect/unstable/socket/SocketServer"
import { encodeRecord, RecordDecoder, type RecordLimits, RecordMarkingError } from "./recordMarking.js"
import { handleCall, type RpcHandlers, type RpcLimits } from "./rpc.js"

export interface ServerLimits extends RecordLimits, RpcLimits {
  readonly maxConnections: number
}

export interface ServerOptions {
  readonly host: string
  readonly port: number
  readonly limits: ServerLimits
}

export interface RunningServer {
  readonly address: {
    readonly host: string
    readonly port: number
  }
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
    Effect.catchIf((error) => error.reason._tag === "SocketCloseError", () => Effect.void)
  )

export const makeServer = (
  options: ServerOptions,
  handlers: RpcHandlers
): Effect.Effect<RunningServer, SocketServer.SocketServerError, Scope.Scope> =>
  Effect.gen(function*() {
    const server = yield* BunSocketServer.make({ host: options.host, port: options.port })
    const connections = yield* Semaphore.make(options.limits.maxConnections)
    yield* server.run((socket) =>
      Semaphore.withPermitsIfAvailable(connections, 1, handleConnection(socket, options.limits, handlers)).pipe(
        Effect.asVoid
      )
    ).pipe(Effect.forkScoped)
    if (server.address._tag === "UnixPathAddress") {
      return yield* Effect.die("TCP server returned a Unix-domain address")
    }
    return {
      address: {
        host: server.address.address.toString(),
        port: server.address.port
      }
    }
  })
