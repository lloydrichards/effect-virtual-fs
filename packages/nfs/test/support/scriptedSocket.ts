import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as NetAddress from "effect/net/NetAddress"
import * as Queue from "effect/Queue"
import * as Socket from "effect/socket/Socket"
import * as SocketServer from "effect/socket/SocketServer"
import { ReplyRecords } from "./wire.js"

/** Provides record-level control while using the server's normal connection handler. */
export const scriptedSocketServer = Effect.gen(function*() {
  const pending = yield* Queue.unbounded<{
    readonly socket: Socket.Socket
    readonly interrupt: Deferred.Deferred<void>
    readonly interruptStarted: Deferred.Deferred<void>
    readonly closed: Deferred.Deferred<void>
  }>()

  const server = SocketServer.SocketServer.of({
    address: NetAddress.inetAddressUnsafe(NetAddress.ipv4Loopback, 0),
    run: (accept) =>
      Effect.forever(Effect.gen(function*() {
        const { socket, interrupt, interruptStarted, closed } = yield* Queue.take(pending)

        yield* Effect.gen(function*() {
          const connection = yield* accept(socket).pipe(Effect.forkChild({ startImmediately: true }))

          yield* Effect.raceFirst(Fiber.await(connection), Deferred.await(interrupt))
          const stopping = yield* Fiber.interrupt(connection).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.succeed(interruptStarted, undefined)
          yield* Fiber.join(stopping)
        }).pipe(Effect.ensuring(Deferred.succeed(closed, undefined)), Effect.forkChild)
      }))
  })

  const connect = Effect.fnUntraced(function*(rejectCallbackWrites = false) {
    const inbound = yield* Queue.unbounded<Uint8Array>()
    const outbound = yield* Queue.unbounded<Uint8Array>()
    const interrupt = yield* Deferred.make<void>()
    const interruptStarted = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()
    const records = new ReplyRecords()

    const write: Socket.Writer["write"] = (chunk) =>
      Effect.suspend(() => {
        if (!(chunk instanceof Uint8Array)) return Effect.void

        return Effect.forEach(records.push(chunk), (record) => {
          const kind = new DataView(record.buffer, record.byteOffset).getUint32(4)

          if (rejectCallbackWrites && kind === 0) {
            return Effect.fail(
              new Socket.SocketError({
                reason: new Socket.SocketWriteError({ cause: "scripted callback write failure" })
              })
            )
          }

          return Queue.offer(outbound, record)
        }, { discard: true })
      })

    const socket = Socket.make({
      reader: Effect.succeed({
        pull: Queue.take(inbound).pipe(Effect.map((chunk) => [chunk] as const)),
        upgrade: () => Effect.void
      }),
      writer: Effect.succeed({
        write,
        writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true })
      })
    })

    yield* Queue.offer(pending, { socket, interrupt, interruptStarted, closed })

    const interruptConnection = Deferred.succeed(interrupt, undefined).pipe(
      Effect.andThen(Deferred.await(interruptStarted))
    )

    return {
      send: (framed: Uint8Array) => Queue.offer(inbound, framed),
      receive: Queue.take(outbound),
      drain: Queue.clear(outbound),
      awaitClosed: Deferred.await(closed),
      interrupt: interruptConnection,
      disconnect: interruptConnection.pipe(Effect.andThen(Deferred.await(closed)))
    }
  })

  return { server, connect }
})
