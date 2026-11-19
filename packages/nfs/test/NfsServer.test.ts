import { LiveVolume, Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer"
import { assert, describe, it, live as liveTest } from "@effect/vitest"
import * as ByteSize from "effect/ByteSize"
import type * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as NetAddress from "effect/net/NetAddress"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as TestClock from "effect/testing/TestClock"

import * as Socket from "effect/socket/Socket"
import * as SocketServer from "effect/socket/SocketServer"
import * as Net from "node:net"
import {
  ConfigurationError,
  type NfsIdentityPolicy,
  NfsServer,
  type NfsServerAddress,
  NfsServerConfig,
  NfsServerConfigOverrides,
  NfsServerError,
  NfsServerLimitOverrides,
  NfsServerLimits,
  type NfsServerOptions
} from "../src/NfsServer.js"
import {
  encodeRecord,
  Operation,
  type ReplyReader,
  replyReader,
  ReplyRecords,
  type RequestWriter,
  requestWriter,
  Status,
  Xdr
} from "./support/wire.js"

const live = <E>(
  name: string,
  body: () => Effect.Effect<void, E, Digest.Digest | SecureRandom.SecureRandom | Scope.Scope>,
  timeout?: number
) => liveTest(name, () => body().pipe(Effect.provide(NodeCrypto.layer)), timeout)

/** The bound TCP port of a server; the loopback tests never bind a UNIX-domain socket. */
const tcpPort = (server: { readonly address: NfsServerAddress }): number => {
  if ("path" in server.address) throw new Error("expected a TCP address")

  return server.address.port
}

class TestSocketError extends Data.TaggedError("TestSocketError")<{
  readonly cause: unknown
}> {}

const limits: NfsServerLimits = {
  maxConnections: 4,
  maxFragmentBytes: ByteSize.bytes(1_024),
  maxRecordBytes: ByteSize.bytes(2_048),
  maxFragmentsPerRecord: 8,
  maxOpaqueBytes: ByteSize.bytes(1_024),
  maxStringBytes: ByteSize.bytes(256),
  maxArrayElements: 64,
  maxAuthBytes: ByteSize.bytes(400),
  maxMachineNameBytes: ByteSize.bytes(255),
  maxSupplementaryGroups: 16,
  maxCompoundBytes: ByteSize.bytes(2_048),
  maxOperations: 16,
  maxBitmapWords: 4,
  maxClients: 8,
  maxIdentities: 8,
  maxPendingClientReplacements: 1,
  maxSessions: 8,
  maxSlotsPerSession: 4,
  maxReplayBytes: ByteSize.bytes(4_096),
  maxOpens: 16,
  maxLockOwners: 16,
  maxLocks: 64,
  maxOwnerBytes: ByteSize.bytes(256),
  maxReadBytes: ByteSize.bytes(1_024),
  maxWriteBytes: ByteSize.bytes(1_024),
  maxReaddirEntries: 64,
  maxReaddirReplyBytes: ByteSize.bytes(2_048),
  maxNameBytes: ByteSize.bytes(255)
}

const writeWords = (writer: RequestWriter, values: ReadonlyArray<number>) =>
  Effect.forEach(values, (value) => writer.write(Xdr.uint32, value), { discard: true })

const skipWords = (reader: ReplyReader, count: number) =>
  Effect.forEach(Array.from({ length: count }), () => reader.read(Xdr.uint32), { discard: true })

const rpcNull = Effect.fnUntraced(function*(xid: number) {
  const writer = requestWriter()
  yield* writeWords(writer, [xid, 0, 2, 100003, 4, 0, 0])
  yield* writer.write(Xdr.opaque(), new Uint8Array())
  yield* writer.write(Xdr.uint32, 0)
  yield* writer.write(Xdr.opaque(), new Uint8Array())

  return encodeRecord(yield* writer.finish)
})

const exchange = (
  destination: { readonly port: number } | { readonly path: string },
  request: Uint8Array,
  expectedRecords = 1
): Effect.Effect<ReadonlyArray<Uint8Array>, TestSocketError> =>
  Effect.callback((resume) => {
    const socket = "port" in destination
      ? Net.createConnection({ host: "127.0.0.1", port: destination.port })
      : Net.createConnection({ path: destination.path })

    const decoder = new ReplyRecords()

    const received: Array<Uint8Array> = []
    socket.on("connect", () => socket.write(request))
    socket.on("data", (chunk) => {
      try {
        received.push(...decoder.push(Predicate.isString(chunk) ? Buffer.from(chunk) : chunk))

        if (received.length < expectedRecords) return
        socket.end()
        resume(Effect.succeed(received))
      } catch (cause) {
        socket.destroy()
        resume(Effect.fail(new TestSocketError({ cause })))
      }
    })
    socket.on("error", (cause) => resume(Effect.fail(new TestSocketError({ cause }))))

    return Effect.sync(() => socket.destroy())
  })

const awaitRejectedConnection = (
  port: number,
  request: Uint8Array
): Effect.Effect<void, TestSocketError> =>
  Effect.callback((resume) => {
    const socket = Net.createConnection({ host: "127.0.0.1", port })
    socket.on("connect", () => socket.write(request))
    socket.on("close", () => resume(Effect.void))
    socket.on("error", (cause) => {
      // SAFETY: Node's socket error event emits ErrnoException values with an optional code.
      if ((cause as NodeJS.ErrnoException).code === "ECONNRESET") {
        resume(Effect.void)
      } else resume(Effect.fail(new TestSocketError({ cause })))
    })

    return Effect.sync(() => socket.destroy())
  })

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0)
  )

  let offset = 0

  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }

  return result
}

/** An AUTH_NONE COMPOUND call, record-marked, ready to write to a socket. */
const rpcCompound = (
  xid: number,
  operations: ReadonlyArray<(writer: RequestWriter) => Effect.Effect<void>>,
  credential?: Uint8Array
): Effect.Effect<Uint8Array> =>
  Effect.gen(function*() {
    const writer = requestWriter()

    yield* writeWords(writer, [xid, 0, 2, 100003, 4, 1])

    if (credential === undefined) {
      yield* writer.write(Xdr.uint32, 0)
      yield* writer.write(Xdr.opaque(), new Uint8Array())
    } else {
      yield* writer.appendEncoded(credential)
    }

    yield* writer.write(Xdr.uint32, 0)
    yield* writer.write(Xdr.opaque(), new Uint8Array())
    yield* writer.write(Xdr.string(), "conn")
    yield* writeWords(writer, [1, operations.length])
    yield* Effect.forEach(operations, (operation) => operation(writer), { discard: true })

    return encodeRecord(yield* writer.finish)
  })

const authSysCredential = Effect.fnUntraced(function*(uid: number) {
  const body = requestWriter()
  yield* body.write(Xdr.uint32, 0)
  yield* body.write(Xdr.string(), "test-client")
  yield* writeWords(body, [uid, uid])
  yield* body.write(Xdr.array(Xdr.uint32), [])
  const writer = requestWriter()
  yield* writer.write(Xdr.uint32, 1)
  yield* writer.write(Xdr.opaque(), yield* body.finish)

  return yield* writer.finish
})

/** Skips the RPC accepted-reply header and returns a reader positioned at the COMPOUND result. */
const compoundReply = Effect.fnUntraced(function*(record: Uint8Array) {
  const reader = replyReader(record)
  yield* skipWords(reader, 6)

  return reader
})

const firstOperationStatus = Effect.fnUntraced(function*(record: Uint8Array) {
  const reader = yield* compoundReply(record)
  yield* reader.read(Xdr.uint32)
  yield* reader.read(Xdr.string())
  yield* skipWords(reader, 2)

  return yield* reader.read(Xdr.uint32)
})

interface OpenConnection {
  readonly send: (request: Uint8Array, expectedRecords?: number) => Effect.Effect<ReadonlyArray<Uint8Array>>
  /** Writes without waiting for a reply, as a client answering a callback does. */
  readonly sendWithoutReply: (request: Uint8Array) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

/** A socket held open across several requests, so two connections can overlap in time. */
const openConnection = (port: number): Effect.Effect<OpenConnection, TestSocketError> =>
  Effect.callback((resume) => {
    const socket = Net.createConnection({ host: "127.0.0.1", port })

    const decoder = new ReplyRecords()

    let received: Array<Uint8Array> = []
    let wanted = 0
    let deliver: ((records: ReadonlyArray<Uint8Array>) => void) | undefined

    socket.on("data", (chunk) => {
      received.push(...decoder.push(Predicate.isString(chunk) ? Buffer.from(chunk) : chunk))

      if (deliver === undefined || received.length < wanted) return
      const batch = received
      const settle = deliver
      received = []
      deliver = undefined
      settle(batch)
    })

    socket.on("connect", () =>
      resume(Effect.succeed({
        send: (request: Uint8Array, expectedRecords = 1) =>
          Effect.callback<ReadonlyArray<Uint8Array>>((settle) => {
            wanted = expectedRecords
            deliver = (records) => settle(Effect.succeed(records))
            socket.write(request)

            return Effect.void
          }),
        sendWithoutReply: (request: Uint8Array) => Effect.sync(() => void socket.write(request)),
        close: Effect.sync(() => socket.destroy())
      })))

    socket.on("error", (cause) => resume(Effect.fail(new TestSocketError({ cause }))))

    return Effect.sync(() => socket.destroy())
  })

const options = (
  volume: Vfs.Volume,
  caller: Vfs.Caller
): NfsServerOptions => ({
  volume,
  caller,
  leaseDurationSeconds: 30,
  limits
})

const testSocketServer = SocketServer.SocketServer.of({
  address: NetAddress.inetAddressUnsafe(NetAddress.ipv4Loopback, 0),
  run: () => Effect.never
})

// Supplies exact read boundaries through the same Socket interface as a real listener.
const serveChunks = Effect.fnUntraced(
  function*(
    chunks: ReadonlyArray<Uint8Array>,
    override: NfsServerLimitOverrides = {},
    policy?: NfsIdentityPolicy
  ) {
    const volume = yield* Vfs.Volume
    const caller = yield* Vfs.Caller
    const done = yield* Deferred.make<void>()
    const replies: Array<Uint8Array> = []
    let consumed = 0

    const write: Socket.Writer["write"] = (chunk) =>
      Effect.sync(() => {
        if (chunk instanceof Uint8Array) replies.push(chunk)
      })

    const socket = Socket.make({
      reader: Effect.succeed({
        pull: Effect.suspend(() => {
          const chunk = chunks[consumed]

          if (chunk === undefined) {
            return Effect.fail(
              new Socket.SocketError({
                reason: new Socket.SocketCloseError({ code: 1000 })
              })
            )
          }

          consumed++

          return Effect.succeed([chunk] as const)
        }),
        upgrade: () => Effect.void
      }),
      writer: Effect.succeed({
        write,
        writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true })
      })
    })

    const transport = SocketServer.SocketServer.of({
      address: testSocketServer.address,
      run: (accept) =>
        Effect.ignore(accept(socket)).pipe(
          Effect.andThen(Deferred.succeed(done, undefined)),
          Effect.andThen(Effect.never)
        )
    })

    const serverLimits = { ...limits, ...override }

    yield* NfsServer.make(
      policy === undefined
        ? { ...options(volume, caller), limits: serverLimits }
        : {
          volume,
          limits: serverLimits,
          policy,
          peer: Effect.succeed({ transport: "tcp", address: "127.0.0.1", port: 1 })
        }
    ).pipe(
      Effect.provideService(SocketServer.SocketServer, transport)
    )
    yield* Deferred.await(done)

    return { replies, consumed }
  }
)

const fragment = (payload: Uint8Array, last: boolean) => {
  const encoded = encodeRecord(payload)

  if (!last) new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).setUint32(0, payload.length)

  return encoded
}

const replyWords = Effect.fnUntraced(function*(wire: Uint8Array) {
  const [message] = new ReplyRecords().push(wire)
  assert.isDefined(message)
  const reader = replyReader(message)

  return yield* Effect.forEach(Array.from({ length: message.length / 4 }), () => reader.read(Xdr.uint32))
})

const rpcRequest = Effect.fnUntraced(
  function*(header: ReadonlyArray<number>, credential = new Uint8Array(8), verifier = new Uint8Array(8)) {
    const writer = requestWriter()
    yield* writeWords(writer, header)
    yield* writer.appendEncoded(credential)
    yield* writer.appendEncoded(verifier)

    return encodeRecord(yield* writer.finish)
  }
)

it.layer(NodeCrypto.layer)("RPC framing over the public listener", (it) => {
  it.effect("reassembles a bytewise request, zero-length fragment and coalesced records", () =>
    Effect.gen(function*() {
      const first = yield* rpcNull(61)
      const second = yield* rpcNull(62)
      const body = second.subarray(4)

      const { replies } = yield* serveChunks([
        ...Array.from(first, (byte) => Uint8Array.of(byte)),
        concat(
          fragment(new Uint8Array(), false),
          fragment(body.subarray(0, 12), false),
          fragment(body.subarray(12), true),
          yield* rpcNull(63)
        )
      ])

      assert.deepStrictEqual(
        yield* Effect.forEach(replies, replyWords),
        [61, 62, 63].map((id) => [
          id,
          1,
          0,
          0,
          0,
          0
        ])
      )
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports RPC routing and authentication failures on the wire", () =>
    Effect.gen(function*() {
      const credential = (flavor: number) => Uint8Array.of(0, 0, 0, flavor, 0, 0, 0, 0)

      const fixtures = [
        { request: yield* rpcRequest([71, 0, 3, 100003, 4, 0]), reply: [71, 1, 1, 0, 2, 2] },
        { request: yield* rpcRequest([72, 0, 2, 1, 4, 0]), reply: [72, 1, 0, 0, 0, 1] },
        { request: yield* rpcRequest([73, 0, 2, 100003, 3, 0]), reply: [73, 1, 0, 0, 0, 2, 4, 4] },
        { request: yield* rpcRequest([74, 0, 2, 100003, 4, 9]), reply: [74, 1, 0, 0, 0, 3] },
        { request: yield* rpcRequest([75, 0, 2, 100003, 4, 0], credential(9)), reply: [75, 1, 1, 1, 1] },
        { request: yield* rpcRequest([76, 0, 2, 100003, 4, 0], credential(0), credential(1)), reply: [76, 1, 1, 1, 3] },
        { request: yield* rpcRequest([77, 0, 2, 100003, 4, 1], credential(6)), reply: [77, 1, 1, 1, 5] },
        {
          request: yield* rpcRequest([78, 0, 2, 100003, 4, 0], credential(0), Uint8Array.of(0, 0, 0)),
          reply: [78, 1, 1, 1, 3]
        },
        {
          request: yield* rpcRequest([79, 0, 2, 100003, 4, 0], credential(0), Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 4, 1)),
          reply: [79, 1, 1, 1, 3]
        },
        { request: encodeRecord(Uint8Array.of(0, 0, 0, 80, 0, 0, 0, 0)), reply: [80, 1, 0, 0, 0, 4] }
      ]

      const { replies } = yield* serveChunks([concat(
        encodeRecord(new Uint8Array()),
        encodeRecord(Uint8Array.of(1, 2, 3)),
        ...fixtures.map(({ request }) => request)
      )])

      assert.deepStrictEqual(yield* Effect.forEach(replies, replyWords), fixtures.map(({ reply }) => reply))
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("passes valid AUTH_SYS groups to the identity policy and rejects an oversized group list", () =>
    Effect.gen(function*() {
      const credential = Effect.fnUntraced(function*(groups: ReadonlyArray<number>) {
        const body = requestWriter()
        yield* body.write(Xdr.uint32, 1)
        yield* body.write(Xdr.string(), "machine")
        yield* writeWords(body, [501, 20])
        yield* body.write(Xdr.array(Xdr.uint32), groups)
        const writer = requestWriter()
        yield* writer.write(Xdr.uint32, 1)
        yield* writer.write(Xdr.opaque(), yield* body.finish)

        return yield* writer.finish
      })

      const observed: Array<Parameters<NfsIdentityPolicy>[0]["credential"]> = []

      const inspect: NfsIdentityPolicy = ({ credential }) => {
        observed.push(credential)

        return null
      }

      const good = yield* rpcCompound(81, [operation(Operation.PUTROOTFH)], yield* credential([20, 80]))
      const oversized = yield* rpcCompound(82, [operation(Operation.PUTROOTFH)], yield* credential([1, 2, 3]))
      const { replies } = yield* serveChunks([good, oversized], { maxSupplementaryGroups: 2 }, inspect)
      assert.deepStrictEqual(observed, [{ flavor: "sys", uid: 501, gid: 20, groups: [20, 80], machineName: "machine" }])
      assert.deepStrictEqual(yield* Effect.forEach(replies, replyWords), [[81, 1, 1, 1, 7], [82, 1, 1, 1, 1]])
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("does not emit an RPC rejection that exceeds the configured record limit", () =>
    Effect.gen(function*() {
      const truncatedCall = encodeRecord(Uint8Array.of(0, 0, 0, 83, 0, 0, 0, 0))
      const normal = yield* serveChunks([truncatedCall])
      assert.deepStrictEqual(yield* Effect.forEach(normal.replies, replyWords), [[83, 1, 0, 0, 0, 4]])
      const limited = yield* serveChunks([truncatedCall], { maxRecordBytes: ByteSize.bytes(20) })
      assert.deepStrictEqual(limited, { replies: [], consumed: 1 })
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("closes a connection at fragment and record limits before reading the next chunk", () =>
    Effect.gen(function*() {
      const next = yield* rpcNull(70)
      const tooWide = new Uint8Array(4)
      new DataView(tooWide.buffer).setUint32(0, 0x8000_0000 + 1_025)

      const cases = [
        { prefix: [tooWide], override: {} },
        {
          prefix: [
            fragment(new Uint8Array(1_024), false),
            fragment(new Uint8Array(1_024), false),
            Uint8Array.of(128, 0, 0, 1)
          ],
          override: {}
        },
        {
          prefix: Array.from({ length: 3 }, () => fragment(new Uint8Array(), false)),
          override: { maxFragmentsPerRecord: 2 }
        }
      ]

      for (const { prefix, override } of cases) {
        const result = yield* serveChunks([...prefix, next], override)
        assert.deepStrictEqual(result, { replies: [], consumed: prefix.length })
      }

      const { replies } = yield* serveChunks([next])
      assert.deepStrictEqual(yield* Effect.forEach(replies, replyWords), [[70, 1, 0, 0, 0, 0]])
    }).pipe(Effect.provide(Testing.layer())))
})

const exchangeId = (owner: string) => (writer: RequestWriter) =>
  Effect.gen(function*() {
    yield* writer.write(Xdr.uint32, Operation.EXCHANGE_ID)
    yield* writer.write(Xdr.fixedOpaque(8), new Uint8Array(8))
    yield* writer.write(Xdr.string(), owner)
    yield* writeWords(writer, [0, 0, 0])
  })

const createSession = (client: bigint) => (writer: RequestWriter) =>
  Effect.gen(function*() {
    yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
    yield* writer.write(Xdr.uint64, client)
    yield* writeWords(writer, [1, 0])
    yield* Effect.forEach([2, 0], (slots) => writeWords(writer, [0, 1_024, 1_024, 1_024, 8, slots, 0]), {
      discard: true
    })
    yield* writeWords(writer, [0, 0])
  })

const afterHeader = Effect.fnUntraced(function*(record: Uint8Array) {
  const reader = yield* compoundReply(record)
  yield* reader.read(Xdr.uint32)
  yield* reader.read(Xdr.string())
  yield* skipWords(reader, 3)

  return reader
})

const readOnlySession = Effect.fnUntraced(function*(owner: string) {
  const volume = yield* Vfs.Volume
  const caller = yield* Vfs.Caller
  const socketServer = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })

  const server = yield* NfsServer.make(options(volume, caller)).pipe(
    Effect.provideService(SocketServer.SocketServer, socketServer)
  )

  const connection = yield* openConnection(tcpPort(server))
  yield* Effect.addFinalizer(() => connection.close)

  const exchange = Effect.fnUntraced(
    function*(xid: number, operations: ReadonlyArray<(writer: RequestWriter) => Effect.Effect<void>>) {
      const [reply] = yield* connection.send(yield* rpcCompound(xid, operations))
      assert.isDefined(reply)

      return reply
    }
  )

  const clientReply = yield* exchange(1, [exchangeId(owner)])
  assert.strictEqual(yield* firstOperationStatus(clientReply), Status.OK)
  const client = yield* (yield* afterHeader(clientReply)).read(Xdr.uint64)
  const sessionReply = yield* exchange(2, [createSession(client)])
  assert.strictEqual(yield* firstOperationStatus(sessionReply), Status.OK)
  const session = yield* (yield* afterHeader(sessionReply)).read(Xdr.fixedOpaque(16))
  let sequence = 0

  const compound = Effect.fnUntraced(
    function*(...operations: ReadonlyArray<(writer: RequestWriter) => Effect.Effect<void>>) {
      const index = ++sequence

      const reply = yield* exchange(index + 2, [
        (writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.SEQUENCE)
            yield* writer.write(Xdr.fixedOpaque(16), session)
            yield* writeWords(writer, [index, 0, 0, 0])
          }),
        ...operations
      ])

      const reader = yield* compoundReply(reply)
      const status = yield* reader.read(Xdr.uint32)
      yield* reader.read(Xdr.string())
      assert.isAtLeast(yield* reader.read(Xdr.uint32), 1)
      assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SEQUENCE)
      assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
      yield* reader.read(Xdr.fixedOpaque(16))
      yield* skipWords(reader, 5)

      return { status, reader }
    }
  )

  return { caller, compound }
})

const operation = (code: number) => (writer: RequestWriter) => writer.write(Xdr.uint32, code)

const namedOperation = (code: number, name: string) => (writer: RequestWriter) =>
  Effect.andThen(writer.write(Xdr.uint32, code), writer.write(Xdr.string(), name))

const readStatus = Effect.fnUntraced(function*(reader: ReplyReader, code: number, status: number = Status.OK) {
  assert.strictEqual(yield* reader.read(Xdr.uint32), code)
  assert.strictEqual(yield* reader.read(Xdr.uint32), status)
})

it.layer(NodeCrypto.layer)("read-only NFS operations over TCP", (it) => {
  it.effect("compares supplied file attributes with VERIFY and NVERIFY", () =>
    Effect.gen(function*() {
      const { caller, compound } = yield* readOnlySession("verify")
      yield* caller.writeFile("/file", Uint8Array.of(1, 2, 3), { access: "write", create: "exclusive" })

      for (
        const [code, bit, value, expected] of [
          [Operation.VERIFY, 4, 3n, Status.OK],
          [Operation.NVERIFY, 4, 3n, Status.SAME],
          [Operation.VERIFY, 4, 9n, Status.NOT_SAME],
          [Operation.NVERIFY, 4, 9n, Status.OK],
          [Operation.VERIFY, 1, 1, Status.OK],
          [Operation.VERIFY, 12, 0, Status.ATTRNOTSUPP],
          [Operation.VERIFY, 11, 0, Status.INVAL]
        ] as const
      ) {
        const attribute = requestWriter()

        if (Predicate.isBigInt(value)) yield* attribute.write(Xdr.uint64, value)
        else yield* attribute.write(Xdr.uint32, value)
        const encoded = yield* attribute.finish

        const compare = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, code)
          yield* writer.write(Xdr.array(Xdr.uint32), [1 << bit])
          yield* writer.write(Xdr.opaque(), encoded)
        })

        const result = yield* compound(
          operation(Operation.PUTROOTFH),
          namedOperation(Operation.LOOKUP, "file"),
          compare,
          operation(Operation.GETFH)
        )

        assert.strictEqual(result.status, expected)
        yield* readStatus(result.reader, Operation.PUTROOTFH)
        yield* readStatus(result.reader, Operation.LOOKUP)
        yield* readStatus(result.reader, code, expected)

        if (expected === Status.OK) {
          yield* readStatus(result.reader, Operation.GETFH)
          assert.isNotEmpty(yield* result.reader.read(Xdr.opaque()))
        }
      }
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("distinguishes reserved, malformed, and missing names", () =>
    Effect.gen(function*() {
      const { compound } = yield* readOnlySession("lookup-names")
      const utf8 = new TextEncoder()

      for (
        const [name, expected] of [
          [utf8.encode("."), Status.BADNAME],
          [utf8.encode(".."), Status.BADNAME],
          [Uint8Array.of(0xff, 0xfe), Status.INVAL],
          [utf8.encode("missing"), Status.NOENT]
        ] as const
      ) {
        const lookup = (writer: RequestWriter) =>
          Effect.andThen(writer.write(Xdr.uint32, Operation.LOOKUP), writer.write(Xdr.opaque(), name))

        const result = yield* compound(operation(Operation.PUTROOTFH), lookup)
        assert.strictEqual(result.status, expected)
        yield* readStatus(result.reader, Operation.PUTROOTFH)
        yield* readStatus(result.reader, Operation.LOOKUP, expected)
      }
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("scopes RECLAIM_COMPLETE to the current filehandle when one filesystem is requested", () =>
    Effect.gen(function*() {
      const { compound } = yield* readOnlySession("reclaim")

      const reclaim = (oneFs: boolean) => (writer: RequestWriter) =>
        Effect.andThen(writer.write(Xdr.uint32, Operation.RECLAIM_COMPLETE), writer.write(Xdr.boolean, oneFs))

      const selected = yield* compound(operation(Operation.PUTROOTFH), reclaim(true))
      assert.strictEqual(selected.status, Status.OK)
      assert.strictEqual((yield* compound(reclaim(true))).status, Status.NOFILEHANDLE)
      assert.strictEqual((yield* compound(reclaim(false))).status, Status.OK)
      assert.strictEqual((yield* compound(reclaim(false))).status, Status.COMPLETE_ALREADY)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("selects the root filehandle when a client sends PUTPUBFH", () =>
    Effect.gen(function*() {
      const { compound } = yield* readOnlySession("public-filehandle")

      const { status, reader } = yield* compound(
        operation(Operation.PUTROOTFH),
        operation(Operation.GETFH),
        operation(Operation.PUTPUBFH),
        operation(Operation.GETFH)
      )

      assert.strictEqual(status, Status.OK)
      yield* readStatus(reader, Operation.PUTROOTFH)
      yield* readStatus(reader, Operation.GETFH)
      const rootHandle = yield* reader.read(Xdr.opaque())
      yield* readStatus(reader, Operation.PUTPUBFH)
      yield* readStatus(reader, Operation.GETFH)
      assert.deepStrictEqual(yield* reader.read(Xdr.opaque()), rootHandle)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("returns a COMMIT verifier for a file and rejects a directory", () =>
    Effect.gen(function*() {
      const { caller, compound } = yield* readOnlySession("commit")
      yield* caller.writeFile("/file", Uint8Array.of(7), { access: "write", create: "exclusive" })

      const commit = Effect.fnUntraced(function*(writer: RequestWriter) {
        yield* writer.write(Xdr.uint32, Operation.COMMIT)
        yield* writer.write(Xdr.uint64, 0n)
        yield* writer.write(Xdr.uint32, 0)
      })

      const file = yield* compound(operation(Operation.PUTROOTFH), namedOperation(Operation.LOOKUP, "file"), commit)
      assert.strictEqual(file.status, Status.OK)
      yield* readStatus(file.reader, Operation.PUTROOTFH)
      yield* readStatus(file.reader, Operation.LOOKUP)
      yield* readStatus(file.reader, Operation.COMMIT)
      assert.strictEqual((yield* file.reader.read(Xdr.fixedOpaque(8))).length, 8)

      const directory = yield* compound(operation(Operation.PUTROOTFH), commit)
      assert.strictEqual(directory.status, Status.ISDIR)
      yield* readStatus(directory.reader, Operation.PUTROOTFH)
      yield* readStatus(directory.reader, Operation.COMMIT, Status.ISDIR)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("reports SECINFO flavors and clears the current filehandle", () =>
    Effect.gen(function*() {
      const { caller, compound } = yield* readOnlySession("secinfo")
      yield* caller.writeFile("/file", Uint8Array.of(7), { access: "write", create: "exclusive" })

      const result = yield* compound(
        operation(Operation.PUTROOTFH),
        namedOperation(Operation.SECINFO, "file"),
        operation(Operation.GETFH)
      )

      assert.strictEqual(result.status, Status.NOFILEHANDLE)
      yield* readStatus(result.reader, Operation.PUTROOTFH)
      yield* readStatus(result.reader, Operation.SECINFO)
      assert.deepStrictEqual(yield* result.reader.read(Xdr.array(Xdr.uint32)), [1, 0])
      yield* readStatus(result.reader, Operation.GETFH, Status.NOFILEHANDLE)

      const missing = yield* compound(operation(Operation.PUTROOTFH), namedOperation(Operation.SECINFO, "missing"))
      assert.strictEqual(missing.status, Status.NOENT)
      yield* readStatus(missing.reader, Operation.PUTROOTFH)
      yield* readStatus(missing.reader, Operation.SECINFO, Status.NOENT)
    }).pipe(Effect.provide(Testing.layer())))
})

const fileHandle = Effect.fnUntraced(function*(
  compound: Effect.Success<ReturnType<typeof readOnlySession>>["compound"],
  name: string
) {
  const { status, reader } = yield* compound(
    operation(Operation.PUTROOTFH),
    namedOperation(Operation.LOOKUP, name),
    operation(Operation.GETFH)
  )

  assert.strictEqual(status, Status.OK)
  yield* readStatus(reader, Operation.PUTROOTFH)
  yield* readStatus(reader, Operation.LOOKUP)
  yield* readStatus(reader, Operation.GETFH)

  return yield* reader.read(Xdr.opaque())
})

it.layer(NodeCrypto.layer)("filehandle lifetime over TCP", (it) => {
  it.effect("returns the same opaque filehandle through hard links and after rename", () =>
    Effect.gen(function*() {
      const { caller, compound } = yield* readOnlySession("handle-aliases")
      yield* caller.writeFile("/original", Uint8Array.of(7), { access: "write", create: "exclusive" })
      yield* caller.link("/original", "/alias")

      const handle = (name: string) => fileHandle(compound, name)
      const original = yield* handle("original")
      assert.notInclude(new TextDecoder().decode(original), "original")
      assert.deepStrictEqual(yield* handle("alias"), original)
      yield* caller.rename("/original", "/renamed")
      assert.deepStrictEqual(yield* handle("renamed"), original)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("accepts a filehandle after unlink while the object is open and rejects it after close", () =>
    Effect.gen(function*() {
      const { caller, compound } = yield* readOnlySession("held-filehandle")
      yield* caller.writeFile("/file", Uint8Array.of(7), { access: "write", create: "exclusive" })
      const opened = yield* caller.open("/file", { access: "read" })
      const handle = yield* fileHandle(compound, "file")

      const put = (writer: RequestWriter) =>
        Effect.andThen(writer.write(Xdr.uint32, Operation.PUTFH), writer.write(Xdr.opaque(), handle))

      yield* caller.unlink("/file")
      const retained = yield* compound(put, operation(Operation.GETFH))
      assert.strictEqual(retained.status, Status.OK)
      yield* readStatus(retained.reader, Operation.PUTFH)
      yield* readStatus(retained.reader, Operation.GETFH)
      assert.deepStrictEqual(yield* retained.reader.read(Xdr.opaque()), handle)

      yield* opened.close
      const released = yield* compound(put)
      assert.strictEqual(released.status, Status.STALE)
      yield* readStatus(released.reader, Operation.PUTFH, Status.STALE)
    }).pipe(Effect.provide(Testing.layer())))
})

it.layer(NodeCrypto.layer)("NfsServer", (it) => {
  it("should model configuration units and bounds with Schema when server configuration schemas decode defaults and bounds", () => {
    assert.isTrue(Schema.is(NfsServerLimits)(limits))
    assert.isTrue(Object.isFrozen(NfsServerLimits.default))
    assert.isTrue(Object.isFrozen(NfsServerLimits.constrained))
    assert.isTrue(Object.isFrozen(NfsServerConfig.default))
    assert.strictEqual(NfsServerConfig.default.leaseDurationSeconds, 30)
    assert.isFalse(
      Schema.is(NfsServerLimits)({ ...limits, maxReadBytes: 1_024 })
    )
    assert.isFalse(
      Schema.is(NfsServerLimits)({ ...limits, maxNameBytes: ByteSize.bytes(256) })
    )
    assert.isFalse(
      Schema.is(NfsServerLimits)({
        ...limits,
        maxFragmentBytes: ByteSize.bytes(0x8000_0000)
      })
    )
    assert.isTrue(
      Schema.is(NfsServerLimitOverrides)({
        maxReadBytes: ByteSize.bytes(1_024)
      })
    )
    assert.isFalse(Schema.is(NfsServerLimitOverrides)({ maxReadBytes: 1_024 }))
    assert.isTrue(
      Schema.is(NfsServerConfigOverrides)({ limits: { maxConnections: 2 } })
    )
    assert.isTrue(
      Schema.is(NfsServerConfig)({
        leaseDurationSeconds: 30,
        callbackTimeoutSeconds: 30,
        limits
      })
    )
    assert.isFalse(
      Schema.is(NfsServerConfig)({
        leaseDurationSeconds: 0,
        callbackTimeoutSeconds: 30,
        limits
      })
    )
    assert.isFalse(
      Schema.is(NfsServerConfig)({
        leaseDurationSeconds: 30,
        callbackTimeoutSeconds: 0,
        limits
      })
    )

    const withUnknownField = {
      host: "127.0.0.1" as const,
      port: 0,
      leaseDurationSeconds: 30,
      callbackTimeoutSeconds: 30,
      limits,
      unknown: true
    }

    assert.isTrue(
      Result.isFailure(
        Schema.decodeResult(NfsServerConfig, { onExcessProperty: "error" })(
          withUnknownField
        )
      )
    )
  })

  it.effect(
    "should reject transport options and invalid explicit limits before binding when transport options or explicit limits are invalid",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller

        const transportOption = yield* Effect.flip(
          NfsServer.make(
            // SAFETY: This test deliberately supplies an unsupported property to test boundary validation.
            // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime validation requires an invalid typed input.
            {
              ...options(volume, caller),
              host: "0.0.0.0"
            } as unknown as NfsServerOptions
          )
        )

        assert.instanceOf(transportOption, ConfigurationError)
        assert.strictEqual(transportOption.option, "host")

        const unknownOption = yield* Effect.flip(
          NfsServer.make(
            // SAFETY: This test deliberately supplies an unknown property to test boundary validation.
            // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime validation requires an invalid typed input.
            {
              ...options(volume, caller),
              unexpected: true
            } as unknown as NfsServerOptions
          )
        )

        assert.instanceOf(unknownOption, ConfigurationError)

        const invalidLimit = yield* Effect.flip(
          NfsServer.make({
            volume,
            caller,
            limits: { maxConnections: 0 }
          })
        )

        assert.instanceOf(invalidLimit, ConfigurationError)
        assert.strictEqual(invalidLimit.option, "limits.maxConnections")

        const invalidPendingReplacements = yield* Effect.flip(
          NfsServer.make({
            volume,
            caller,
            limits: { maxPendingClientReplacements: 0 }
          })
        )

        assert.instanceOf(invalidPendingReplacements, ConfigurationError)
        assert.strictEqual(
          invalidPendingReplacements.option,
          "limits.maxPendingClientReplacements"
        )

        const otherVolume = yield* Vfs.make()

        const mismatched = yield* Effect.flip(
          NfsServer.make(options(volume, yield* otherVolume.caller()))
        )

        assert.instanceOf(mismatched, ConfigurationError)
        assert.strictEqual(mismatched.option, "caller")

        const callerScope = yield* Scope.make()

        const scopedCaller = yield* caller
          .withDirectory("/")
          .pipe(Scope.provide(callerScope))

        yield* Scope.close(callerScope, Exit.void)

        const closed = yield* Effect.flip(
          NfsServer.make(options(volume, scopedCaller))
        )

        assert.instanceOf(closed, ConfigurationError)
        assert.strictEqual(closed.option, "caller")
      }).pipe(
        Effect.provideService(SocketServer.SocketServer, testSocketServer),
        Effect.provide(Testing.layer())
      )
  )

  it.effect("should refuse writable export when the volume cannot promise power-loss durability", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume

      const error = yield* Effect.flip(NfsServer.make({
        volume,
        writable: true,
        peer: Effect.succeed({ transport: "tcp" as const, address: "127.0.0.1", port: 2049 }),
        policy: () => ({ uid: 0, gid: 0, groups: [], privileged: true })
      }))

      assert.instanceOf(error, ConfigurationError)
      assert.strictEqual(error.option, "volume.durability")
    }).pipe(Effect.provideService(SocketServer.SocketServer, testSocketServer), Effect.provide(Testing.layer())))

  it.effect("should require an explicit identity policy for writable export when a writable export omits its identity policy", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume

      // SAFETY: This test deliberately passes the forbidden local writable option to exercise runtime validation.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime validation requires an invalid typed input.
      const error = yield* Effect.flip(NfsServer.make({
        volume: { ...volume, durability: "survives-power-loss" },
        writable: true
      } as unknown as NfsServerOptions))

      assert.instanceOf(error, ConfigurationError)
      assert.strictEqual(error.option, "policy")
    }).pipe(Effect.provideService(SocketServer.SocketServer, testSocketServer), Effect.provide(Testing.layer())))

  it.effect("should accept a socket server bound to a UNIX-domain socket path as a local address when the socket server is bound to a UNIX path", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller

      const unix = SocketServer.SocketServer.of({
        address: NetAddress.unixPathAddress("/tmp/effect-vfs-nfs.sock"),
        run: () => Effect.never
      })

      const server = yield* NfsServer.make(options(volume, caller)).pipe(
        Effect.provideService(SocketServer.SocketServer, unix)
      )

      assert.deepStrictEqual(server.address, { path: "/tmp/effect-vfs-nfs.sock" })
    }).pipe(Effect.scoped, Effect.provide(Testing.layer())))

  for (const delayed of [false, true]) {
    it.effect(`reports ${delayed ? "a later" : "an immediate"} listener failure through awaitTermination`, () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        const address = NetAddress.inetAddressUnsafe(NetAddress.ipv4Loopback, 2049)

        const socketError = new SocketServer.SocketServerError({
          reason: new SocketServer.SocketServerUnknownError({ cause: "listener failed" })
        })

        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const socketServer = SocketServer.SocketServer.of({
          address,
          run: () =>
            delayed
              ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.fail(socketError))
              )
              : Effect.fail(socketError)
        })

        const server = yield* NfsServer.make(options(volume, caller)).pipe(
          Effect.provideService(SocketServer.SocketServer, socketServer)
        )

        assert.deepStrictEqual(server.address, { host: "127.0.0.1", port: 2049 })

        if (delayed) {
          yield* Deferred.await(started)
          const waiting = yield* Effect.forkChild(server.awaitTermination, { startImmediately: true })
          yield* Fiber.interrupt(waiting)
          yield* Deferred.succeed(release, undefined)
        }

        const failure = yield* Effect.flip(server.awaitTermination)
        assert.instanceOf(failure, NfsServerError)
        assert.strictEqual(failure.cause, socketError)
      }).pipe(Effect.provide(Testing.layer())))
  }

  it.effect("should reject a socket server that is not bound to loopback TCP when the socket server is bound beyond loopback TCP", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller

      const nonLoopback = SocketServer.SocketServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("0.0.0.0", 2049),
        run: () => Effect.never
      })

      const error = yield* NfsServer.make(options(volume, caller)).pipe(
        Effect.provideService(SocketServer.SocketServer, nonLoopback),
        Effect.flip
      )

      assert.instanceOf(error, ConfigurationError)
      assert.strictEqual(error.option, "policy")
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should require both network policy and explicit opt-in for a non-loopback bind when a non-loopback bind is requested", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume

      const nonLoopback = SocketServer.SocketServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("0.0.0.0", 2049),
        run: () => Effect.never
      })

      const peer = Effect.succeed({ transport: "tcp", address: "192.0.2.10", port: 1234 } as const)
      const policy = () => ({ uid: 1000, gid: 1000, groups: [], privileged: false })

      const withoutFlag = yield* NfsServer.make({ volume, policy, peer }).pipe(
        Effect.provideService(SocketServer.SocketServer, nonLoopback),
        Effect.flip
      )

      assert.instanceOf(withoutFlag, ConfigurationError)
      assert.strictEqual(withoutFlag.option, "allowNonLoopback")

      // SAFETY: This test deliberately omits policy to exercise runtime validation.
      const withoutPolicy = yield* NfsServer.make({
        volume,
        peer,
        allowNonLoopback: true
      } as NfsServerOptions).pipe(
        Effect.provideService(SocketServer.SocketServer, nonLoopback),
        Effect.flip
      )

      assert.instanceOf(withoutPolicy, ConfigurationError)
      assert.strictEqual(withoutPolicy.option, "options")

      const server = yield* NfsServer.make({ volume, policy, peer, allowNonLoopback: true }).pipe(
        Effect.provideService(SocketServer.SocketServer, nonLoopback)
      )

      assert.deepStrictEqual(server.address, { host: "0.0.0.0", port: 2049 })
    }).pipe(Effect.scoped, Effect.provide(Testing.layer())))

  live(
    "should pass the accepted TCP peer to the identity policy when a TCP client is accepted",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const socketServer = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
        let observed: Parameters<NfsIdentityPolicy>[0] | undefined
        const acceptedFlavors: Array<"sys" | "none"> = ["none"]

        const peer = Effect.map(
          Effect.serviceOption(NodeSocket.NetSocket),
          Option.match({
            onNone: () => null,
            onSome: (socket) =>
              socket.remoteAddress === undefined || socket.remotePort === undefined
                ? null
                : { transport: "tcp" as const, address: socket.remoteAddress, port: socket.remotePort }
          })
        )

        const server = yield* NfsServer.make({
          volume,
          peer,
          acceptedFlavors,
          policy: (request) => {
            observed = request

            return { uid: 1000, gid: 1000, groups: [], privileged: false }
          }
        }).pipe(Effect.provideService(SocketServer.SocketServer, socketServer))

        acceptedFlavors[0] = "sys"

        const response = yield* exchange(
          { port: tcpPort(server) },
          yield* rpcCompound(71, [
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)
          ])
        )

        assert.strictEqual(response.length, 1)
        const tcpPeer = observed?.peer

        if (tcpPeer?.transport !== "tcp") throw new Error("expected TCP peer")
        assert.ok(tcpPeer.port > 0)
        assert.deepStrictEqual(observed, {
          credential: { flavor: "none" },
          peer: { transport: "tcp", address: "127.0.0.1", port: tcpPeer.port }
        })
      }).pipe(Effect.provide(Testing.layer()))
  )

  live(
    "should pass a UNIX peer with no invented client address to the identity policy when a UNIX client is accepted",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const nonce = yield* (yield* SecureRandom.SecureRandom).randomBytes(8)
        const path = `/tmp/effect-vfs-nfs-${process.pid}-${Hex.encode(nonce)}.sock`
        const socketServer = yield* NodeSocketServer.make({ path })
        let observed: unknown

        const peer = Effect.map(
          Effect.serviceOption(NodeSocket.NetSocket),
          Option.match({
            onNone: () => null,
            onSome: () => ({ transport: "unix" as const, address: null, port: null, path })
          })
        )

        yield* NfsServer.make({
          volume,
          peer,
          acceptedFlavors: ["none"],
          policy: (request) => {
            observed = request

            return { uid: 1000, gid: 1000, groups: [], privileged: false }
          }
        }).pipe(Effect.provideService(SocketServer.SocketServer, socketServer))

        const response = yield* exchange(
          { path },
          yield* rpcCompound(72, [
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)
          ])
        )

        assert.strictEqual(response.length, 1)
        assert.deepStrictEqual(observed, {
          credential: { flavor: "none" },
          peer: { transport: "unix", address: null, port: null, path }
        })
      }).pipe(Effect.provide(Testing.layer()))
  )

  live(
    "should bound mapped callers and give policy denial the same RPC response when policy denies or mapped-caller capacity is exhausted",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const socketServer = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })

        const peer = Effect.map(
          Effect.serviceOption(NodeSocket.NetSocket),
          Option.match({
            onNone: () => null,
            onSome: (socket) =>
              socket.remoteAddress === undefined || socket.remotePort === undefined
                ? null
                : { transport: "tcp" as const, address: socket.remoteAddress, port: socket.remotePort }
          })
        )

        const server = yield* NfsServer.make({
          volume,
          peer,
          limits: { maxIdentities: 1 },
          policy: ({ credential }) =>
            credential.flavor === "sys" && credential.uid !== 2000
              ? { uid: credential.uid, gid: credential.gid, groups: [], privileged: false }
              : null
        }).pipe(Effect.provideService(SocketServer.SocketServer, socketServer))

        const request = Effect.fnUntraced(function*(xid: number, uid: number) {
          const credential = yield* authSysCredential(uid)

          return yield* rpcCompound(xid, [
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)
          ], credential)
        })

        const allowed = (yield* exchange({ port: tcpPort(server) }, yield* request(81, 1000)))[0]!
        const deniedByPolicy = (yield* exchange({ port: tcpPort(server) }, yield* request(82, 2000)))[0]!
        const deniedByLimit = (yield* exchange({ port: tcpPort(server) }, yield* request(83, 3000)))[0]!

        const fields = Effect.fnUntraced(function*(bytes: Uint8Array) {
          const reader = replyReader(bytes)

          return yield* Effect.forEach(Array.from({ length: 5 }), () => reader.read(Xdr.uint32))
        })

        assert.deepStrictEqual((yield* fields(allowed)).slice(0, 3), [81, 1, 0])
        assert.deepStrictEqual(yield* fields(deniedByPolicy), [82, 1, 1, 1, 7])
        assert.deepStrictEqual(yield* fields(deniedByLimit), [83, 1, 1, 1, 7])
      }).pipe(Effect.provide(Testing.layer()))
  )

  live(
    "should bind an ephemeral loopback port, serve RPC, and release the port with its scope when an ephemeral loopback listener is scoped",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        const firstScope = yield* Scope.make()

        const firstSocketServer = yield* NodeSocketServer.make({
          host: "127.0.0.1",
          port: 0
        }).pipe(Scope.provide(firstScope))

        const first = yield* NfsServer.make({
          volume,
          caller,
          limits: { maxFragmentBytes: limits.maxFragmentBytes }
        }).pipe(
          Effect.provideService(SocketServer.SocketServer, firstSocketServer),
          Scope.provide(firstScope)
        )

        assert.deepStrictEqual("host" in first.address && first.address.host, "127.0.0.1")
        assert.notStrictEqual(tcpPort(first), 0)

        const responses = yield* exchange(
          { port: tcpPort(first) },
          concat(yield* rpcNull(91), yield* rpcNull(92)),
          2
        )

        assert.deepStrictEqual(
          responses.map((response) =>
            new DataView(
              response.buffer,
              response.byteOffset,
              response.byteLength
            ).getUint32(0)
          ),
          [91, 92]
        )

        const oversizedMarker = new Uint8Array(4)
        new DataView(oversizedMarker.buffer).setUint32(
          0,
          0x8000_0000 | (ByteSize.toNumberUnsafe(limits.maxFragmentBytes) + 1)
        )
        yield* awaitRejectedConnection(tcpPort(first), oversizedMarker)
        const afterMalformed = yield* exchange({ port: tcpPort(first) }, yield* rpcNull(93))
        assert.strictEqual(
          new DataView(
            afterMalformed[0]!.buffer,
            afterMalformed[0]!.byteOffset,
            afterMalformed[0]!.byteLength
          ).getUint32(0),
          93
        )
        yield* Scope.close(firstScope, Exit.void)

        const secondScope = yield* Scope.make()

        const secondSocketServer = yield* NodeSocketServer.make({
          host: "127.0.0.1",
          port: tcpPort(first)
        }).pipe(Scope.provide(secondScope))

        const second = yield* NfsServer.make(
          options(volume, caller)
        ).pipe(
          Effect.provideService(SocketServer.SocketServer, secondSocketServer),
          Scope.provide(secondScope)
        )

        assert.strictEqual(tcpPort(second), tcpPort(first))
        yield* Scope.close(secondScope, Exit.void)
      }).pipe(Effect.provide(Testing.layer()))
  )

  it.effect("should give each concurrently open socket its own connection identity when sockets connect concurrently", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      const scope = yield* Scope.make()

      const socketServer = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(Scope.provide(scope))

      const server = yield* NfsServer.make(options(volume, caller)).pipe(
        Effect.provideService(SocketServer.SocketServer, socketServer),
        Scope.provide(scope)
      )

      const destroySession = (session: Uint8Array) => (writer: RequestWriter) =>
        Effect.gen(function*() {
          yield* writer.write(Xdr.uint32, Operation.DESTROY_SESSION)
          yield* writer.write(Xdr.fixedOpaque(16), session)
        })

      // Both sockets stay open for the whole test, so neither one's close can mask the other's
      // identity by disassociating it early.
      const owner = yield* openConnection(tcpPort(server))
      const stranger = yield* openConnection(tcpPort(server))

      const clientReply = (yield* owner.send(yield* rpcCompound(1, [exchangeId("owner")])))[0]!
      const client = yield* (yield* afterHeader(clientReply)).read(Xdr.uint64)
      const sessionReply = (yield* owner.send(yield* rpcCompound(2, [createSession(client)])))[0]!
      const session = yield* (yield* afterHeader(sessionReply)).read(Xdr.fixedOpaque(16))

      // The stranger socket presents a valid session id it never carried. If every socket shared
      // one Connection this would answer NFS4_OK.
      const refused = yield* stranger.send(yield* rpcCompound(3, [destroySession(session)]))
      assert.strictEqual(yield* firstOperationStatus(refused[0]!), Status.CONN_NOT_BOUND_TO_SESSION)

      // The socket that created the session may destroy it.
      const accepted = yield* owner.send(yield* rpcCompound(4, [destroySession(session)]))
      assert.strictEqual(yield* firstOperationStatus(accepted[0]!), Status.OK)

      yield* owner.close
      yield* stranger.close
      yield* Scope.close(scope, Exit.void)
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should close a connection it has no permit for instead of abandoning it when connection permits are exhausted", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      const scope = yield* Scope.make()

      const socketServer = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(Scope.provide(scope))

      // One permit, so the second connection is refused.
      const server = yield* NfsServer.make({ ...options(volume, caller), limits: { maxConnections: 1 } }).pipe(
        Effect.provideService(SocketServer.SocketServer, socketServer),
        Scope.provide(scope)
      )

      const held = yield* openConnection(tcpPort(server))
      const answered = yield* held.send(yield* rpcNull(1))
      assert.strictEqual(new DataView(answered[0]!.buffer, answered[0]!.byteOffset, 4).getUint32(0), 1)

      // Without an explicit refusal this connection is accepted and then abandoned, so it never
      // closes and this times out rather than failing an assertion.
      yield* awaitRejectedConnection(tcpPort(server), yield* rpcNull(2)).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.die("a refused connection was never closed")
        })
      )

      // The permit is still held, so the server keeps serving the connection that has it.
      const stillServing = yield* held.send(yield* rpcNull(3))
      assert.strictEqual(new DataView(stillServing[0]!.buffer, stillServing[0]!.byteOffset, 4).getUint32(0), 3)

      // Shutting down while a connection is still live must not hang waiting on it.
      yield* Scope.close(scope, Exit.void).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.die("shutdown did not complete with a live connection")
        })
      )

      yield* server.awaitTermination
      yield* held.close
    }).pipe(Effect.provide(Testing.layer())))

  it.effect("should send a callback down the backchannel and accept the client's reply over TCP when a callback round trip uses TCP", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.Volume
      const caller = yield* Vfs.Caller
      const scope = yield* Scope.make()

      const socketServer = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(Scope.provide(scope))

      const server = yield* NfsServer.make(options(volume, caller)).pipe(
        Effect.provideService(SocketServer.SocketServer, socketServer),
        Scope.provide(scope)
      )

      const client = yield* openConnection(tcpPort(server))

      const exchangeId = Effect.fnUntraced(function*(writer: RequestWriter) {
        yield* writer.write(Xdr.uint32, Operation.EXCHANGE_ID)
        yield* writer.write(Xdr.fixedOpaque(8), new Uint8Array(8))
        yield* writer.write(Xdr.string(), "cb")
        yield* writeWords(writer, [0, 0, 0])
      })

      const identity = yield* client.send(yield* rpcCompound(1, [exchangeId]))
      const idReader = yield* compoundReply(identity[0]!)
      yield* idReader.read(Xdr.uint32)
      yield* idReader.read(Xdr.string())
      yield* skipWords(idReader, 3)
      const clientId = yield* idReader.read(Xdr.uint64)

      // CREATE_SESSION asking for CONN_BACK_CHAN, with a real callback program number.
      const created = yield* client.send(
        yield* rpcCompound(2, [(writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
            yield* writer.write(Xdr.uint64, clientId)
            yield* writeWords(writer, [1, 2])
            yield* Effect.forEach([2, 2], (slots) => writeWords(writer, [0, 1_024, 1_024, 1_024, 8, slots, 0]), {
              discard: true
            })

            // csa_sec_parms authorizing AUTH_NONE for callbacks (Section 18.36.3).
            yield* writer.write(Xdr.uint32, 0x4000_0001)
            yield* writer.write(Xdr.array(Xdr.uint32), [0])
          })])
      )

      const sessionReader = yield* compoundReply(created[0]!)
      yield* sessionReader.read(Xdr.uint32)
      yield* sessionReader.read(Xdr.string())
      yield* skipWords(sessionReader, 3)
      const session = yield* sessionReader.read(Xdr.fixedOpaque(16))
      assert.strictEqual(yield* sessionReader.read(Xdr.uint32), 1, "csr_sequence")
      assert.strictEqual(yield* sessionReader.read(Xdr.uint32), 2, "csr_flags echoes CONN_BACK_CHAN")

      // The first SEQUENCE triggers the probe, so this exchange yields two records: the SEQUENCE
      // reply and the server's CB_COMPOUND arriving on the same connection.
      const both = yield* client.send(
        yield* rpcCompound(3, [
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.SEQUENCE)
              yield* writer.write(Xdr.fixedOpaque(16), session)
              yield* writeWords(writer, [1, 0, 1])
              yield* writer.write(Xdr.boolean, false)
            })
        ]),
        2
      )

      const callback = both.find((record) => {
        const view = new DataView(record.buffer, record.byteOffset, record.byteLength)

        return view.getUint32(4) === 0
      })

      assert.isDefined(callback, "the server sent a CALL down the backchannel")
      const cb = replyReader(callback)
      const callbackXid = yield* cb.read(Xdr.uint32)
      yield* cb.read(Xdr.uint32)
      assert.strictEqual(yield* cb.read(Xdr.uint32), 2, "RPC version")
      assert.strictEqual(yield* cb.read(Xdr.uint32), 0x4000_0001, "callback program")
      assert.strictEqual(yield* cb.read(Xdr.uint32), 1, "callback version is 1 per erratum 2291")
      assert.strictEqual(yield* cb.read(Xdr.uint32), 1, "CB_COMPOUND procedure")

      // Read the CB_SEQUENCE the server asked, so the answer echoes the session, sequence and
      // slot it was given. Anything less is not a reply the server may accept.
      yield* cb.read(Xdr.uint32)
      yield* cb.read(Xdr.opaque())
      yield* cb.read(Xdr.uint32)
      yield* cb.read(Xdr.opaque())
      yield* cb.read(Xdr.string())
      yield* skipWords(cb, 2)
      assert.strictEqual(yield* cb.read(Xdr.uint32), 1, "one callback operation")
      assert.strictEqual(yield* cb.read(Xdr.uint32), 11, "OP_CB_SEQUENCE")
      const callbackSession = yield* cb.read(Xdr.fixedOpaque(16))
      const callbackSequence = yield* cb.read(Xdr.uint32)
      const callbackSlot = yield* cb.read(Xdr.uint32)

      // Answer it exactly as a client would, and the server must accept the reply rather than
      // treating it as a request.
      const replyWriter = requestWriter()
      yield* writeWords(replyWriter, [callbackXid, 1, 0, 0])
      yield* replyWriter.write(Xdr.opaque(), new Uint8Array())
      yield* writeWords(replyWriter, [0, 0])
      yield* replyWriter.write(Xdr.string(), "probe")
      yield* writeWords(replyWriter, [1, 11, 0])
      yield* replyWriter.write(Xdr.fixedOpaque(16), callbackSession)
      yield* writeWords(replyWriter, [callbackSequence, callbackSlot, callbackSlot, callbackSlot])
      const reply = yield* replyWriter.finish

      yield* client.sendWithoutReply(encodeRecord(reply))

      // The connection still serves ordinary traffic afterwards, proving the reply was routed and
      // not mistaken for a call.
      const after = yield* client.send(
        yield* rpcCompound(4, [
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.SEQUENCE)
              yield* writer.write(Xdr.fixedOpaque(16), session)
              yield* writeWords(writer, [2, 0, 1])
              yield* writer.write(Xdr.boolean, false)
            })
        ])
      )

      assert.strictEqual(yield* firstOperationStatus(after[0]!), Status.OK)

      // And the server accepted that reply as a working callback path: sr_status_flags is clear
      // rather than carrying SEQ4_STATUS_CB_PATH_DOWN_SESSION.
      const status = yield* compoundReply(after[0]!)
      yield* status.read(Xdr.uint32)
      yield* status.read(Xdr.string())
      yield* skipWords(status, 3)
      yield* status.read(Xdr.fixedOpaque(16))
      yield* skipWords(status, 4)

      assert.strictEqual(yield* status.read(Xdr.uint32), 0, "the callback path is reported up")

      yield* client.close
      yield* Scope.close(scope, Exit.void)
    }).pipe(Effect.provide(Testing.layer())))
})

const call = Effect.fnUntraced(
  function*(
    operations: ReadonlyArray<WriteOperation>,
    tag = "probe",
    on: WireConnection = defaultConnection,
    credentials: Credentials = { _tag: "None" }
  ) {
    const writer = requestWriter()
    yield* writer.write(Xdr.string(), tag)
    yield* writer.write(Xdr.uint32, 1)
    yield* writer.write(Xdr.uint32, operations.length)

    for (const operation of operations) yield* operation(writer)

    return { connection: on, credentials, arguments: yield* writer.finish }
  }
)

const callbackProgram = 0x4000_0001

const sessionLimits: NfsServerLimitOverrides = {
  maxOpaqueBytes: ByteSize.bytes(65_536),
  maxStringBytes: ByteSize.bytes(1_024),
  maxArrayElements: 128,
  maxRecordBytes: ByteSize.bytes(65_536),
  maxCompoundBytes: ByteSize.bytes(65_536),
  maxOperations: 32,
  maxBitmapWords: 4,
  maxClients: 4,
  maxPendingClientReplacements: 1,
  maxSessions: 4,
  maxSlotsPerSession: 4,
  maxReplayBytes: ByteSize.bytes(65_536),
  maxOpens: 8,
  maxLockOwners: 8,
  maxLocks: 32,
  maxOwnerBytes: ByteSize.bytes(1_024),
  maxReadBytes: ByteSize.bytes(4_096),
  maxWriteBytes: ByteSize.bytes(4_096),
  maxReaddirEntries: 32,
  maxReaddirReplyBytes: ByteSize.bytes(16_384),
  maxNameBytes: ByteSize.bytes(255)
}

const statuses = Effect.fnUntraced(function*(response: Uint8Array) {
  const reader = replyReader(response)
  const status = yield* reader.read(Xdr.uint32)
  const tag = yield* reader.read(Xdr.string())
  const count = yield* reader.read(Xdr.uint32)
  const operations: Array<readonly [number, number]> = []

  for (let index = 0; index < count; index++) {
    const code = yield* reader.read(Xdr.uint32)
    const operationStatus = yield* reader.read(Xdr.uint32)
    operations.push([code, operationStatus])

    if (operationStatus === Status.OK && code === Operation.GETFH) yield* reader.read(Xdr.opaque())

    if (operationStatus === Status.OK && code === Operation.SEQUENCE) {
      yield* reader.read(Xdr.fixedOpaque(16))

      for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
    }
  }

  return { status, tag, operations }
})

const ownerExchange = (owner: string, verifier = new Uint8Array(8)): WriteOperation => (writer) =>
  Effect.gen(function*() {
    yield* writer.write(Xdr.uint32, Operation.EXCHANGE_ID)
    yield* writer.write(Xdr.fixedOpaque(8), verifier)
    yield* writer.write(Xdr.string(), owner)
    yield* writer.write(Xdr.uint32, 0)
    yield* writer.write(Xdr.uint32, 0)
    yield* writer.write(Xdr.uint32, 0)
  })

const channel = Effect.fnUntraced(function*(writer: RequestWriter, slots: number, options: Partial<{
  readonly maxRequest: number
  readonly maxResponse: number
  readonly maxCachedResponse: number
  readonly maxOperations: number
}> = {}) {
  yield* writer.write(Xdr.uint32, 0)
  yield* writer.write(Xdr.uint32, options.maxRequest ?? 65_536)
  yield* writer.write(Xdr.uint32, options.maxResponse ?? 65_536)
  yield* writer.write(Xdr.uint32, options.maxCachedResponse ?? 65_536)
  yield* writer.write(Xdr.uint32, options.maxOperations ?? 32)
  yield* writer.write(Xdr.uint32, slots)
  yield* writer.write(Xdr.uint32, 0)
})

const authSysCallback = Effect.fnUntraced(function*(writer: RequestWriter) {
  yield* writer.write(Xdr.uint32, 1)
  yield* writer.write(Xdr.uint32, 0x6aa6_6b2d)
  yield* writer.write(Xdr.string(), "Lloyds-Mech.local")
  yield* writer.write(Xdr.uint32, 0)
  yield* writer.write(Xdr.uint32, 0)
  yield* writer.write(Xdr.array(Xdr.uint32), Array.from({ length: 16 }, (_, index) => index))
})

const startSession = Effect.fnUntraced(
  function*(
    handler: WireClient,
    owner: string,
    fore: Parameters<typeof channel>[2] = {},
    verifier = new Uint8Array(8),
    on: WireConnection = defaultConnection,
    backSlots = 0,
    security: WriteOperation = (writer) => writer.write(Xdr.array(Xdr.uint32), [0]),
    credentials: Credentials = { _tag: "None" }
  ) {
    const exchange = replyReader(
      yield* handler.send(yield* call([ownerExchange(owner, verifier)], "probe", on, credentials))
    )

    assert.strictEqual(yield* exchange.read(Xdr.uint32), Status.OK)
    yield* exchange.read(Xdr.string())
    yield* exchange.read(Xdr.uint32)
    yield* exchange.read(Xdr.uint32)
    yield* exchange.read(Xdr.uint32)
    const client = yield* exchange.read(Xdr.uint64)

    const create = yield* handler.send(
      yield* call(
        [(writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
            yield* writer.write(Xdr.uint64, client)
            yield* writer.write(Xdr.uint32, 1)
            yield* writer.write(Xdr.uint32, backSlots > 0 ? 2 : 0)
            yield* channel(writer, 2, fore)
            yield* channel(writer, backSlots)
            yield* writer.write(Xdr.uint32, callbackProgram)
            yield* security(writer)
          })],
        "probe",
        on,
        credentials
      )
    )

    const response = replyReader(create)
    assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
    yield* response.read(Xdr.string())
    yield* response.read(Xdr.uint32)
    yield* response.read(Xdr.uint32)
    yield* response.read(Xdr.uint32)

    return { client, session: yield* response.read(Xdr.fixedOpaque(16)) }
  }
)

const sequence = (session: Uint8Array, sequence: number, cache = false, slot = 0): WriteOperation => (writer) =>
  Effect.gen(function*() {
    yield* writer.write(Xdr.uint32, Operation.SEQUENCE)
    yield* writer.write(Xdr.fixedOpaque(16), session)
    yield* writer.write(Xdr.uint32, sequence)
    yield* writer.write(Xdr.uint32, slot)
    yield* writer.write(Xdr.uint32, 1)
    yield* writer.write(Xdr.boolean, cache)
  })

const openByName = (client: bigint, name: string, access = 1, deny = 0): WriteOperation => (writer) =>
  Effect.gen(function*() {
    yield* writer.write(Xdr.uint32, Operation.OPEN)
    yield* writer.write(Xdr.uint32, 0)
    yield* writer.write(Xdr.uint32, access)
    yield* writer.write(Xdr.uint32, deny)
    yield* writer.write(Xdr.uint64, client)
    yield* writer.write(Xdr.string(), "owner")
    yield* writer.write(Xdr.uint32, 0)
    yield* writer.write(Xdr.uint32, 0)
    yield* writer.write(Xdr.string(), name)
  })

const openReadOnly = (client: bigint, name: string) => openByName(client, name)

const parseOpen = Effect.fnUntraced(function*(bytes: Uint8Array) {
  const reader = replyReader(bytes)
  assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
  yield* reader.read(Xdr.string())
  yield* reader.read(Xdr.uint32)
  assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SEQUENCE)
  assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
  yield* reader.read(Xdr.fixedOpaque(16))

  for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
  assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.PUTROOTFH)
  assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
  assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.OPEN)
  assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
  const stateid = yield* reader.read(Xdr.fixedOpaque(16))
  const atomic = yield* reader.read(Xdr.boolean)
  yield* reader.read(Xdr.uint64)
  yield* reader.read(Xdr.uint64)
  yield* reader.read(Xdr.uint32)
  yield* reader.read(Xdr.array(Xdr.uint32))
  yield* reader.read(Xdr.uint32)
  assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.GETFH)
  assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)

  return { stateid, atomic, filehandle: yield* reader.read(Xdr.opaque()) }
})

const stateidWithSequence = (stateid: Uint8Array, sequence: number) => {
  const copy = new Uint8Array(stateid)
  new DataView(copy.buffer).setUint32(0, sequence)

  return copy
}

interface WireConnection {
  readonly id: number
}

const connection = (id = 0): WireConnection => ({ id })

const defaultConnection = connection()

type Credentials = { readonly _tag: "None" } | {
  readonly _tag: "Sys"
  readonly stamp: number
  readonly machineName: string
  readonly uid: number
  readonly gid: number
  readonly supplementaryGroups: ReadonlyArray<number>
}

type WriteOperation = (writer: RequestWriter) => Effect.Effect<void>

const wireClient = Effect.fnUntraced(function*(caller: Vfs.Caller, configuration: {
  readonly limits?: NfsServerLimitOverrides
  readonly writable?: boolean
  readonly mappedCaller?: Vfs.Caller
  readonly leaseDurationSeconds?: number
  readonly now?: () => number
  readonly generation?: Uint8Array
  readonly storageGeneration?: Uint8Array
} = {}) {
  const source = yield* Vfs.Volume

  const volume = configuration.storageGeneration === undefined
    ? source
    : { ...source, incarnation: Vfs.VolumeIncarnation.make(Hex.encode(configuration.storageGeneration)) }

  const scope = yield* Effect.scope
  const listener = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })

  const serverLimits = {
    ...limits,
    ...sessionLimits,
    maxFragmentBytes: ByteSize.bytes(65_536),
    ...configuration.limits
  }

  const makeServer = NfsServer.make(
    configuration.writable
      ? {
        // For in-memory fixtures this flag only opens the writable protocol profile.
        // Tests that assert commit outcomes use LiveVolume with a scripted store.
        volume: {
          ...volume,
          durability: "survives-power-loss",
          caller: (selected) =>
            selected?.identity !== undefined && configuration.mappedCaller !== undefined
              ? Effect.succeed(configuration.mappedCaller)
              : volume.caller(selected)
        },
        writable: true,
        limits: serverLimits,
        leaseDurationSeconds: configuration.leaseDurationSeconds ?? 30,
        acceptedFlavors: ["none", "sys"],
        peer: Effect.succeed({ transport: "tcp", address: "127.0.0.1", port: 1 }),
        policy: () => ({ uid: 0, gid: 0, groups: [], privileged: true })
      }
      : {
        ...options(volume, caller),
        limits: serverLimits,
        leaseDurationSeconds: configuration.leaseDurationSeconds ?? 30
      }
  ).pipe(
    Effect.provideService(SocketServer.SocketServer, listener)
  )

  const generation = configuration.generation

  const provisioned = generation === undefined
    ? makeServer
    : makeServer.pipe(Effect.provideService(SecureRandom.SecureRandom, SecureRandom.make(() => generation.slice())))

  const now = configuration.now

  const server = yield* (now === undefined ? provisioned : Effect.acquireUseRelease(
    Effect.sync(() => {
      // The listener captures the host clock at startup.
      const original = Date.now
      Date.now = now

      return original
    }),
    () => provisioned,
    (original) =>
      Effect.sync(() => {
        Date.now = original
      })
  ))

  const connections = new Map<number, OpenConnection>()
  let xid = 0

  return {
    close: (peer: WireConnection) =>
      Effect.suspend(() => {
        const socket = connections.get(peer.id)
        connections.delete(peer.id)

        return socket?.close ?? Effect.void
      }),
    send: Effect.fnUntraced(function*(request: Effect.Success<ReturnType<typeof call>>) {
      let socket = connections.get(request.connection.id)

      if (socket === undefined) {
        const connected = yield* openConnection(tcpPort(server))
        yield* Scope.addFinalizer(scope, connected.close)
        connections.set(request.connection.id, connected)
        socket = connected
      }

      const current = ++xid
      const writer = requestWriter()
      yield* writeWords(writer, [current, 0, 2, 100003, 4, 1])
      const credential = request.credentials

      if (!("uid" in credential)) {
        yield* writeWords(writer, [0, 0])
      } else {
        const body = requestWriter()
        yield* body.write(Xdr.uint32, credential.stamp)
        yield* body.write(Xdr.string(), credential.machineName)
        yield* writeWords(body, [credential.uid, credential.gid])
        yield* body.write(Xdr.array(Xdr.uint32), credential.supplementaryGroups)
        yield* writer.write(Xdr.uint32, 1)
        yield* writer.write(Xdr.opaque(), yield* body.finish)
      }

      yield* writeWords(writer, [0, 0])
      yield* writer.appendEncoded(request.arguments)
      const [record] = yield* socket.send(encodeRecord(yield* writer.finish))
      assert.isDefined(record)

      const reader = replyReader(record)
      assert.deepStrictEqual(yield* Effect.forEach([0, 1, 2, 3, 4, 5], () => reader.read(Xdr.uint32)), [
        current,
        1,
        0,
        0,
        0,
        0
      ])

      return new Uint8Array(record.subarray(24))
    })
  }
})

type WireClient = Effect.Success<ReturnType<typeof wireClient>>

const openWireSession = Effect.fnUntraced(function*(
  caller: Vfs.Caller,
  owner: string,
  configuration?: Parameters<typeof wireClient>[1]
) {
  const handler = yield* wireClient(caller, configuration)

  return { handler, ...(yield* startSession(handler, owner)) }
})

describe("Locks over TCP", () => {
  const lock =
    (stateid: Uint8Array, client: bigint, owner: string, offset: bigint, length: bigint, type = 1) =>
    (writer: RequestWriter) =>
      Effect.gen(function*() {
        yield* writer.write(Xdr.uint32, Operation.LOCK)
        yield* writer.write(Xdr.uint32, type)
        yield* writer.write(Xdr.boolean, false)
        yield* writer.write(Xdr.uint64, offset)
        yield* writer.write(Xdr.uint64, length)
        yield* writer.write(Xdr.boolean, true)
        yield* writer.write(Xdr.uint32, 0)
        yield* writer.write(Xdr.fixedOpaque(stateid.length), stateid)
        yield* writer.write(Xdr.uint32, 0)
        yield* writer.write(Xdr.uint64, client)
        yield* writer.write(Xdr.string(), owner)
      })

  const lockExisting = (stateid: Uint8Array, offset: bigint, length: bigint, type = 1) => (writer: RequestWriter) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.LOCK)
      yield* writer.write(Xdr.uint32, type)
      yield* writer.write(Xdr.boolean, false)
      yield* writer.write(Xdr.uint64, offset)
      yield* writer.write(Xdr.uint64, length)
      yield* writer.write(Xdr.boolean, false)
      yield* writer.write(Xdr.fixedOpaque(stateid.length), stateid)
      yield* writer.write(Xdr.uint32, 0)
    })

  const unlock = (stateid: Uint8Array, offset: bigint, length: bigint) => (writer: RequestWriter) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.LOCKU)
      yield* writer.write(Xdr.uint32, 1)
      yield* writer.write(Xdr.uint32, 0)
      yield* writer.write(Xdr.fixedOpaque(stateid.length), stateid)
      yield* writer.write(Xdr.uint64, offset)
      yield* writer.write(Xdr.uint64, length)
    })

  const lockTest =
    (client: bigint, owner: string, offset: bigint, length: bigint, type = 1) => (writer: RequestWriter) =>
      Effect.gen(function*() {
        yield* writer.write(Xdr.uint32, Operation.LOCKT)
        yield* writer.write(Xdr.uint32, type)
        yield* writer.write(Xdr.uint64, offset)
        yield* writer.write(Xdr.uint64, length)
        yield* writer.write(Xdr.uint64, client)
        yield* writer.write(Xdr.string(), owner)
      })

  const denied = Effect.fnUntraced(function*(bytes: Uint8Array, operation: number) {
    const reader = replyReader(bytes)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.DENIED)
    yield* reader.read(Xdr.string())
    yield* reader.read(Xdr.uint32)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SEQUENCE)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    yield* reader.read(Xdr.fixedOpaque(16))

    for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.PUTFH)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    assert.strictEqual(yield* reader.read(Xdr.uint32), operation)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.DENIED)

    return {
      offset: yield* reader.read(Xdr.uint64),
      length: yield* reader.read(Xdr.uint64),
      type: yield* reader.read(Xdr.uint32),
      client: yield* reader.read(Xdr.uint64),
      owner: yield* reader.read(Xdr.string())
    }
  })

  const resultStateid = Effect.fnUntraced(function*(bytes: Uint8Array, operation: number) {
    const reader = replyReader(bytes)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    yield* reader.read(Xdr.string())
    yield* reader.read(Xdr.uint32)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SEQUENCE)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    yield* reader.read(Xdr.fixedOpaque(16))

    for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.PUTFH)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    assert.strictEqual(yield* reader.read(Xdr.uint32), operation)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)

    return yield* reader.read(Xdr.fixedOpaque(16))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should hold read locks through stateids and release them before CLOSE when read locks are held and CLOSE follows", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, client, session } = yield* openWireSession(caller, "lock-holder")

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        const onFile = Effect.fnUntraced(function*(number: number, operation: WriteOperation) {
          return yield* handler.send(
            yield* call([sequence(session, number), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }), operation])
          )
        })

        const granted = yield* resultStateid(
          yield* onFile(2, lock(opened.stateid, client, "owner", 0n, 2n)),
          Operation.LOCK
        )

        assert.strictEqual(new DataView(granted.buffer, granted.byteOffset, 4).getUint32(0), 1)
        const extended = yield* resultStateid(yield* onFile(3, lockExisting(granted, 4n, 2n)), Operation.LOCK)
        assert.strictEqual(new DataView(extended.buffer, extended.byteOffset, 4).getUint32(0), 2)

        const testStateids = Effect.fnUntraced(function*(response: Uint8Array) {
          const reader = replyReader(response)
          assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
          yield* reader.read(Xdr.string())
          yield* reader.read(Xdr.uint32)
          assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SEQUENCE)
          assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
          yield* reader.read(Xdr.fixedOpaque(16))

          for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
          const next = yield* reader.read(Xdr.uint32)

          if (next === Operation.PUTFH) {
            assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
            assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.TEST_STATEID)
          } else {
            assert.strictEqual(next, Operation.TEST_STATEID)
          }

          assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)

          return yield* reader.read(Xdr.array(Xdr.uint32))
        })

        const test = (stateids: ReadonlyArray<Uint8Array>): WriteOperation => (writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.TEST_STATEID)
            yield* writer.write(Xdr.array(Xdr.fixedOpaque(16)), stateids)
          })

        assert.deepStrictEqual(yield* testStateids(yield* onFile(4, test([extended, granted]))), [
          Status.OK,
          Status.OLD_STATEID
        ])
        const foreign = yield* startSession(handler, "foreign-lock-client")
        assert.deepStrictEqual(
          yield* testStateids(yield* handler.send(yield* call([sequence(foreign.session, 1), test([extended])]))),
          [Status.BAD_STATEID]
        )

        const replaced = yield* resultStateid(
          yield* onFile(5, lock(opened.stateid, client, "owner", 1n, 2n)),
          Operation.LOCK
        )

        assert.strictEqual(
          (yield* statuses(
            yield* onFile(6, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.CLOSE)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
              }))
          )).status,
          Status.LOCKS_HELD
        )
        assert.strictEqual(
          (yield* statuses(
            yield* onFile(7, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.READ)
                yield* writer.write(Xdr.fixedOpaque(replaced.length), replaced)
                yield* writer.write(Xdr.uint64, 0n)
                yield* writer.write(Xdr.uint32, 2)
              }))
          )).status,
          Status.OK
        )
        assert.strictEqual((yield* statuses(yield* onFile(8, unlock(granted, 0n, 2n)))).status, Status.OLD_STATEID)
        const partial = yield* resultStateid(yield* onFile(9, unlock(replaced, 1n, 1n)), Operation.LOCKU)
        const narrowed = yield* resultStateid(yield* onFile(10, unlock(partial, 0n, 3n)), Operation.LOCKU)
        assert.strictEqual((yield* statuses(yield* onFile(11, unlock(narrowed, 4n, 2n)))).status, Status.OK)
        assert.strictEqual(
          (yield* statuses(
            yield* onFile(12, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.CLOSE)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
              }))
          )).status,
          Status.OK
        )
        assert.strictEqual((yield* statuses(yield* onFile(13, unlock(narrowed, 4n, 2n)))).status, Status.BAD_STATEID)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should bound lock records without consuming owner capacity on a rejected request when a lock request exceeds the record limit", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxLockOwners: 1,
          maxLocks: 1
        }

        const { handler, client, session } = yield* openWireSession(caller, "lock-limits", { limits: constrained })

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        const onFile = Effect.fnUntraced(function*(number: number, operation: WriteOperation) {
          return yield* handler.send(
            yield* call([sequence(session, number), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }), operation])
          )
        })

        assert.strictEqual(
          (yield* statuses(yield* onFile(2, lock(opened.stateid, client, "a", 0n, 0n)))).status,
          Status.INVAL
        )
        const first = yield* resultStateid(yield* onFile(3, lock(opened.stateid, client, "a", 0n, 1n)), Operation.LOCK)
        assert.strictEqual(
          (yield* statuses(yield* onFile(4, lock(opened.stateid, client, "a", 2n, 1n)))).status,
          Status.DELAY
        )
        assert.strictEqual(
          (yield* statuses(yield* onFile(5, lock(opened.stateid, client, "b", 2n, 1n)))).status,
          Status.DELAY
        )
        const released = yield* resultStateid(yield* onFile(6, unlock(first, 0n, 1n)), Operation.LOCKU)
        assert.strictEqual(
          (yield* statuses(
            yield* onFile(7, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.FREE_STATEID)
                yield* writer.write(Xdr.fixedOpaque(released.length), released)
              }))
          )).status,
          Status.OK
        )
        assert.strictEqual(
          (yield* statuses(yield* onFile(8, lock(opened.stateid, client, "b", 2n, 0xffff_ffff_ffff_ffffn)))).status,
          Status.OK
        )
        assert.strictEqual(
          (yield* statuses(yield* onFile(9, lock(opened.stateid, client, "b", 0xffff_ffff_ffff_fffen, 2n)))).status,
          Status.INVAL
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should keep a split within the range limit and replay a lock only once when a split lock and replay approach the range limit", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* wireClient(caller, {
          limits: {
            ...limits,
            maxLocks: 1
          }
        })

        const client = yield* startSession(handler, "split-limit")

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(client.session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(client.client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        const request = yield* call([sequence(client.session, 2, true), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.PUTFH)
            yield* writer.write(Xdr.opaque(), opened.filehandle)
          }), lock(opened.stateid, client.client, "owner", 0n, 10n)])

        const first = yield* handler.send(request)
        const held = yield* resultStateid(first, Operation.LOCK)
        assert.deepStrictEqual(yield* handler.send(request), first)

        const onFile = Effect.fnUntraced(function*(number: number, operation: WriteOperation) {
          return yield* handler.send(
            yield* call([sequence(client.session, number), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }), operation])
          )
        })

        assert.strictEqual((yield* statuses(yield* onFile(3, unlock(held, 4n, 2n)))).status, Status.DELAY)
        const released = yield* resultStateid(yield* onFile(4, unlock(held, 0n, 5n)), Operation.LOCKU)
        assert.strictEqual((yield* statuses(yield* onFile(5, unlock(released, 5n, 5n)))).status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject another client's unlock when the byte range belongs to an owner", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* wireClient(caller)

        const first = yield* startSession(handler, "first-lock-client")

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(first.session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(first.client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        const granted = yield* resultStateid(
          yield* handler.send(
            yield* call([sequence(first.session, 2), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }), lock(opened.stateid, first.client, "owner", 0n, 1n)])
          ),
          Operation.LOCK
        )

        const second = yield* startSession(handler, "second-lock-client")
        assert.strictEqual(
          (yield* statuses(
            yield* handler.send(
              yield* call([sequence(second.session, 1), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), opened.filehandle)
                }), unlock(granted, 0n, 1n)])
            )
          )).status,
          Status.BAD_STATEID
        )
        assert.strictEqual(
          (yield* statuses(
            yield* handler.send(
              yield* call([sequence(first.session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), opened.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.CLOSE)
                  yield* writer.write(Xdr.uint32, 0)
                  yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
                })])
            )
          )).status,
          Status.LOCKS_HELD
        )
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should share one owner's range across separate open stateids when one owner uses separate open stateids", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* wireClient(caller, { writable: true })

        const first = yield* startSession(handler, "shared-lock-owner")
        const second = yield* startSession(handler, "other-lock-owner")

        const open = Effect.fnUntraced(function*(number: number, owner: string) {
          return yield* handler.send(
            yield* call([
              sequence(first.session, number),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.OPEN)
                  yield* writer.write(Xdr.uint32, 0)
                  yield* writer.write(Xdr.uint32, 3)
                  yield* writer.write(Xdr.uint32, 0)
                  yield* writer.write(Xdr.uint64, first.client)
                  yield* writer.write(Xdr.string(), owner)
                  yield* writer.write(Xdr.uint32, 0)
                  yield* writer.write(Xdr.uint32, 0)
                  yield* writer.write(Xdr.string(), "file")
                }),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        })

        const openedA = yield* parseOpen(yield* open(1, "open-a"))
        const openedB = yield* parseOpen(yield* open(2, "open-b"))

        const onFile = Effect.fnUntraced(function*(number: number, operation: WriteOperation) {
          return yield* handler.send(
            yield* call([sequence(first.session, number), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), openedA.filehandle)
              }), operation])
          )
        })

        const heldA = yield* resultStateid(
          yield* onFile(3, lock(openedA.stateid, first.client, "shared", 0n, 100n, 2)),
          Operation.LOCK
        )

        const heldB = yield* resultStateid(
          yield* onFile(4, lock(openedB.stateid, first.client, "shared", 0n, 100n, 2)),
          Operation.LOCK
        )

        assert.strictEqual(
          (yield* statuses(
            yield* onFile(5, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.FREE_STATEID)
                yield* writer.write(Xdr.fixedOpaque(heldA.length), heldA)
              }))
          )).status,
          Status.OK
        )
        assert.strictEqual(
          (yield* statuses(
            yield* onFile(6, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.CLOSE)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.fixedOpaque(openedA.stateid.length), openedA.stateid)
              }))
          )).status,
          Status.OK
        )
        yield* resultStateid(yield* onFile(7, unlock(heldB, 0n, 100n)), Operation.LOCKU)

        const openedOther = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(second.session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(second.client, "file", 3),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        yield* resultStateid(
          yield* handler.send(
            yield* call([sequence(second.session, 2), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), openedOther.filehandle)
              }), lock(openedOther.stateid, second.client, "other", 0n, 100n, 2)])
          ),
          Operation.LOCK
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should report two-client read/write conflicts and permit disjoint ranges when two clients request overlapping or disjoint ranges", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* wireClient(caller, { writable: true })

        const a = yield* startSession(handler, "writer-a")
        const b = yield* startSession(handler, "writer-b")

        const open = Effect.fnUntraced(function*(client: typeof a) {
          return yield* handler.send(
            yield* call([
              sequence(client.session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(client.client, "file", 3),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        })

        const openedA = yield* parseOpen(yield* open(a))
        const openedB = yield* parseOpen(yield* open(b))

        const onFile = Effect.fnUntraced(function*(client: typeof a, number: number, operation: WriteOperation) {
          return yield* handler.send(
            yield* call([sequence(client.session, number), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), openedA.filehandle)
              }), operation])
          )
        })

        const held = yield* resultStateid(
          yield* onFile(a, 2, lock(openedA.stateid, a.client, "owner-a", 100n, 100n, 2)),
          Operation.LOCK
        )

        assert.deepStrictEqual(
          yield* denied(yield* onFile(b, 2, lockTest(b.client, "owner-b", 150n, 5n)), Operation.LOCKT),
          {
            offset: 100n,
            length: 100n,
            type: 2,
            client: a.client,
            owner: "owner-a"
          }
        )
        assert.deepStrictEqual(
          yield* denied(yield* onFile(b, 3, lock(openedB.stateid, b.client, "owner-b", 150n, 5n, 4)), Operation.LOCK),
          {
            offset: 100n,
            length: 100n,
            type: 2,
            client: a.client,
            owner: "owner-a"
          }
        )
        yield* resultStateid(
          yield* onFile(b, 4, lock(openedB.stateid, b.client, "owner-b", 200n, 5n, 2)),
          Operation.LOCK
        )
        const changed = yield* resultStateid(yield* onFile(a, 3, lockExisting(held, 125n, 25n, 1)), Operation.LOCK)
        assert.strictEqual(
          (yield* statuses(yield* onFile(b, 5, lockTest(b.client, "owner-b", 125n, 25n)))).status,
          Status.OK
        )
        const released = yield* resultStateid(yield* onFile(a, 4, unlock(changed, 150n, 50n)), Operation.LOCKU)
        yield* resultStateid(
          yield* onFile(b, 6, lock(openedB.stateid, b.client, "owner-b", 150n, 50n, 2)),
          Operation.LOCK
        )
        assert.strictEqual((yield* statuses(yield* onFile(a, 5, unlock(released, 100n, 50n)))).status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should release lock-owner capacity when a client's lease expires", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxLockOwners: 1,
          maxLocks: 1
        }

        let now = 0

        const handler = yield* wireClient(caller, { leaseDurationSeconds: 1, now: () => now, limits: constrained })

        const first = yield* startSession(handler, "expired-lock-client")

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(first.session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(first.client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        yield* resultStateid(
          yield* handler.send(
            yield* call([sequence(first.session, 2), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }), lock(opened.stateid, first.client, "owner", 0n, 1n)])
          ),
          Operation.LOCK
        )
        now = 2_000
        assert.strictEqual(
          (yield* statuses(yield* handler.send(yield* call([sequence(first.session, 3)])))).status,
          Status.BADSESSION
        )
        const second = yield* startSession(handler, "new-lock-client")

        const reopened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(second.session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(second.client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        assert.strictEqual(
          (yield* statuses(
            yield* handler.send(
              yield* call([sequence(second.session, 2), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), reopened.filehandle)
                }), lock(reopened.stateid, second.client, "owner", 0n, 1n)])
            )
          )).status,
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
  })
})

const observeOpen = (caller: Vfs.Caller, observe: () => void): Vfs.Caller => {
  type OpenTarget = Vfs.Target | Vfs.PathInput | Vfs.ObjectReference | Vfs.FileHandle

  function open(
    target: OpenTarget,
    options: Vfs.OpenOptions
  ): Effect.Effect<Vfs.FileHandle, Vfs.FsFailure, Scope.Scope>
  function open(
    target: Vfs.Entry,
    options: Vfs.OpenEntryOptions
  ): Effect.Effect<Vfs.OpenEntryResult, Vfs.FsFailure, Scope.Scope>
  function open(target: OpenTarget | Vfs.Entry, options: Vfs.OpenEntryOptions) {
    observe()

    return Vfs.isEntry(target) ? caller.open(target, options) : caller.open(target, options)
  }

  return { ...caller, open }
}

describe("Session replay over TCP", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should create bounded sessions and return byte-identical cached slot replays when sessions and cached slot replays reach their limits", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* wireClient(caller)

        const exchange = replyReader(yield* handler.send(yield* call([ownerExchange("client")])))
        assert.strictEqual(yield* exchange.read(Xdr.uint32), Status.OK)
        yield* exchange.read(Xdr.string())
        yield* exchange.read(Xdr.uint32)
        yield* exchange.read(Xdr.uint32)
        yield* exchange.read(Xdr.uint32)
        const client = yield* exchange.read(Xdr.uint64)

        const create = yield* handler.send(
          yield* call([(writer) =>
            Effect.gen(function*() {
              yield* Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
                yield* writer.write(Xdr.uint64, client)
                yield* writer.write(Xdr.uint32, 1)
                yield* writer.write(Xdr.uint32, 0)
              })
              yield* channel(writer, 2)
              yield* channel(writer, 0)
              yield* Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
              })
            })])
        )

        const createReader = replyReader(create)
        assert.strictEqual(yield* createReader.read(Xdr.uint32), Status.OK)
        yield* createReader.read(Xdr.string())
        yield* createReader.read(Xdr.uint32)
        yield* createReader.read(Xdr.uint32)
        yield* createReader.read(Xdr.uint32)
        const session = yield* createReader.read(Xdr.fixedOpaque(16))

        const sequenced = yield* call([
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.SEQUENCE)
              yield* writer.write(Xdr.fixedOpaque(session.length), session)
              yield* writer.write(Xdr.uint32, 1)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 1)
              yield* writer.write(Xdr.boolean, true)
            }),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          (writer) => writer.write(Xdr.uint32, Operation.GETFH)
        ], "replay")

        const first = yield* handler.send(sequenced)
        const replay = yield* handler.send(sequenced)
        assert.deepStrictEqual(replay, first)

        const highSlot = yield* call([(writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.SEQUENCE)
            yield* writer.write(Xdr.fixedOpaque(session.length), session)
            yield* writer.write(Xdr.uint32, 2)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 2)
            yield* writer.write(Xdr.boolean, false)
          })])

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(highSlot))).read(Xdr.uint32),
          Status.BAD_HIGH_SLOT
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should replay an identical CREATE_SESSION without allocating another session when CREATE_SESSION repeats with the same request", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxSessions: 1
        }

        const handler = yield* wireClient(caller, { limits: constrained })

        const exchange = replyReader(yield* handler.send(yield* call([ownerExchange("create-replay")])))

        yield* exchange.read(Xdr.uint32)
        yield* exchange.read(Xdr.string())
        yield* exchange.read(Xdr.uint32)
        yield* exchange.read(Xdr.uint32)
        yield* exchange.read(Xdr.uint32)
        const client = yield* exchange.read(Xdr.uint64)

        const request = yield* call([(writer) =>
          Effect.gen(function*() {
            yield* Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
              yield* writer.write(Xdr.uint64, client)
              yield* writer.write(Xdr.uint32, 1)
              yield* writer.write(Xdr.uint32, 0)
            })
            yield* channel(writer, 2)
            yield* channel(writer, 0)
            yield* Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 0)
            })
          })], "create-replay")

        const first = yield* handler.send(request)
        const replay = yield* handler.send(request)
        assert.deepStrictEqual(replay, first)
        assert.strictEqual(yield* (replyReader(replay)).read(Xdr.uint32), Status.OK)

        const changedCredentials = {
          ...request,
          credentials: {
            _tag: "Sys" as const,
            stamp: 1,
            machineName: "localhost",
            uid: 501,
            gid: 20,
            supplementaryGroups: []
          }
        }

        // RFC 8881 Section 18.36.4 phase 2: an equal csa_sequence is a replay regardless of principal.
        assert.deepStrictEqual(yield* handler.send(changedCredentials), first)
        assert.deepStrictEqual(yield* handler.send(request), first)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should return SEQUENCE OK before RETRY_UNCACHED_REP for an uncached replay when an uncached slot request is replayed", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openWireSession(caller, "uncached-replay")

        const request = yield* call([
          sequence(session, 1),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)
        ])

        assert.strictEqual((yield* statuses(yield* handler.send(request))).status, Status.OK)
        assert.deepStrictEqual((yield* statuses(yield* handler.send(request))).operations, [[
          Operation.SEQUENCE,
          Status.OK
        ], [Operation.PUTROOTFH, Status.RETRY_UNCACHED_REP]])
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should leave a slot unchanged when SEQUENCE rejects an oversized cached reply", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxReplayBytes: ByteSize.bytes(512)
        }

        const handler = yield* wireClient(caller, { limits: constrained })

        const {
          session
        } = yield* startSession(handler, "replay-budget", {
          maxCachedResponse: 64
        })

        const rejected = yield* call([
          sequence(session, 1, true),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.GETATTR)
              yield* writer.write(Xdr.uint32, 1)
              yield* writer.write(Xdr.uint32, 1)
            })
        ])

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(rejected))).read(Xdr.uint32),
          Status.REP_TOO_BIG_TO_CACHE
        )
        const retry = yield* call([sequence(session, 1)])
        assert.strictEqual(
          yield* (replyReader(yield* handler.send(retry))).read(Xdr.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should accept small actual replies within a negotiated response channel when the actual reply fits a negotiated response channel", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* wireClient(caller)

        const {
          session
        } = yield* startSession(handler, "small-response", {
          maxResponse: 128
        })

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(yield* call([sequence(session, 1)])))).read(
            Xdr.uint32
          ),
          Status.OK
        )

        const {
          session: readdirSession
        } = yield* startSession(handler, "small-readdir-response", {
          maxResponse: 512
        })

        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([
                sequence(readdirSession, 1),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.READDIR)
                    yield* writer.write(Xdr.uint64, 0n)
                    yield* writer.write(Xdr.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                    yield* writer.write(Xdr.uint32, 0)
                    yield* writer.write(Xdr.uint32, 32_768)
                    yield* writer.write(Xdr.uint32, 0)
                  })
              ], "readdirplus ")
            )
          )).read(Xdr.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should count retained requests against the replay-memory budget when replay requests are retained under a byte budget", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxReplayBytes: ByteSize.bytes(560)
        }

        const { handler, session } = yield* openWireSession(caller, "request-budget", { limits: constrained })

        const first = yield* call([
          sequence(session, 1, false, 0),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)
        ], "x".repeat(80))

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(first))).read(Xdr.uint32),
          Status.OK
        )

        const second = yield* call([
          sequence(session, 1, false, 1),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)
        ], "x".repeat(80))

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(second))).read(Xdr.uint32),
          Status.DELAY
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reuse the reserved replay budget for successive uncached requests when successive uncached requests use one reserved replay budget", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxReplayBytes: ByteSize.bytes(640)
        }

        const { handler, session } = yield* openWireSession(caller, "reused-request-budget", { limits: constrained })

        for (let sequenceId = 1; sequenceId <= 4; sequenceId++) {
          const request = yield* call([
            sequence(session, sequenceId),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)
          ], "x".repeat(80))

          assert.strictEqual(
            yield* (replyReader(yield* handler.send(request))).read(Xdr.uint32),
            Status.OK
          )
        }
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject a different request that reuses a cached slot sequence when a different request reuses a cached slot sequence", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openWireSession(caller, "false-retry")

        yield* handler.send(
          yield* call([sequence(session, 1, true), (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)])
        )

        const changed = yield* call([sequence(session, 1, true), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.GETATTR)
            yield* writer.write(Xdr.uint32, 0)
          })])

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(changed))).read(Xdr.uint32),
          Status.SEQ_FALSE_RETRY
        )

        const changedCredentials = {
          ...(yield* call([
            sequence(session, 1, true),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)
          ])),
          credentials: {
            _tag: "Sys" as const,
            stamp: 1,
            machineName: "localhost",
            uid: 501,
            gid: 20,
            supplementaryGroups: []
          }
        }

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(changedCredentials))).read(Xdr.uint32),
          Status.SEQ_FALSE_RETRY
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should replace a slot's cached reply without double-counting its old bytes when a cached slot reply is replaced", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxReplayBytes: ByteSize.bytes(1_024)
        }

        const { handler, session } = yield* openWireSession(caller, "replace-replay", { limits: constrained })

        for (
          const sequenceId of Array.from({
            length: 10
          }, (_, index) => index + 1)
        ) {
          const request = yield* call([
            sequence(session, sequenceId, true),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)
          ])

          const response = yield* handler.send(request)
          assert.strictEqual(yield* (replyReader(response)).read(Xdr.uint32), Status.OK)
          assert.deepStrictEqual(yield* handler.send(request), response)
        }
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should revoke the prior client incarnation when its replacement creates a session", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxClients: 1,
          maxSessions: 1
        }

        const handler = yield* wireClient(caller, { limits: constrained })

        const first = yield* startSession(handler, "restarted-client")

        const exchange = replyReader(
          yield* handler.send(yield* call([ownerExchange("restarted-client", new Uint8Array(8).fill(1))]))
        )

        yield* exchange.read(Xdr.uint32)
        yield* exchange.read(Xdr.string())
        yield* exchange.read(Xdr.uint32)
        yield* exchange.read(Xdr.uint32)
        yield* exchange.read(Xdr.uint32)
        const replacement = yield* exchange.read(Xdr.uint64)

        const create = yield* call([(writer) =>
          Effect.gen(function*() {
            yield* Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
              yield* writer.write(Xdr.uint64, replacement)
              yield* writer.write(Xdr.uint32, 1)
              yield* writer.write(Xdr.uint32, 0)
            })
            yield* channel(writer, 2)
            yield* channel(writer, 0)
            yield* Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 0)
            })
          })])

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(create))).read(Xdr.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (replyReader(yield* handler.send(yield* call([sequence(first.session, 1)]))))
            .read(Xdr.uint32),
          Status.BADSESSION
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should restore a confirmed predecessor after destroying an unconfirmed replacement when an unconfirmed replacement session is destroyed", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxClients: 1
        }

        const handler = yield* wireClient(caller, { limits: constrained })

        const original = yield* startSession(handler, "abandoned-restart")

        const replacementResponse = replyReader(
          yield* handler.send(yield* call([ownerExchange("abandoned-restart", new Uint8Array(8).fill(1))]))
        )

        yield* replacementResponse.read(Xdr.uint32)
        yield* replacementResponse.read(Xdr.string())
        yield* replacementResponse.read(Xdr.uint32)
        yield* replacementResponse.read(Xdr.uint32)
        yield* replacementResponse.read(Xdr.uint32)
        const replacement = yield* replacementResponse.read(Xdr.uint64)
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.DESTROY_CLIENTID)
                  yield* writer.write(Xdr.uint64, replacement)
                })])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(yield* call([ownerExchange("abandoned-restart", new Uint8Array(8).fill(2))]))
          )).read(Xdr.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (replyReader(yield* handler.send(yield* call([sequence(original.session, 1)])))).read(Xdr.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should bound pending client replacements separately from logical clients when pending client replacements reach their separate limit", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxClients: 2,
          maxPendingClientReplacements: 1
        }

        const handler = yield* wireClient(caller, { limits: constrained })

        yield* startSession(handler, "pending-a")
        yield* startSession(handler, "pending-b")

        const replacementA = replyReader(
          yield* handler.send(yield* call([ownerExchange("pending-a", new Uint8Array(8).fill(1))]))
        )

        yield* replacementA.read(Xdr.uint32)
        yield* replacementA.read(Xdr.string())
        yield* replacementA.read(Xdr.uint32)
        yield* replacementA.read(Xdr.uint32)
        yield* replacementA.read(Xdr.uint32)
        const replacementAId = yield* replacementA.read(Xdr.uint64)
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(yield* call([ownerExchange("pending-b", new Uint8Array(8).fill(1))]))
          )).read(Xdr.uint32),
          Status.DELAY
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.DESTROY_CLIENTID)
                  yield* writer.write(Xdr.uint64, replacementAId)
                })])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(yield* call([ownerExchange("pending-b", new Uint8Array(8).fill(1))]))
          )).read(Xdr.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should require DESTROY_SESSION for the active session to be the final operation when DESTROY_SESSION targets its active session", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openWireSession(caller, "destroy-order")

        const rejected = yield* statuses(
          yield* handler.send(
            yield* call([sequence(session, 1, true), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.DESTROY_SESSION)
                yield* writer.write(Xdr.fixedOpaque(session.length), session)
              }), (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)])
          )
        )

        assert.strictEqual(rejected.status, Status.NOT_ONLY_OP)
        assert.deepStrictEqual(rejected.operations.at(-1), [Operation.DESTROY_SESSION, Status.NOT_ONLY_OP])
        assert.strictEqual(
          yield* (replyReader(yield* handler.send(yield* call([sequence(session, 2)])))).read(
            Xdr.uint32
          ),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject an unsequenced non-final DESTROY_SESSION without removing the session when DESTROY_SESSION is unsequenced and non-final", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openWireSession(caller, "unsequenced-destroy-order")

        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.DESTROY_SESSION)
                  yield* writer.write(Xdr.fixedOpaque(session.length), session)
                }), (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)])
            )
          )).read(Xdr.uint32),
          Status.NOT_ONLY_OP
        )
        assert.strictEqual(
          yield* (replyReader(yield* handler.send(yield* call([sequence(session, 1)])))).read(
            Xdr.uint32
          ),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should release cached replay capacity when DESTROY_SESSION removes its session", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxClients: 8,
          maxSessions: 1,
          maxReplayBytes: ByteSize.bytes(1_024)
        }

        const handler = yield* wireClient(caller, { limits: constrained })

        for (let index = 0; index < 4; index++) {
          const {
            session
          } = yield* startSession(handler, `destroy-cache-${index}`)

          assert.strictEqual(
            yield* (replyReader(
              yield* handler.send(
                yield* call([
                  sequence(session, 1, true),
                  (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)
                ])
              )
            )).read(Xdr.uint32),
            Status.OK
          )
          assert.strictEqual(
            yield* (replyReader(
              yield* handler.send(
                yield* call([(writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.DESTROY_SESSION)
                    yield* writer.write(Xdr.fixedOpaque(session.length), session)
                  })])
              )
            )).read(Xdr.uint32),
            Status.OK
          )
        }

        const {
          session
        } = yield* startSession(handler, "after-destroy-cache")

        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([sequence(session, 1, true), (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject an oversized reply before any state-changing operation runs when a response would exceed its bound before mutation", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const handler = yield* wireClient(caller)
        // Small enough for SEQUENCE + PUTROOTFH + OPEN, too small once a worst-case GETATTR follows.
        const { client, session } = yield* startSession(handler, "preflight", { maxResponse: 320 })
        const other = yield* startSession(handler, "preflight-other")
        const allAttributes = [0xffff_ffff, 0xffff_ffff, 0xffff]

        const tooBig = yield* run(
          handler,
          call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

            openReadOnly(client, "file"),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.GETATTR)
                yield* writer.write(Xdr.array(Xdr.uint32), allAttributes)
              })
          ])
        )

        assert.strictEqual(tooBig.status, Status.REP_TOO_BIG)
        assert.strictEqual(tooBig.operations.length, 1, "rejected at SEQUENCE, before OPEN executed")

        // The open never happened, so a fresh OPEN yields seqid 1 rather than a bumped seqid.
        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

              openReadOnly(client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        assert.strictEqual(new DataView(opened.stateid.buffer).getUint32(0), 1)

        // DESTROY_SESSION of another session changes state too, so it is also gated by the preflight.
        const destroyTooBig = yield* run(
          handler,
          call([
            sequence(session, 2),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.DESTROY_SESSION)
                yield* writer.write(Xdr.fixedOpaque(other.session.length), other.session)
              }),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.READDIR)
                yield* writer.write(Xdr.uint64, 0n)
                yield* writer.write(Xdr.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 16_384)
                yield* writer.write(Xdr.uint32, 0)
              })
          ])
        )

        assert.strictEqual(destroyTooBig.status, Status.REP_TOO_BIG)
        assert.strictEqual((yield* run(handler, call([sequence(other.session, 1)]))).status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject a READ that cannot fit the channel before it touches the file when a READ reply cannot fit the channel", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
        const before = (yield* caller.stat("/file")).atimeNs
        const handler = yield* wireClient(caller)
        const { session } = yield* startSession(handler, "read-preflight", { maxResponse: 512 })

        // The file was never read after it changed, so READ refreshes its access time; the worst-case reply
        // must fit before READ runs.
        const reply = yield* run(
          handler,
          call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                yield* writer.write(Xdr.string(), "file")
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.READ)
                yield* writer.write(Xdr.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
                yield* writer.write(Xdr.uint64, 0n)
                yield* writer.write(Xdr.uint32, 4_096)
              })
          ])
        )

        assert.deepStrictEqual(reply.operations, [{ code: Operation.SEQUENCE, status: Status.REP_TOO_BIG }])
        assert.strictEqual((yield* caller.stat("/file")).atimeNs, before)

        const fitting = yield* run(
          handler,
          call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                yield* writer.write(Xdr.string(), "file")
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.READ)
                yield* writer.write(Xdr.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
                yield* writer.write(Xdr.uint64, 0n)
                yield* writer.write(Xdr.uint32, 64)
              })
          ])
        )

        assert.strictEqual(fitting.status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should replay CREATE_SESSION before validating flags when a minimum response channel is negotiated", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const handler = yield* wireClient(caller)

        const exchanged = yield* run(
          handler,
          call([
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.EXCHANGE_ID)
                yield* writer.write(Xdr.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(Xdr.string(), "precedence")
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
              })
          ])
        )

        // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
        const { clientid, sequence: firstSequence } = exchanged.operations[0]!.value as {
          readonly clientid: bigint
          readonly sequence: number
        }

        const createSession = (sequenceId: number, flags: number, maxResponse: number) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
            yield* writer.write(Xdr.uint64, clientid)
            yield* writer.write(Xdr.uint32, sequenceId)
            yield* writer.write(Xdr.uint32, flags)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 8192)
            yield* writer.write(Xdr.uint32, maxResponse)
            yield* writer.write(Xdr.uint32, 8192)
            yield* writer.write(Xdr.uint32, 32)
            yield* writer.write(Xdr.uint32, 2)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 8192)
            yield* writer.write(Xdr.uint32, 8192)
            yield* writer.write(Xdr.uint32, 8192)
            yield* writer.write(Xdr.uint32, 32)
            yield* writer.write(Xdr.uint32, 2)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 0)
          })

        // The smallest usable response channel is an RPC reply carrying a SEQUENCE-only compound.
        // The failed attempt consumes the slot, so the corrected request uses the next sequence.
        assert.strictEqual((yield* run(handler, call([createSession(firstSequence, 0, 79)]))).status, Status.TOOSMALL)
        const created = yield* run(handler, call([createSession(firstSequence + 1, 0, 80)]))
        assert.strictEqual(created.status, Status.OK)
        // An equal csa_sequence replays the cached result before any argument validation.
        const replayed = yield* run(handler, call([createSession(firstSequence + 1, 0xf, 80)]))
        assert.deepStrictEqual(replayed.operations[0]!.value, created.operations[0]!.value)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should bound the back channel and the client-record table when backchannel or client-record capacity is exhausted", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const constrained = { ...limits, maxClients: 2 }

        const handler = yield* wireClient(caller, { limits: constrained })

        const exchange = (owner: string) =>
          run(
            handler,
            call([(writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.EXCHANGE_ID)
                yield* writer.write(Xdr.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(Xdr.string(), owner)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
              })])
          )

        assert.strictEqual((yield* exchange("bounded-a")).status, Status.OK)
        assert.strictEqual((yield* exchange("bounded-b")).status, Status.OK)
        assert.strictEqual((yield* exchange("bounded-c")).status, Status.DELAY, "third owner exceeds maxClients")
        // Case 4 replaces the unconfirmed record with a new client ID without consuming another slot.
        const replaced = yield* exchange("bounded-a")
        assert.strictEqual(replaced.status, Status.OK, "an existing owner is not a new record")

        // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
        const { clientid, sequence: firstSequence } = replaced.operations[0]!.value as {
          readonly clientid: bigint
          readonly sequence: number
        }

        const backTooSmall = yield* run(
          handler,
          call([(writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
              yield* writer.write(Xdr.uint64, clientid)
              yield* writer.write(Xdr.uint32, firstSequence)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 8192)
              yield* writer.write(Xdr.uint32, 8192)
              yield* writer.write(Xdr.uint32, 8192)
              yield* writer.write(Xdr.uint32, 32)
              yield* writer.write(Xdr.uint32, 2)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 10)
              yield* writer.write(Xdr.uint32, 8192)
              yield* writer.write(Xdr.uint32, 8192)
              yield* writer.write(Xdr.uint32, 32)
              yield* writer.write(Xdr.uint32, 1)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 0)
            })])
        )

        assert.strictEqual(backTooSmall.status, Status.TOOSMALL)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should bind connections, accept backchannel parameters, and judge a misplaced SEQUENCE in place when connections bind or SEQUENCE appears in the wrong position", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const { handler, session } = yield* openWireSession(caller, "bind")

        const bind = (id: Uint8Array) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.BIND_CONN_TO_SESSION)
            yield* writer.write(Xdr.fixedOpaque(id.length), id)
            yield* writer.write(Xdr.uint32, 3)
            yield* writer.write(Xdr.boolean, false)
          })

        const bindDirection = (direction: number) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.BIND_CONN_TO_SESSION)
            yield* writer.write(Xdr.fixedOpaque(session.length), session)
            yield* writer.write(Xdr.uint32, direction)
            yield* writer.write(Xdr.boolean, false)
          })

        // Section 18.34.3: the sole operation of its compound, with or without a session; the
        // connection is already the fore channel, so fore-channel requests succeed as CDFS4_FORE.
        const unknown = yield* run(handler, call([bind(new Uint8Array(16).fill(1))]))
        assert.deepStrictEqual(unknown.operations, [{
          code: Operation.BIND_CONN_TO_SESSION,
          status: Status.BADSESSION
        }])
        const bound = yield* run(handler, call([bind(session)]))
        assert.strictEqual(bound.status, Status.OK)
        assert.deepStrictEqual(bound.operations[0]!.value, { session, direction: 1, rdma: false })
        const foreOnly = yield* run(handler, call([bindDirection(1)]))
        assert.deepStrictEqual(foreOnly.operations[0]!.value, { session, direction: 1, rdma: false })
        const combined = yield* run(handler, call([sequence(session, 1), bind(session)]))
        assert.deepStrictEqual(combined.operations[1], {
          code: Operation.BIND_CONN_TO_SESSION,
          status: Status.NOT_ONLY_OP
        })

        const followed = yield* run(
          handler,
          call([bind(session), (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)])
        )

        assert.deepStrictEqual(followed.operations, [{
          code: Operation.BIND_CONN_TO_SESSION,
          status: Status.NOT_ONLY_OP
        }])

        // A back-channel binding is a change this server cannot make (INVAL); 4 is not a direction.
        for (const direction of [2, 7]) {
          const back = yield* run(handler, call([bindDirection(direction)]))
          assert.deepStrictEqual(back.operations, [{ code: Operation.BIND_CONN_TO_SESSION, status: Status.INVAL }])
        }

        const badDirection = yield* run(handler, call([bindDirection(4)]))
        assert.deepStrictEqual(badDirection.operations, [{
          code: Operation.BIND_CONN_TO_SESSION,
          status: Status.BADXDR
        }])

        const backchannelCtl = (flavors: (writer: RequestWriter) => Effect.Effect<void>) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.BACKCHANNEL_CTL)
            yield* writer.write(Xdr.uint32, 0x4000_0001)
            yield* flavors(writer)
          })

        const authSys = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, 1)
          yield* writer.write(Xdr.uint32, 0)
          yield* writer.write(Xdr.string(), "probe")
          yield* writer.write(Xdr.uint32, 501)
          yield* writer.write(Xdr.uint32, 20)
          yield* writer.write(Xdr.array(Xdr.uint32), [])
        })

        const gss = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, 6)
          yield* writer.write(Xdr.uint32, 0)
          yield* writer.write(Xdr.opaque(), new Uint8Array([1]))
          yield* writer.write(Xdr.opaque(), new Uint8Array([2]))
        })

        const backchannel = yield* run(
          handler,
          call([
            sequence(session, 2),
            backchannelCtl((writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, 2)
                yield* writer.write(Xdr.uint32, 0)
                yield* authSys(writer)
              })
            )
          ])
        )

        // This session negotiated no backchannel, so there is no callback program to replace.
        // NFS4ERR_INVAL is listed for BACKCHANNEL_CTL in the Section 15.2 table.
        assert.deepStrictEqual(backchannel.operations[1], { code: Operation.BACKCHANNEL_CTL, status: Status.INVAL })
        assert.strictEqual(backchannel.operations.length, 2)

        // Section 18.33.3: an RPCSEC_GSS handle this server never issued is NOENT.
        const gssHandle = yield* run(
          handler,
          call([
            sequence(session, 3),
            backchannelCtl((writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, 1)
                yield* gss(writer)
              })
            )
          ])
        )

        assert.deepStrictEqual(gssHandle.operations[1], { code: Operation.BACKCHANNEL_CTL, status: Status.NOENT })

        const withoutSession = yield* run(
          handler,
          call([backchannelCtl((writer) => writer.write(Xdr.array(Xdr.uint32), []))])
        )

        assert.deepStrictEqual(withoutSession.operations, [{
          code: Operation.BACKCHANNEL_CTL,
          status: Status.OP_NOT_IN_SESSION
        }])

        const badFlavor = yield* run(
          handler,
          call([
            sequence(session, 4),
            backchannelCtl((writer) => writer.write(Xdr.array(Xdr.uint32), [9]))
          ])
        )

        assert.deepStrictEqual(badFlavor.operations[1], { code: Operation.BACKCHANNEL_CTL, status: Status.BADXDR })

        // A SEQUENCE after other operations answers SEQUENCE_POS in place; the earlier ones ran.
        const misplaced = yield* run(
          handler,
          call([
            sequence(session, 5),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            sequence(session, 6)
          ])
        )

        assert.strictEqual(misplaced.status, Status.SEQUENCE_POS)
        assert.strictEqual(misplaced.operations.length, 3)
        assert.strictEqual(misplaced.operations[1]!.status, Status.OK)
        assert.strictEqual((yield* run(handler, call([sequence(session, 6)]))).status, Status.OK, "slot 5 was consumed")

        const bootstrapPair = yield* run(
          handler,
          call([(writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.DESTROY_SESSION)
              yield* writer.write(Xdr.fixedOpaque(session.length), session)
            }), sequence(session, 7)])
        )

        assert.deepStrictEqual(bootstrapPair.operations, [{
          code: Operation.DESTROY_SESSION,
          status: Status.NOT_ONLY_OP
        }])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should renew the lease on CREATE_SESSION and reject channels without room for two operations when CREATE_SESSION renews a lease or receives a minimal channel", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        let now = 0

        const handler = yield* wireClient(caller, { now: () => now })

        const exchanged = yield* run(
          handler,
          call([
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.EXCHANGE_ID)
                yield* writer.write(Xdr.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(Xdr.string(), "lease")
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
              })
          ])
        )

        // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
        const { clientid, sequence: firstSequence } = exchanged.operations[0]!.value as {
          readonly clientid: bigint
          readonly sequence: number
        }

        const createSession = (maxOperations: number, sequenceId: number) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
            yield* writer.write(Xdr.uint64, clientid)
            yield* writer.write(Xdr.uint32, sequenceId)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 8192)
            yield* writer.write(Xdr.uint32, 8192)
            yield* writer.write(Xdr.uint32, 8192)
            yield* writer.write(Xdr.uint32, maxOperations)
            yield* writer.write(Xdr.uint32, 2)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 8192)
            yield* writer.write(Xdr.uint32, 8192)
            yield* writer.write(Xdr.uint32, 8192)
            yield* writer.write(Xdr.uint32, 32)
            yield* writer.write(Xdr.uint32, 2)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 0)
          })

        assert.strictEqual((yield* run(handler, call([createSession(1, firstSequence)]))).status, Status.TOOSMALL)

        // The failed attempt consumed the slot (Section 18.36.4 phase 2).
        now = 25_000
        const created = yield* run(handler, call([createSession(32, firstSequence + 1)]))
        assert.strictEqual(created.status, Status.OK)
        // SAFETY: CREATE_SESSION succeeded, so the body reader table produced the CREATE_SESSION result shape.
        const { session } = created.operations[0]!.value as { readonly session: Uint8Array }

        // Without renewal the record created at t=0 would have expired at t=30s.
        now = 50_000
        assert.strictEqual((yield* run(handler, call([sequence(session, 1)]))).status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should follow the EXCHANGE_ID client record cases of RFC 8881 Section 18.35.4 when EXCHANGE_ID encounters client record variants", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const handler = yield* wireClient(caller)
        const owner = "record-cases"

        type Exchanged = { readonly clientid: bigint; readonly sequence: number; readonly flags: number }

        const exchange = (credentials: Credentials, verifier: Uint8Array, flags = 0) =>
          run(
            handler,
            callAs(credentials, [(writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.EXCHANGE_ID)
                yield* writer.write(Xdr.fixedOpaque(verifier.length), verifier)
                yield* writer.write(Xdr.string(), owner)
                yield* writer.write(Xdr.uint32, flags)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
              })])
          ).pipe(Effect.map((reply) => {
            // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
            const value = reply.operations[0]!.value as Exchanged

            return { status: reply.status, value }
          }))

        const createSession = (credentials: Credentials, clientid: bigint, sequenceId: number) =>
          run(
            handler,
            callAs(credentials, [(writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
                yield* writer.write(Xdr.uint64, clientid)
                yield* writer.write(Xdr.uint32, sequenceId)
                yield* writer.write(Xdr.uint32, 0)

                for (let channel = 0; channel < 2; channel++) {
                  yield* writer.write(Xdr.uint32, 0)
                  yield* writer.write(Xdr.uint32, 8192)
                  yield* writer.write(Xdr.uint32, 8192)
                  yield* writer.write(Xdr.uint32, 8192)
                  yield* writer.write(Xdr.uint32, 32)
                  yield* writer.write(Xdr.uint32, 2)
                  yield* writer.write(Xdr.uint32, 0)
                }

                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
              })])
          )

        const v1 = new Uint8Array(8).fill(1)
        const v2 = new Uint8Array(8).fill(2)
        const CONFIRMED_R = 0x8000_0000
        const UPDATE = 0x4000_0000

        // Case 1 then case 4: a repeated EXCHANGE_ID on an unconfirmed record issues a new client ID.
        const first = yield* exchange(sys(501, 20), v1)
        const second = yield* exchange(sys(501, 20), v1)
        assert.notStrictEqual(second.value.clientid, first.value.clientid)
        assert.strictEqual(second.value.flags & CONFIRMED_R, 0)

        const confirmed = yield* createSession(sys(501, 20), second.value.clientid, second.value.sequence)
        assert.strictEqual(confirmed.status, Status.OK)

        // Case 2: the confirmed record is returned unchanged to the same principal.
        const retry = yield* exchange(sys(501, 20), v1)
        assert.strictEqual(retry.value.clientid, second.value.clientid)
        assert.notStrictEqual(retry.value.flags & CONFIRMED_R, 0)

        // Case 3 with live state: another principal must pick a different owner.
        const collision = yield* exchange(sys(1111, 37), v1)
        assert.strictEqual(collision.status, Status.CLID_INUSE)

        // Case 3 without state: the confirmed record is replaced and its client ID becomes stale.
        // SAFETY: CREATE_SESSION succeeded, so the body reader table produced the CREATE_SESSION result shape.
        const { session } = confirmed.operations[0]!.value as { readonly session: Uint8Array }

        const destroyed = yield* run(
          handler,
          call([(writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.DESTROY_SESSION)
              yield* writer.write(Xdr.fixedOpaque(session.length), session)
            })])
        )

        assert.strictEqual(destroyed.status, Status.OK)
        const replaced = yield* exchange(sys(1111, 37), v1)
        assert.strictEqual(replaced.status, Status.OK)
        assert.notStrictEqual(replaced.value.clientid, second.value.clientid)
        const stale = yield* createSession(sys(501, 20), second.value.clientid, second.value.sequence + 1)
        assert.strictEqual(stale.status, Status.STALE_CLIENTID)

        // Cases 7 to 9: updates need a confirmed record, the same verifier, and the same principal.
        assert.strictEqual((yield* exchange(sys(1111, 37), v1, UPDATE)).status, Status.NOENT)
        const confirmedAgain = yield* createSession(sys(1111, 37), replaced.value.clientid, replaced.value.sequence)
        assert.strictEqual(confirmedAgain.status, Status.OK)
        assert.strictEqual((yield* exchange(sys(1111, 37), v2, UPDATE)).status, Status.NOT_SAME)
        assert.strictEqual((yield* exchange(sys(501, 20), v1, UPDATE)).status, Status.PERM)
        assert.strictEqual((yield* exchange(sys(1111, 37), v1, UPDATE)).status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should guard CREATE_SESSION by principal, channel size, and operation-level replay when CREATE_SESSION varies principal, channel size, or replay", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const handler = yield* wireClient(caller)

        const exchanged = yield* run(
          handler,
          callAs(sys(501, 20), [
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.EXCHANGE_ID)
                yield* writer.write(Xdr.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(Xdr.string(), "session-guards")
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
              })
          ])
        )

        // SAFETY: EXCHANGE_ID succeeded, so the body reader table produced the EXCHANGE_ID result shape.
        const { clientid, sequence: firstSequence } = exchanged.operations[0]!.value as {
          readonly clientid: bigint
          readonly sequence: number
        }

        const createSession =
          (sequenceId: number, maxRequest = 8192, maxResponse = 8192, flags = 0) => (writer: RequestWriter) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
              yield* writer.write(Xdr.uint64, clientid)
              yield* writer.write(Xdr.uint32, sequenceId)
              yield* writer.write(Xdr.uint32, flags)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, maxRequest)
              yield* writer.write(Xdr.uint32, maxResponse)
              yield* writer.write(Xdr.uint32, 8192)
              yield* writer.write(Xdr.uint32, 32)
              yield* writer.write(Xdr.uint32, 2)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 8192)
              yield* writer.write(Xdr.uint32, 8192)
              yield* writer.write(Xdr.uint32, 8192)
              yield* writer.write(Xdr.uint32, 32)
              yield* writer.write(Xdr.uint32, 2)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 0)
            })

        // An unconfirmed record rejects another principal without consuming the owner's slot.
        const inUse = yield* run(handler, callAs(sys(1111, 37), [createSession(firstSequence)]))
        assert.strictEqual(inUse.status, Status.CLID_INUSE)

        // Section 18.36.4 phase 2: a request with the expected csa_sequence consumes the slot even
        // when it fails, so the same sequence replays TOOSMALL and the corrected retry uses the next.
        const tooSmallRequest = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence, 20)]))
        assert.strictEqual(tooSmallRequest.status, Status.TOOSMALL)
        const replayedTooSmall = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence)]))
        assert.strictEqual(replayedTooSmall.status, Status.TOOSMALL, "the failed result is cached in the slot")
        const misordered = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence + 2)]))
        assert.strictEqual(misordered.status, Status.SEQ_MISORDERED)
        const tooSmallResponse = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence + 1, 8192, 0)]))
        assert.strictEqual(tooSmallResponse.status, Status.TOOSMALL)

        // Undefined csa_flags are INVAL and consume the slot too.
        const badFlags = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence + 2, 8192, 8192, 0x10)]))
        assert.strictEqual(badFlags.status, Status.INVAL)
        const replayedBadFlags = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence + 2)]))
        assert.strictEqual(replayedBadFlags.status, Status.INVAL, "the INVAL result is cached in the slot")

        const created = yield* run(handler, callAs(sys(501, 20), [createSession(firstSequence + 3)]))
        assert.strictEqual(created.status, Status.OK)
        // SAFETY: CREATE_SESSION succeeded, so the body reader table produced the CREATE_SESSION result shape.
        const { session } = created.operations[0]!.value as { readonly session: Uint8Array }

        // Once confirmed, any principal may create sessions.
        const other = yield* run(handler, callAs(sys(1111, 37), [createSession(firstSequence + 4)]))
        assert.strictEqual(other.status, Status.OK)

        // A retry inside a SEQUENCE compound replays the cached CREATE_SESSION result.
        const replayed = yield* run(
          handler,
          callAs(sys(1111, 37), [sequence(session, 1), createSession(firstSequence + 4)])
        )

        assert.strictEqual(replayed.status, Status.OK)
        assert.deepStrictEqual(replayed.operations[1]!.value, other.operations[0]!.value)
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should execute OPEN once when its reply is lost", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        let opens = 0

        const handler = yield* wireClient(observeOpen(caller, () => {
          opens++
        }))

        const {
          session,
          client
        } = yield* startSession(handler, "lost-open")

        const request = yield* call([
          sequence(session, 1, true),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.write(Xdr.uint32, Operation.GETFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.LOOKUP)
              yield* writer.write(Xdr.string(), "child")
            })
        ])

        const first = yield* handler.send(request)
        assert.strictEqual(yield* (replyReader(first)).read(Xdr.uint32), Status.NOTDIR)
        assert.deepStrictEqual(yield* handler.send(request), first)
        assert.strictEqual(opens, 1)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject an OPEN before execution when its cached result cannot fit", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        let opens = 0

        const handler = yield* wireClient(observeOpen(caller, () => {
          opens++
        }))

        const {
          session,
          client
        } = yield* startSession(handler, "open-capacity", {
          maxCachedResponse: 80
        })

        const request = yield* call([sequence(session, 1, true), (writer) =>
          writer.write(Xdr.uint32, Operation.PUTROOTFH), openReadOnly(client, "file")])

        assert.strictEqual((yield* statuses(yield* handler.send(request))).status, Status.REP_TOO_BIG_TO_CACHE)
        assert.strictEqual(opens, 0)
        assert.strictEqual((yield* statuses(yield* handler.send(request))).status, Status.REP_TOO_BIG_TO_CACHE)
        assert.strictEqual(opens, 0)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should serialize concurrent slot duplicates so OPEN runs exactly once when duplicate slot requests arrive concurrently", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        let opens = 0

        const handler = yield* wireClient(observeOpen(caller, () => {
          opens++
        }))

        const {
          client,
          session
        } = yield* startSession(handler, "concurrent")

        const request = yield* call([
          sequence(session, 1, true),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          openReadOnly(client, "file"),
          (writer) => writer.write(Xdr.uint32, Operation.GETFH)
        ])

        const [first, duplicate] = yield* Effect.all([
          handler.send(request),
          handler.send({ ...request, connection: connection(1) })
        ], {
          concurrency: "unbounded"
        })

        assert.deepStrictEqual(duplicate, first)
        assert.strictEqual(opens, 1)
      }).pipe(Effect.provide(Testing.layer())))
  })
})

type DecodedBody =
  | void
  | undefined
  | Uint8Array
  | ReadonlyArray<number>
  | { readonly supported: number; readonly access: number }
  | { readonly eof: boolean; readonly data: Uint8Array }
  | { readonly clientid: bigint; readonly sequence: number; readonly flags: number }
  | { readonly session: Uint8Array; readonly sequence: number }
  | { readonly stateid: Uint8Array; readonly delegation: number; readonly why: number }
  | { readonly session: Uint8Array; readonly direction: number; readonly rdma: boolean }

type BodyReader = (reader: ReplyReader) => Effect.Effect<DecodedBody>

type DecodedReply = {
  readonly status: number
  readonly operations: ReadonlyArray<{ readonly code: number; readonly status: number; readonly value?: unknown }>
}

const bodyReaders = {
  [Operation.SEQUENCE]: (reader) =>
    Effect.gen(function*() {
      yield* reader.read(Xdr.fixedOpaque(16))
      yield* skipWords(reader, 5)
    }),
  [Operation.PUTROOTFH]: () => Effect.void,
  [Operation.PUTPUBFH]: () => Effect.void,
  [Operation.PUTFH]: () => Effect.void,
  [Operation.LOOKUP]: () => Effect.void,
  [Operation.VERIFY]: () => Effect.void,
  [Operation.NVERIFY]: () => Effect.void,
  [Operation.FREE_STATEID]: () => Effect.void,
  [Operation.GETFH]: (reader) => reader.read(Xdr.opaque()),
  [Operation.ACCESS]: (reader) =>
    Effect.gen(function*() {
      const supported = yield* reader.read(Xdr.uint32)
      const access = yield* reader.read(Xdr.uint32)

      return { supported, access }
    }),
  [Operation.COMMIT]: (reader) => reader.read(Xdr.fixedOpaque(8)),
  [Operation.SECINFO]: (reader) => reader.read(Xdr.array(Xdr.uint32)),
  [Operation.TEST_STATEID]: (reader) => reader.read(Xdr.array(Xdr.uint32)),
  [Operation.OPEN_DOWNGRADE]: (reader) => reader.read(Xdr.fixedOpaque(16)),
  [Operation.CLOSE]: (reader) => reader.read(Xdr.fixedOpaque(16)),
  [Operation.LOCKT]: () => Effect.void,
  [Operation.READLINK]: (reader) => reader.read(Xdr.opaque()),
  [Operation.BACKCHANNEL_CTL]: () => Effect.void,
  [Operation.BIND_CONN_TO_SESSION]: (reader) =>
    Effect.gen(function*() {
      const session = yield* reader.read(Xdr.fixedOpaque(16))
      const direction = yield* reader.read(Xdr.uint32)
      const rdma = yield* reader.read(Xdr.boolean)

      return { session, direction, rdma }
    }),
  [Operation.READ]: (reader) =>
    Effect.gen(function*() {
      const eof = yield* reader.read(Xdr.boolean)
      const data = yield* reader.read(Xdr.opaque())

      return { eof, data }
    }),
  [Operation.OPEN]: (reader) =>
    Effect.gen(function*() {
      const stateid = yield* reader.read(Xdr.fixedOpaque(16))
      yield* reader.read(Xdr.boolean)
      yield* reader.read(Xdr.uint64)
      yield* reader.read(Xdr.uint64)
      yield* reader.read(Xdr.uint32)
      yield* reader.read(Xdr.array(Xdr.uint32))
      const delegation = yield* reader.read(Xdr.uint32)
      const why = delegation === 3 ? yield* reader.read(Xdr.uint32) : -1

      return { stateid, delegation, why }
    }),
  [Operation.LOOKUPP]: () => Effect.void,
  [Operation.SAVEFH]: () => Effect.void,
  [Operation.RESTOREFH]: () => Effect.void,
  [Operation.RECLAIM_COMPLETE]: () => Effect.void,
  [Operation.DESTROY_SESSION]: () => Effect.void,
  [Operation.SECINFO_NO_NAME]: (reader) => reader.read(Xdr.array(Xdr.uint32)),
  [Operation.EXCHANGE_ID]: (reader) =>
    Effect.gen(function*() {
      const clientid = yield* reader.read(Xdr.uint64)
      const sequence = yield* reader.read(Xdr.uint32)
      const flags = yield* reader.read(Xdr.uint32)
      yield* reader.read(Xdr.uint32)
      yield* reader.read(Xdr.uint64)
      yield* reader.read(Xdr.opaque())
      yield* reader.read(Xdr.opaque())
      yield* reader.read(Xdr.array(Xdr.uint32))

      return { clientid, sequence, flags }
    }),
  [Operation.CREATE_SESSION]: (reader) =>
    Effect.gen(function*() {
      const session = yield* reader.read(Xdr.fixedOpaque(16))
      const sequence = yield* reader.read(Xdr.uint32)
      yield* reader.read(Xdr.uint32)
      yield* Effect.forEach([0, 1], () =>
        Effect.gen(function*() {
          yield* skipWords(reader, 6)
          yield* reader.read(Xdr.array(Xdr.uint32))
        }), { discard: true })

      return { session, sequence }
    })
} satisfies Readonly<Record<number, BodyReader>>

const decodeCompound = Effect.fnUntraced(function*(bytes: Uint8Array) {
  const reader = replyReader(bytes)
  const status = yield* reader.read(Xdr.uint32)
  yield* reader.read(Xdr.string())
  const count = yield* reader.read(Xdr.uint32)
  const operations: Array<{ readonly code: number; readonly status: number; readonly value?: unknown }> = []

  for (let index = 0; index < count; index++) {
    const code = yield* reader.read(Xdr.uint32)
    const operationStatus = yield* reader.read(Xdr.uint32)

    if (operationStatus !== Status.OK) {
      operations.push({ code, status: operationStatus })
      continue
    }

    // SAFETY: The own-property check proves that a known operation code indexes this table.
    const body = Object.hasOwn(bodyReaders, code) ? bodyReaders[code as keyof typeof bodyReaders] : undefined

    if (body === undefined) throw new Error(`No body reader for operation ${code}`)
    operations.push({ code, status: operationStatus, value: yield* body(reader) })
  }

  yield* reader.finish

  return { status, operations }
})

const run = (client: WireClient, request: ReturnType<typeof call>) =>
  Effect.flatMap(request, (message) => Effect.flatMap(client.send(message), decodeCompound))

describe("CompoundBasics over TCP", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should save and restore the current filehandle within a compound when SAVEFH and RESTOREFH run in one compound", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openWireSession(caller, "saved-filehandle")

        const response = yield* handler.send(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            (writer) => writer.write(Xdr.uint32, Operation.SAVEFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                yield* writer.write(Xdr.string(), "child")
              }),
            (writer) => writer.write(Xdr.uint32, Operation.RESTOREFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                yield* writer.write(Xdr.string(), "child")
              })
          ])
        )

        assert.strictEqual((yield* statuses(response)).status, Status.OK)
      }).pipe(
        Effect.provide(
          Testing.layer({ fixture: { entries: [{ kind: "file", path: "/child", bytes: new Uint8Array([1]) }] } })
        )
      ))

    it.effect("should advertise the client ID as a non-pNFS implementation when GETATTR asks for the server implementation identity", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* wireClient(caller)

        const response = replyReader(yield* handler.send(yield* call([ownerExchange("macos-client")])))

        assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
        yield* response.read(Xdr.string())
        assert.strictEqual(yield* response.read(Xdr.uint32), 1)
        assert.strictEqual(yield* response.read(Xdr.uint32), Operation.EXCHANGE_ID)
        assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
        yield* response.read(Xdr.uint64)
        yield* response.read(Xdr.uint32)
        assert.strictEqual(yield* response.read(Xdr.uint32), 0x0001_0000)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should mark a repeated EXCHANGE_ID after CREATE_SESSION as confirmed when EXCHANGE_ID repeats after CREATE_SESSION", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* wireClient(caller)

        const started = yield* startSession(handler, "confirmed-client")

        const response = replyReader(yield* handler.send(yield* call([ownerExchange("confirmed-client")])))

        assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
        yield* response.read(Xdr.string())
        yield* response.read(Xdr.uint32)
        yield* response.read(Xdr.uint32)
        yield* response.read(Xdr.uint32)
        assert.strictEqual(yield* response.read(Xdr.uint64), started.client)
        yield* response.read(Xdr.uint32)
        assert.strictEqual(yield* response.read(Xdr.uint32), 0x8001_0000)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should apply confirmed-record EXCHANGE_ID update rules when an existing client record receives EXCHANGE_ID", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* wireClient(caller)

        const update = (owner: string, verifier: Uint8Array) =>
          call([(writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.EXCHANGE_ID)
              yield* writer.write(Xdr.fixedOpaque(verifier.length), verifier)
              yield* writer.write(Xdr.string(), owner)
              yield* writer.write(Xdr.uint32, 0x4000_0000)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 0)
            })])

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(yield* update("missing-update", new Uint8Array(8))))).read(
            Xdr.uint32
          ),
          Status.NOENT
        )
        const verifier = new Uint8Array(8).fill(3)
        const started = yield* startSession(handler, "confirmed-update", {}, verifier)
        assert.strictEqual(
          yield* (replyReader(yield* handler.send(yield* update("confirmed-update", new Uint8Array(8).fill(4))))).read(
            Xdr.uint32
          ),
          Status.NOT_SAME
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(yield* call([ownerExchange("confirmed-update", new Uint8Array(8).fill(5))]))
          )).read(Xdr.uint32),
          Status.OK
        )

        const matching = replyReader(yield* handler.send(yield* update("confirmed-update", verifier)))

        assert.strictEqual(yield* matching.read(Xdr.uint32), Status.OK)
        yield* matching.read(Xdr.string())
        yield* matching.read(Xdr.uint32)
        yield* matching.read(Xdr.uint32)
        yield* matching.read(Xdr.uint32)
        assert.strictEqual(yield* matching.read(Xdr.uint64), started.client)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject EXCHANGE_ID argument flags that are not valid for clients when a client sends invalid EXCHANGE_ID flags", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxClients: 1
        }

        const handler = yield* wireClient(caller, { limits: constrained })

        const invalid = yield* call([(writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.EXCHANGE_ID)
            yield* writer.write(Xdr.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
            yield* writer.write(Xdr.string(), "invalid-flags")
            yield* writer.write(Xdr.uint32, 0x8000_0000)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 0)
          })])

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(invalid))).read(Xdr.uint32),
          Status.INVAL
        )

        const requestedNonPnfs = yield* call([(writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.EXCHANGE_ID)
            yield* writer.write(Xdr.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
            yield* writer.write(Xdr.string(), "valid-flags")
            yield* writer.write(Xdr.uint32, 0x0001_0000)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 0)
          })])

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(requestedNonPnfs))).read(Xdr.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should accept the AUTH_SYS callback credential sent by macOS when a macOS client offers AUTH_SYS for callbacks", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* wireClient(caller)

        const exchange = replyReader(yield* handler.send(yield* call([ownerExchange("macos-session")])))

        yield* exchange.read(Xdr.uint32)
        yield* exchange.read(Xdr.string())
        yield* exchange.read(Xdr.uint32)
        yield* exchange.read(Xdr.uint32)
        yield* exchange.read(Xdr.uint32)
        const client = yield* exchange.read(Xdr.uint64)

        const response = yield* handler.send(
          yield* call([(writer) =>
            Effect.gen(function*() {
              yield* Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
                yield* writer.write(Xdr.uint64, client)
                yield* writer.write(Xdr.uint32, 1)
                yield* writer.write(Xdr.uint32, 2)
              })
              yield* channel(writer, 64)
              yield* channel(writer, 4)
              yield* Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, 8_388_608)
                yield* writer.write(Xdr.uint32, 1)
                yield* authSysCallback(writer)
              })
            })], "createsession")
        )

        const result = replyReader(response)
        assert.strictEqual(yield* result.read(Xdr.uint32), Status.OK)
        assert.strictEqual(yield* result.read(Xdr.string()), "createsession")
        assert.strictEqual(yield* result.read(Xdr.uint32), 1)
        assert.strictEqual(yield* result.read(Xdr.uint32), Operation.CREATE_SESSION)
        assert.strictEqual(yield* result.read(Xdr.uint32), Status.OK)
        yield* result.read(Xdr.fixedOpaque(16))
        assert.strictEqual(yield* result.read(Xdr.uint32), 1)

        // csa_flags asked for CONN_BACK_CHAN, so csr_flags must echo it: the client binds the
        // connection to the backchannel on the strength of this echo (Section 18.36.3).
        assert.strictEqual(yield* result.read(Xdr.uint32), 2)
        assert.deepStrictEqual(
          yield* Effect.forEach(
            Array.from({
              length: 6
            }),
            () => result.read(Xdr.uint32)
          ),
          [0, 65_536, 65_536, 65_536, 32, 4]
        )
        assert.deepStrictEqual(yield* result.read(Xdr.array(Xdr.uint32)), [])
        assert.deepStrictEqual(
          yield* Effect.forEach(
            Array.from({
              length: 6
            }),
            () => result.read(Xdr.uint32)
          ),
          [0, 65_536, 65_536, 65_536, 32, 4]
        )
        assert.deepStrictEqual(yield* result.read(Xdr.array(Xdr.uint32)), [])
        yield* result.finish
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should return BADXDR before a malformed read-only mutation can report ROFS when a malformed read-only mutation is decoded", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* wireClient(caller)

        const malformed = yield* Effect.gen(function*() {
          const xdrWriter = requestWriter()
          yield* xdrWriter.write(Xdr.string(), "bad")
          yield* xdrWriter.write(Xdr.uint32, 1)
          yield* xdrWriter.write(Xdr.uint32, 1)
          yield* xdrWriter.write(Xdr.uint32, Operation.WRITE)
          yield* xdrWriter.write(Xdr.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))

          return yield* xdrWriter.finish
        })

        const reader = replyReader(
          yield* handler.send({
            connection: connection(),
            credentials: {
              _tag: "None"
            },
            arguments: malformed
          })
        )

        assert.strictEqual(yield* reader.read(Xdr.uint32), Status.BADXDR)
        assert.strictEqual(yield* reader.read(Xdr.string()), "bad")

        const {
          session
        } = yield* startSession(handler, "writer")

        const write = yield* call([
          sequence(session, 1),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.WRITE)
              yield* writer.write(Xdr.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
              yield* writer.write(Xdr.uint64, 0n)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.opaque(), new Uint8Array([1]))
            })
        ])

        assert.strictEqual((yield* statuses(yield* handler.send(write))).status, Status.ROFS)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject trailing compound bytes and unsupported minor versions when a compound has trailing bytes or an unsupported minor version", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* wireClient(caller)

        const valid = (yield* call([])).arguments
        const trailing = new Uint8Array(valid.length + 4)
        trailing.set(valid)

        const malformed = replyReader(
          yield* handler.send({
            connection: connection(),
            credentials: {
              _tag: "None"
            },
            arguments: trailing
          })
        )

        assert.strictEqual(yield* malformed.read(Xdr.uint32), Status.BADXDR)

        const wrongMinor = yield* Effect.gen(function*() {
          const xdrWriter = requestWriter()
          yield* xdrWriter.write(Xdr.string(), "minor")
          yield* xdrWriter.write(Xdr.uint32, 0)
          yield* xdrWriter.write(Xdr.uint32, 0)

          return yield* xdrWriter.finish
        })

        const response = replyReader(
          yield* handler.send({
            connection: connection(),
            credentials: {
              _tag: "None"
            },
            arguments: wrongMinor
          })
        )

        assert.strictEqual(yield* response.read(Xdr.uint32), Status.MINOR_VERS_MISMATCH)
        assert.strictEqual(yield* response.read(Xdr.string()), "minor")
        assert.strictEqual(yield* response.read(Xdr.uint32), 0)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should report TOO_MANY_OPS from the header count even when a later operation is malformed", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const handler = yield* wireClient(caller)
        const { session } = yield* startSession(handler, "count", { maxOperations: 3 })

        const oversized = call([
          sequence(session, 1),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.LOOKUP)
              yield* writer.write(Xdr.uint32, 100)
            }),
          (writer) => writer.write(Xdr.uint32, Operation.GETFH),

          (writer) => writer.write(Xdr.uint32, Operation.GETFH)
        ])

        assert.deepStrictEqual((yield* run(handler, oversized)).operations, [
          { code: Operation.SEQUENCE, status: Status.TOO_MANY_OPS }
        ])
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should report writable directory access for an authorized mapped caller when an authorized mapped caller requests directory ACCESS", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openWireSession(caller, "writable-access", {
          writable: true,
          mappedCaller: caller
        })

        const reply = yield* handler.send(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.ACCESS)
                yield* writer.write(Xdr.uint32, 0x1f)
              })
          ])
        )

        const reader = replyReader(reply)
        assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
        yield* reader.read(Xdr.string())
        assert.strictEqual(yield* reader.read(Xdr.uint32), 3)
        assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SEQUENCE)
        assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
        yield* reader.read(Xdr.fixedOpaque(16))

        for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
        assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.PUTROOTFH)
        assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
        assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.ACCESS)
        assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
        assert.strictEqual(yield* reader.read(Xdr.uint32), 0x1f)
        assert.strictEqual(yield* reader.read(Xdr.uint32), 0x1f)
        yield* reader.finish
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should use both storage incarnation and server generation for COMMIT when a client requests COMMIT after a storage or server restart", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const verifiers: Array<Uint8Array> = []

        for (const [serverByte, storageByte] of [[7, 9], [8, 9], [6, 8]] as const) {
          const serverGeneration = new Uint8Array(16).fill(serverByte)
          const storageGeneration = new Uint8Array(16).fill(storageByte)

          const { handler, session } = yield* openWireSession(caller, "commit-storage-generation", {
            generation: serverGeneration,
            storageGeneration
          })

          const response = replyReader(
            yield* handler.send(
              yield* call([
                sequence(session, 1),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                    yield* writer.write(Xdr.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.COMMIT)
                    yield* writer.write(Xdr.uint64, 0n)
                    yield* writer.write(Xdr.uint32, 0)
                  })
              ])
            )
          )

          assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
          yield* response.read(Xdr.string())
          assert.strictEqual(yield* response.read(Xdr.uint32), 4)
          assert.strictEqual(yield* response.read(Xdr.uint32), Operation.SEQUENCE)
          assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
          yield* response.read(Xdr.fixedOpaque(16))

          for (let field = 0; field < 5; field++) yield* response.read(Xdr.uint32)

          for (const operation of [Operation.PUTROOTFH, Operation.LOOKUP, Operation.COMMIT]) {
            assert.strictEqual(yield* response.read(Xdr.uint32), operation)
            assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
          }

          verifiers.push(yield* response.read(Xdr.fixedOpaque(8)))
          yield* response.finish
        }

        assert.strictEqual(verifiers.length, 3)
        assert.isFalse(verifiers[0]!.every((byte, index) => byte === verifiers[1]![index]))
        assert.isFalse(verifiers[0]!.every((byte, index) => byte === verifiers[2]![index]))
        assert.isFalse(verifiers[1]!.every((byte, index) => byte === verifiers[2]![index]))
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should echo the tag, executes in order, and stop at a missing LOOKUP when a compound contains a missing LOOKUP", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* wireClient(caller)

        const {
          session
        } = yield* startSession(handler, "missing-client")

        const response = yield* handler.send(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                yield* writer.write(Xdr.string(), "missing")
              }),
            (writer) => writer.write(Xdr.uint32, Operation.GETFH)
          ], "missing-probe")
        )

        assert.deepStrictEqual(yield* statuses(response), {
          status: Status.NOENT,
          tag: "missing-probe",
          operations: [[Operation.SEQUENCE, Status.OK], [Operation.PUTROOTFH, Status.OK], [
            Operation.LOOKUP,
            Status.NOENT
          ]]
        })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should report an illegal first opcode as OP_ILLEGAL and a malformed operation in place when an opcode is illegal or its body is malformed", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const handler = yield* wireClient(caller)

        const illegal = yield* run(
          handler,
          call([(writer) => writer.write(Xdr.uint32, 99_999)])
        )

        assert.deepStrictEqual(illegal.operations, [{ code: Operation.ILLEGAL, status: Status.OP_ILLEGAL }])

        // A LOOKUP whose name length exceeds the remaining bytes never decodes.
        const truncatedLookup = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.LOOKUP)
          yield* writer.write(Xdr.uint32, 100)
        })

        const beforeSession = yield* run(handler, call([truncatedLookup]))
        assert.deepStrictEqual(beforeSession.operations, [{ code: Operation.LOOKUP, status: Status.BADXDR }])

        const { session } = yield* startSession(handler, "malformed")

        const request = yield* call([
          sequence(session, 1, true),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

          truncatedLookup,
          (writer) => writer.write(Xdr.uint32, Operation.GETFH)
        ])

        // Section 15.1.1.1: the operations before the malformed one are processed and reported.
        const first = yield* handler.send(request)
        const reply = yield* decodeCompound(first)
        assert.strictEqual(reply.status, Status.BADXDR)
        assert.strictEqual(reply.operations.length, 3)
        assert.strictEqual(reply.operations[1]!.status, Status.OK)
        assert.deepStrictEqual(reply.operations[2], { code: Operation.LOOKUP, status: Status.BADXDR })

        // The slot was consumed, so the retry is served from the reply cache.
        assert.deepStrictEqual(yield* handler.send(request), first)
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("Lifecycle over TCP", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should close remaining opens when the handler scope closes", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const root = yield* caller.root
        const reference = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("file")))
        const scope = yield* Scope.make()

        const handler = yield* wireClient(caller).pipe(Effect.provideService(Scope.Scope, scope))

        const client = yield* startSession(handler, "handler-finalizer")
        yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(client.session, 1, true),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(client.client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )
        yield* caller.unlink("/file")
        assert.strictEqual((yield* caller.stat(reference)).nlink, 0)
        yield* Scope.close(scope, Exit.void)
        assert.strictEqual((yield* Effect.flip(caller.stat(reference))).code, "StaleReference")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should keep a client busy until its open and session are destroyed when a client still owns an open and session", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const root = yield* caller.root
        const reference = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("file")))

        const handler = yield* wireClient(caller)

        const client = yield* startSession(handler, "destroy-client")

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(client.session, 1, true),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(client.client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([sequence(client.session, 2), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.RECLAIM_COMPLETE)
                  yield* writer.write(Xdr.boolean, false)
                })])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([sequence(client.session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.RECLAIM_COMPLETE)
                  yield* writer.write(Xdr.boolean, false)
                })])
            )
          )).read(Xdr.uint32),
          Status.COMPLETE_ALREADY
        )
        yield* caller.unlink("/file")
        assert.strictEqual((yield* caller.stat(reference)).nlink, 0)
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.DESTROY_CLIENTID)
                  yield* writer.write(Xdr.uint64, client.client)
                })])
            )
          )).read(Xdr.uint32),
          Status.CLIENTID_BUSY
        )

        const sequencedDestroy = yield* call([sequence(client.session, 4, true), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.DESTROY_CLIENTID)
            yield* writer.write(Xdr.uint64, client.client)
          })])

        const firstBusy = yield* handler.send(sequencedDestroy)
        assert.strictEqual(
          yield* (replyReader(firstBusy)).read(Xdr.uint32),
          Status.CLIENTID_BUSY
        )
        assert.deepStrictEqual(yield* handler.send(sequencedDestroy), firstBusy)
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([sequence(client.session, 5), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), opened.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.CLOSE)
                  yield* writer.write(Xdr.uint32, 0)
                  yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
                })])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.DESTROY_SESSION)
                  yield* writer.write(Xdr.fixedOpaque(client.session.length), client.session)
                })])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.DESTROY_CLIENTID)
                  yield* writer.write(Xdr.uint64, client.client)
                })])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
        assert.strictEqual((yield* Effect.flip(caller.stat(reference))).code, "StaleReference")
        assert.strictEqual(
          yield* (replyReader(yield* handler.send(yield* call([sequence(client.session, 6)]))))
            .read(Xdr.uint32),
          Status.BADSESSION
        )
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should reuse session and open capacity after explicit teardown when sessions and opens are explicitly torn down", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxSessions: 1,
          maxOpens: 1
        }

        const handler = yield* wireClient(caller, { limits: constrained })

        const first = yield* startSession(handler, "first-capacity")

        const secondExchange = replyReader(yield* handler.send(yield* call([ownerExchange("second-capacity")])))

        yield* secondExchange.read(Xdr.uint32)
        yield* secondExchange.read(Xdr.string())
        yield* secondExchange.read(Xdr.uint32)
        yield* secondExchange.read(Xdr.uint32)
        yield* secondExchange.read(Xdr.uint32)
        const secondClient = yield* secondExchange.read(Xdr.uint64)

        const createSecond = (sequenceId: number) =>
          call([(writer) =>
            Effect.gen(function*() {
              yield* Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
                yield* writer.write(Xdr.uint64, secondClient)
                yield* writer.write(Xdr.uint32, sequenceId)
                yield* writer.write(Xdr.uint32, 0)
              })
              yield* channel(writer, 2)
              yield* channel(writer, 0)
              yield* Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
              })
            })])

        const failedCreate = yield* createSecond(1)
        assert.strictEqual(
          yield* (replyReader(yield* handler.send(failedCreate))).read(Xdr.uint32),
          Status.DELAY
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([(writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.DESTROY_SESSION)
                  yield* writer.write(Xdr.fixedOpaque(first.session.length), first.session)
                })])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
        // The failed attempt did not consume the sequence slot, so the same request now succeeds.
        const created = replyReader(yield* handler.send(failedCreate))
        assert.strictEqual(yield* created.read(Xdr.uint32), Status.OK)
        yield* created.read(Xdr.string())
        yield* created.read(Xdr.uint32)
        yield* created.read(Xdr.uint32)
        yield* created.read(Xdr.uint32)
        const secondSession = yield* created.read(Xdr.fixedOpaque(16))

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(secondSession, 1, true),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(secondClient, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        const full = yield* call([
          sequence(secondSession, 2),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.OPEN)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 1)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint64, secondClient)
              yield* writer.write(Xdr.string(), "other-owner")
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.string(), "file")
            })
        ])

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(full))).read(Xdr.uint32),
          Status.DELAY
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([sequence(secondSession, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), opened.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.CLOSE)
                  yield* writer.write(Xdr.uint32, 0)
                  yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
                })])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([
                sequence(secondSession, 4),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                openReadOnly(secondClient, "file")
              ])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should preserve prior results before an unknown operation and structurally validates mutation attrs when a compound reaches an unknown operation or malformed mutation attrs", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const handler = yield* wireClient(caller)

        const client = yield* startSession(handler, "decode")

        const unknown = yield* call([
          sequence(client.session, 1),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, 99_999)
              yield* writer.write(Xdr.uint32, 0xdeadbeef)
            })
        ])

        const unknownResult = yield* statuses(yield* handler.send(unknown))
        assert.strictEqual(unknownResult.status, Status.OP_ILLEGAL)
        assert.deepStrictEqual(unknownResult.operations.at(-1), [Operation.ILLEGAL, Status.OP_ILLEGAL])

        const malformed = yield* call([
          sequence(client.session, 2),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.SETATTR)
              yield* writer.write(Xdr.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
              yield* writer.write(Xdr.uint32, 2)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 1 << 1)
              yield* writer.write(Xdr.opaque(), new Uint8Array())
            })
        ])

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(malformed))).read(Xdr.uint32),
          Status.BADXDR
        )
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should sweep expired clients before applying capacity limits and close their opens when expired clients count toward capacity", () =>
      Effect.gen(function*() {
        let now = 0
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const root = yield* caller.root
        const reference = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("file")))

        const constrained = {
          ...limits,
          maxClients: 1,
          maxSessions: 1,
          maxOpens: 1
        }

        const handler = yield* wireClient(caller, { leaseDurationSeconds: 1, now: () => now, limits: constrained })

        const first = yield* startSession(handler, "expires")
        yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(first.session, 1, true),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(first.client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )
        yield* caller.unlink("/file")
        assert.strictEqual((yield* caller.stat(reference)).nlink, 0)
        now = 1_001
        yield* startSession(handler, "replacement")
        assert.strictEqual((yield* Effect.flip(caller.stat(reference))).code, "StaleReference")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reclaim an expired lease without waiting for another client's traffic when an open-owning client lease expires without other traffic", () =>
      Effect.gen(function*() {
        let now = 0
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const root = yield* caller.root
        const reference = yield* caller.lookup(Vfs.Entry(root, new TextEncoder().encode("file")))

        const handler = yield* wireClient(caller, { leaseDurationSeconds: 1, now: () => now })

        // One connection object for both calls: `session.connections` is keyed by identity, so a
        // fresh `connection()` would disconnect nothing and the drop below would prove nothing.
        const dropped = connection(1)
        const abandoned = yield* startSession(handler, "abandoned", {}, new Uint8Array(8), dropped)
        yield* parseOpen(
          yield* handler.send(
            yield* call(
              [
                sequence(abandoned.session, 1, true),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                openReadOnly(abandoned.client, "file"),
                (writer) => writer.write(Xdr.uint32, Operation.GETFH)
              ],
              "probe",
              dropped
            )
          )
        )
        yield* caller.unlink("/file")
        assert.strictEqual((yield* caller.stat(reference)).nlink, 0)

        // The client drops its connection and never returns. Nothing else reaches the server, so
        // reclamation has to come from the handler's own schedule rather than another compound.
        yield* handler.close(dropped)
        now = 1_001
        yield* TestClock.adjust("2 seconds")

        // Observed through the VFS rather than a compound: any compound would itself sweep, which
        // is exactly the traffic this test must do without.
        assert.strictEqual((yield* Effect.flip(caller.stat(reference))).code, "StaleReference")
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("MetadataReadDir over TCP", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should normalize negative timestamps and reject seconds outside the NFS int64 range when NFS timestamps are negative or exceed int64 seconds", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        yield* caller.utimes("/file", {
          access: {
            kind: "value",
            nanoseconds: -500_000_000n
          },
          modification: {
            kind: "omit"
          }
        })

        const { handler, session } = yield* openWireSession(caller, "timestamp-bounds")

        const getattr = Effect.fnUntraced(function*(sequenceId: number) {
          return yield* handler.send(
            yield* call([
              sequence(session, sequenceId),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                  yield* writer.write(Xdr.string(), "file")
                }),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.GETATTR)
                  yield* writer.write(Xdr.uint32, [0, 1 << 15].length)

                  for (const xdrValue of [0, 1 << 15]) {
                    yield* ((item, word) =>
                      Effect.gen(function*() {
                        const xdrWriter = item
                        yield* xdrWriter.write(Xdr.uint32, word)
                      }))(writer, xdrValue)
                  }
                })
            ])
          )
        })

        const response = replyReader(yield* getattr(1))
        assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
        yield* response.read(Xdr.string())
        yield* response.read(Xdr.uint32)
        yield* response.read(Xdr.uint32)
        yield* response.read(Xdr.uint32)
        yield* response.read(Xdr.fixedOpaque(16))

        for (let field = 0; field < 5; field++) yield* response.read(Xdr.uint32)

        for (let operation = 0; operation < 2; operation++) {
          yield* response.read(Xdr.uint32)
          yield* response.read(Xdr.uint32)
        }

        assert.strictEqual(yield* response.read(Xdr.uint32), Operation.GETATTR)
        assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
        assert.deepStrictEqual(yield* response.read(Xdr.array(Xdr.uint32)), [0, 1 << 15])
        const values = replyReader(yield* response.read(Xdr.opaque()))
        assert.strictEqual(yield* values.read(Xdr.uint64), 0xffff_ffff_ffff_ffffn)
        assert.strictEqual(yield* values.read(Xdr.uint32), 500_000_000)
        yield* values.finish
        yield* response.finish
        yield* caller.utimes("/file", {
          access: {
            kind: "value",
            nanoseconds: 0x8000_0000_0000_0000n * 1_000_000_000n
          },
          modification: {
            kind: "omit"
          }
        })
        assert.strictEqual(
          yield* (replyReader(yield* getattr(2))).read(Xdr.uint32),
          Status.SERVERFAULT
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject every decoded mutation as read-only without changing the volume when a decoded mutation reaches a read-only export", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const original = new Uint8Array([1, 2, 3])
        yield* caller.writeFile("/file", original, {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* wireClient(caller)

        const client = yield* startSession(handler, "mutations")

        const mutations: ReadonlyArray<{
          readonly setup?: WriteOperation
          readonly operation: WriteOperation
        }> = [{
          setup: Effect.fnUntraced(function*(writer) {
            yield* writer.write(Xdr.uint32, Operation.LOOKUP)
            yield* writer.write(Xdr.string(), "file")
          }),
          operation: Effect.fnUntraced(function*(writer) {
            yield* writer.write(Xdr.uint32, Operation.SETATTR)
            yield* writer.write(Xdr.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
            yield* writer.write(Xdr.uint32, 1)
            yield* writer.write(Xdr.uint32, 1 << 12)
            yield* writer.write(Xdr.opaque(), new Uint8Array())
          })
        }, {
          setup: Effect.fnUntraced(function*(writer) {
            yield* writer.write(Xdr.uint32, Operation.LOOKUP)
            yield* writer.write(Xdr.string(), "file")
          }),
          operation: Effect.fnUntraced(function*(writer) {
            yield* writer.write(Xdr.uint32, Operation.WRITE)
            yield* writer.write(Xdr.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
            yield* writer.write(Xdr.uint64, 0n)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.opaque(), new Uint8Array([9]))
          })
        }, {
          operation: Effect.fnUntraced(function*(writer) {
            yield* writer.write(Xdr.uint32, Operation.CREATE)
            yield* writer.write(Xdr.uint32, 2)
            yield* writer.write(Xdr.string(), "created")
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.opaque(), new Uint8Array())
          })
        }, {
          operation: Effect.fnUntraced(function*(writer) {
            yield* writer.write(Xdr.uint32, Operation.REMOVE)
            yield* writer.write(Xdr.string(), "file")
          })
        }, {
          setup: (writer) => writer.write(Xdr.uint32, Operation.SAVEFH),
          operation: Effect.fnUntraced(function*(writer) {
            yield* writer.write(Xdr.uint32, Operation.RENAME)
            yield* writer.write(Xdr.string(), "file")
            yield* writer.write(Xdr.string(), "renamed")
          })
        }, {
          setup: (writer) => writer.write(Xdr.uint32, Operation.SAVEFH),
          operation: Effect.fnUntraced(function*(writer) {
            yield* writer.write(Xdr.uint32, Operation.LINK)
            yield* writer.write(Xdr.string(), "linked")
          })
        }]

        for (let index = 0; index < mutations.length; index++) {
          const mutation = mutations[index]!

          const response = yield* handler.send(
            yield* call([
              sequence(client.session, index + 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              ...(mutation.setup === undefined ? [] : [mutation.setup]),
              mutation.operation
            ])
          )

          assert.strictEqual(yield* (replyReader(response)).read(Xdr.uint32), Status.ROFS)
        }

        assert.deepStrictEqual(yield* caller.readFile("/file"), original)

        for (const path of ["/created", "/renamed", "/linked"]) {
          assert.strictEqual((yield* Effect.flip(caller.stat(path))).code, "NotFound")
        }
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should report bounded volume capacity and omit unbounded totals when GETATTR queries bounded and unbounded volumes", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/dir")
        yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* wireClient(caller)

        const {
          session
        } = yield* startSession(handler, "bounded-capacity")

        const requested = [1 | 1 << 21 | 1 << 22 | 1 << 23 | 1 << 27, 1 << 10 | 1 << 11 | 1 << 12]

        const response = replyReader(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.GETATTR)
                  yield* writer.write(Xdr.uint32, requested.length)

                  for (const xdrValue of requested) {
                    yield* ((item, word) =>
                      Effect.gen(function*() {
                        const xdrWriter = item
                        yield* xdrWriter.write(Xdr.uint32, word)
                      }))(writer, xdrValue)
                  }
                })
            ])
          )
        )

        assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
        yield* response.read(Xdr.string())
        yield* response.read(Xdr.uint32)
        yield* response.read(Xdr.uint32)
        yield* response.read(Xdr.uint32)
        yield* response.read(Xdr.fixedOpaque(16))

        for (let field = 0; field < 5; field++) {
          yield* response.read(Xdr.uint32)
        }

        yield* response.read(Xdr.uint32)
        yield* response.read(Xdr.uint32)
        assert.strictEqual(yield* response.read(Xdr.uint32), Operation.GETATTR)
        assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
        assert.deepStrictEqual(yield* response.read(Xdr.array(Xdr.uint32)), requested)
        const values = replyReader(yield* response.read(Xdr.opaque()))
        const supported = yield* values.read(Xdr.array(Xdr.uint32))
        assert.strictEqual(supported[0]! & requested[0]!, requested[0]!)
        assert.strictEqual(supported[1]! & requested[1]!, requested[1]!)
        assert.strictEqual(yield* values.read(Xdr.uint64), 1n, "files_avail")
        assert.strictEqual(yield* values.read(Xdr.uint64), 1n, "files_free")
        assert.strictEqual(yield* values.read(Xdr.uint64), 3n, "files_total")
        assert.strictEqual(yield* values.read(Xdr.uint64), 0xffff_ffffn, "maxfilesize")
        assert.strictEqual(yield* values.read(Xdr.uint64), 7n, "space_avail")
        assert.strictEqual(yield* values.read(Xdr.uint64), 7n, "space_free")
        assert.strictEqual(yield* values.read(Xdr.uint64), 10n, "space_total")
        yield* values.finish
        yield* response.finish
        const unlimited = yield* Vfs.make()
        const unlimitedCaller = yield* unlimited.caller()

        const unlimitedHandler = yield* wireClient(unlimitedCaller).pipe(
          Effect.provideService(Vfs.Volume, unlimited)
        )

        const unlimitedSession = yield* startSession(unlimitedHandler, "unbounded-capacity")

        const unboundedResponse = replyReader(
          yield* unlimitedHandler.send(
            yield* call([
              sequence(unlimitedSession.session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.GETATTR)
                  yield* writer.write(Xdr.uint32, requested.length)

                  for (const xdrValue of requested) {
                    yield* ((item, word) =>
                      Effect.gen(function*() {
                        const xdrWriter = item
                        yield* xdrWriter.write(Xdr.uint32, word)
                      }))(writer, xdrValue)
                  }
                })
            ])
          )
        )

        assert.strictEqual(yield* unboundedResponse.read(Xdr.uint32), Status.OK)
        yield* unboundedResponse.read(Xdr.string())
        yield* unboundedResponse.read(Xdr.uint32)
        yield* unboundedResponse.read(Xdr.uint32)
        yield* unboundedResponse.read(Xdr.uint32)
        yield* unboundedResponse.read(Xdr.fixedOpaque(16))

        for (let field = 0; field < 5; field++) {
          yield* unboundedResponse.read(Xdr.uint32)
        }

        yield* unboundedResponse.read(Xdr.uint32)
        yield* unboundedResponse.read(Xdr.uint32)
        assert.strictEqual(yield* unboundedResponse.read(Xdr.uint32), Operation.GETATTR)
        assert.strictEqual(yield* unboundedResponse.read(Xdr.uint32), Status.OK)
        assert.deepStrictEqual(yield* unboundedResponse.read(Xdr.array(Xdr.uint32)), [1 | 1 << 27])
        const unboundedValues = replyReader(yield* unboundedResponse.read(Xdr.opaque()))
        const unboundedSupported = yield* unboundedValues.read(Xdr.array(Xdr.uint32))
        assert.strictEqual(unboundedSupported[0]! & requested[0]!, 1 | 1 << 27)
        assert.strictEqual((unboundedSupported[1] ?? 0) & requested[1]!, 0)
        assert.strictEqual(yield* unboundedValues.read(Xdr.uint64), 0xffff_ffffn)
        yield* unboundedValues.finish
        yield* unboundedResponse.finish

        const unsupportedVerify = yield* unlimitedHandler.send(
          yield* call([
            sequence(unlimitedSession.session, 2),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.VERIFY)
                yield* writer.write(Xdr.uint32, [0, 1 << 10].length)

                for (const xdrValue of [0, 1 << 10]) {
                  yield* ((item, word) =>
                    Effect.gen(function*() {
                      const xdrWriter = item
                      yield* xdrWriter.write(Xdr.uint32, word)
                    }))(writer, xdrValue)
                }

                yield* writer.write(Xdr.opaque(), new Uint8Array())
              })
          ])
        )

        assert.strictEqual(
          yield* (replyReader(unsupportedVerify)).read(Xdr.uint32),
          Status.ATTRNOTSUPP
        )
      }).pipe(Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(10), maxEntries: 3 } }))))
  })
})

describe("OpenRead over TCP", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should report read-only access and non-atomic name resolution for OPEN when OPEN names a path on a read-only export", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        yield* caller.writeFile("/other", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* wireClient(caller)

        const client = yield* startSession(handler, "open-contract")

        const writeAccess = yield* call([
          sequence(client.session, 1),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          openByName(client.client, "file", 2)
        ])

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(writeAccess))).read(Xdr.uint32),
          Status.ROFS
        )

        // Deny modes are share reservations, not an error on a read-only export; only undefined
        // values are rejected (RFC 8881 Section 18.16.3).
        const denyRead = yield* call([
          sequence(client.session, 2),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          openByName(client.client, "file", 1, 1)
        ])

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(denyRead))).read(Xdr.uint32),
          Status.OK
        )

        const undefinedDeny = yield* call([
          sequence(client.session, 3),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          openByName(client.client, "file", 1, 4)
        ])

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(undefinedDeny))).read(Xdr.uint32),
          Status.INVAL
        )

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(client.session, 4),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(client.client, "other"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        assert.isFalse(opened.atomic)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should require a first SEQUENCE and keep another client from using an open stateid when SEQUENCE is missing or an open stateid crosses clients", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* wireClient(caller)

        assert.strictEqual(
          (yield* statuses(
            yield* handler.send(yield* call([(writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)]))
          )).status,
          Status.OP_NOT_IN_SESSION
        )

        // Section 18.46.3: the first operation is judged on its own; a SEQUENCE later in the
        // compound is only reached when the operations before it succeed.
        const misplaced = yield* call([
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          sequence(new Uint8Array(16), 1)
        ])

        assert.deepStrictEqual((yield* statuses(yield* handler.send(misplaced))).operations, [[
          Operation.PUTROOTFH,
          Status.OP_NOT_IN_SESSION
        ]])
        const a = yield* startSession(handler, "a")

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(a.session, 1, true),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(a.client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        const b = yield* startSession(handler, "b")

        const stolenRead = yield* call([sequence(b.session, 1), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.PUTFH)
            yield* writer.write(Xdr.opaque(), opened.filehandle)
          }), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.READ)
            yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
            yield* writer.write(Xdr.uint64, 0n)
            yield* writer.write(Xdr.uint32, 2)
          })])

        assert.strictEqual(
          yield* (replyReader(yield* handler.send(stolenRead))).read(Xdr.uint32),
          Status.BAD_STATEID
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should report EOF on an exact-boundary read and let the owning session close when READ reaches the exact file boundary before CLOSE", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* wireClient(caller)

        const client = yield* startSession(handler, "reader")

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(client.session, 1, true),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(client.client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        const read = replyReader(
          yield* handler.send(
            yield* call([sequence(client.session, 2), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.READ)
                yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
                yield* writer.write(Xdr.uint64, 0n)
                yield* writer.write(Xdr.uint32, 2)
              })])
          )
        )

        assert.strictEqual(yield* read.read(Xdr.uint32), Status.OK)
        yield* read.read(Xdr.string())
        yield* read.read(Xdr.uint32)
        yield* read.read(Xdr.uint32)
        yield* read.read(Xdr.uint32)
        yield* read.read(Xdr.fixedOpaque(16))

        for (let field = 0; field < 5; field++) yield* read.read(Xdr.uint32)
        yield* read.read(Xdr.uint32)
        yield* read.read(Xdr.uint32)
        assert.strictEqual(yield* read.read(Xdr.uint32), Operation.READ)
        assert.strictEqual(yield* read.read(Xdr.uint32), Status.OK)
        assert.isTrue(yield* read.read(Xdr.boolean))
        assert.deepStrictEqual(yield* read.read(Xdr.opaque()), new Uint8Array([1, 2]))

        const close = replyReader(
          yield* handler.send(
            yield* call([sequence(client.session, 3), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.CLOSE)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
              })])
          )
        )

        assert.strictEqual(yield* close.read(Xdr.uint32), Status.OK)
        yield* close.read(Xdr.string())
        yield* close.read(Xdr.uint32)
        yield* close.read(Xdr.uint32)
        yield* close.read(Xdr.uint32)
        yield* close.read(Xdr.fixedOpaque(16))

        for (let field = 0; field < 5; field++) yield* close.read(Xdr.uint32)
        yield* close.read(Xdr.uint32)
        yield* close.read(Xdr.uint32)
        assert.strictEqual(yield* close.read(Xdr.uint32), Operation.CLOSE)
        assert.strictEqual(yield* close.read(Xdr.uint32), Status.OK)
        const closedStateid = yield* close.read(Xdr.fixedOpaque(16))
        assert.strictEqual(new DataView(closedStateid.buffer, closedStateid.byteOffset, 4).getUint32(0), 2)
        assert.deepStrictEqual(closedStateid.subarray(4), opened.stateid.subarray(4))
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should bound READLINK results before advancing beyond the negotiated reply budget when READLINK would exceed the negotiated reply budget", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.symlink("12345678901234567", "/link")

        const constrained = {
          ...limits,
          maxStringBytes: ByteSize.bytes(16)
        }

        const { handler, session } = yield* openWireSession(caller, "link-bound", { limits: constrained })

        const response = yield* handler.send(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                yield* writer.write(Xdr.string(), "link")
              }),
            (writer) => writer.write(Xdr.uint32, Operation.READLINK)
          ], "link")
        )

        assert.strictEqual(
          yield* (replyReader(response)).read(Xdr.uint32),
          Status.SERVERFAULT
        )
        assert.strictEqual(
          yield* (replyReader(yield* handler.send(yield* call([sequence(session, 2)], "next")))).read(Xdr.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should list entries without encoding filehandles when no attributes are requested", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/a", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        yield* caller.writeFile("/b", new Uint8Array([2]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, session } = yield* openWireSession(caller, "attribute-free-readdir")

        const response = yield* handler.send(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.READDIR)
                yield* writer.write(Xdr.uint64, 0n)
                yield* writer.write(Xdr.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(Xdr.uint32, 4_096)
                yield* writer.write(Xdr.uint32, 4_096)
                yield* writer.write(Xdr.uint32, 0)
              })
          ])
        )

        assert.strictEqual(yield* (replyReader(response)).read(Xdr.uint32), Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should continue READDIR from its cookie and reject a stale verifier when READDIR resumes with a cookie or stale verifier", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxReaddirEntries: 1
        }

        const { handler, session } = yield* openWireSession(caller, "pagination", { limits: constrained })

        const readPage = Effect.fnUntraced(function*(sequenceId: number, cookie: bigint, verifier: Uint8Array) {
          return yield* handler.send(
            yield* call([
              sequence(session, sequenceId),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.READDIR)
                  yield* writer.write(Xdr.uint64, cookie)
                  yield* writer.write(Xdr.fixedOpaque(verifier.length), verifier)
                  yield* writer.write(Xdr.uint32, 4_096)
                  yield* writer.write(Xdr.uint32, 4_096)
                  yield* writer.write(Xdr.uint32, 1)
                  yield* writer.write(Xdr.uint32, 1 << 1)
                })
            ])
          )
        })

        const parsePage = Effect.fnUntraced(function*(response: Uint8Array) {
          const reader = replyReader(response)
          assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
          yield* reader.read(Xdr.string())
          yield* reader.read(Xdr.uint32)
          yield* reader.read(Xdr.uint32)
          yield* reader.read(Xdr.uint32)
          yield* reader.read(Xdr.fixedOpaque(16))

          for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
          yield* reader.read(Xdr.uint32)
          yield* reader.read(Xdr.uint32)
          assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.READDIR)
          assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
          const pageVerifier = yield* reader.read(Xdr.fixedOpaque(8))
          assert.isTrue(yield* reader.read(Xdr.boolean))
          const nextCookie = yield* reader.read(Xdr.uint64)
          const name = yield* reader.read(Xdr.string())
          yield* reader.read(Xdr.array(Xdr.uint32))
          yield* reader.read(Xdr.opaque())
          assert.isFalse(yield* reader.read(Xdr.boolean))
          const eof = yield* reader.read(Xdr.boolean)
          yield* reader.finish

          return {
            pageVerifier,
            nextCookie,
            name,
            eof
          }
        })

        const first = yield* parsePage(yield* readPage(1, 0n, new Uint8Array(8)))
        assert.deepStrictEqual({
          name: first.name,
          eof: first.eof
        }, {
          name: "a",
          eof: false
        })
        const second = yield* parsePage(yield* readPage(2, first.nextCookie, first.pageVerifier))
        assert.deepStrictEqual({
          name: second.name,
          eof: second.eof
        }, {
          name: "b",
          eof: false
        })
        const third = yield* parsePage(yield* readPage(3, second.nextCookie, second.pageVerifier))
        assert.deepStrictEqual({
          name: third.name,
          eof: third.eof
        }, {
          name: "c",
          eof: true
        })
        assert.strictEqual(
          yield* (replyReader(yield* readPage(4, 1n, third.pageVerifier))).read(
            Xdr.uint32
          ),
          Status.BAD_COOKIE
        )
        yield* caller.writeFile("/d", new Uint8Array([4]), {
          access: "write",
          create: "exclusive"
        })
        const stale = yield* readPage(5, third.nextCookie, third.pageVerifier)
        assert.strictEqual(yield* (replyReader(stale)).read(Xdr.uint32), Status.NOT_SAME)
      }).pipe(Effect.provide(Testing.layer({
        fixture: {
          entries: ["a", "b", "c"].map((path, index) => ({
            kind: "file" as const,
            path: `/${path}`,
            bytes: new Uint8Array([index])
          }))
        }
      }))))

    it.effect("should page READDIR within the record ceiling when READDIR entries approach the RPC record ceiling", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const constrained = {
          ...limits,
          maxRecordBytes: ByteSize.bytes(2_048),
          maxReaddirEntries: 100
        }

        const { handler, session } = yield* openWireSession(caller, "record-page", {
          limits: constrained
        })

        const readPage = Effect.fnUntraced(function*(sequenceId: number, cookie: bigint, verifier: Uint8Array) {
          return yield* handler.send(
            yield* call([
              sequence(session, sequenceId),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.READDIR)
                  yield* writer.write(Xdr.uint64, cookie)
                  yield* writer.write(Xdr.fixedOpaque(verifier.length), verifier)
                  yield* writer.write(Xdr.uint32, 0)
                  yield* writer.write(Xdr.uint32, 4_096)
                  yield* writer.write(Xdr.uint32, 0)
                })
            ])
          )
        })

        const parsePage = Effect.fnUntraced(function*(response: Uint8Array) {
          assert.isAtMost(response.length + 24, 2_048)
          const reader = replyReader(response)
          assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
          yield* reader.read(Xdr.string())
          assert.strictEqual(yield* reader.read(Xdr.uint32), 3)
          assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SEQUENCE)
          assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
          yield* reader.read(Xdr.fixedOpaque(16))

          for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
          assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.PUTROOTFH)
          assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
          assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.READDIR)
          assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
          const verifier = yield* reader.read(Xdr.fixedOpaque(8))
          const names: Array<string> = []
          let cookie = 0n

          while (yield* reader.read(Xdr.boolean)) {
            cookie = yield* reader.read(Xdr.uint64)
            names.push(yield* reader.read(Xdr.string()))
            yield* reader.read(Xdr.array(Xdr.uint32))
            yield* reader.read(Xdr.opaque())
          }

          const eof = yield* reader.read(Xdr.boolean)
          yield* reader.finish

          return {
            verifier,
            cookie,
            names,
            eof
          }
        })

        const first = yield* parsePage(yield* readPage(1, 0n, new Uint8Array(8)))
        assert.isAbove(first.names.length, 0)
        assert.isBelow(first.names.length, 100)
        assert.isFalse(first.eof)
        const second = yield* parsePage(yield* readPage(2, first.cookie, first.verifier))
        assert.isAbove(second.names.length, 0)
        assert.strictEqual(second.names[0], `entry-${String(first.names.length).padStart(4, "0")}`)
      }).pipe(Effect.provide(Testing.layer({
        fixture: {
          entries: Array.from({
            length: 100
          }, (_, index) => ({
            kind: "file" as const,
            path: `/entry-${String(index).padStart(4, "0")}`,
            bytes: new Uint8Array([index])
          }))
        }
      }))))

    it.effect("should use maxcount alone when READDIR dircount is zero", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, session } = yield* openWireSession(caller, "zero-dircount")

        const response = yield* handler.send(
          yield* call([sequence(session, 1), (writer) =>
            writer.write(Xdr.uint32, Operation.PUTROOTFH), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.READDIR)
              yield* writer.write(Xdr.uint64, 0n)
              yield* writer.write(Xdr.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 4_096)
              yield* writer.write(Xdr.uint32, 1)
              yield* writer.write(Xdr.uint32, 1 << 1)
            })])
        )

        assert.strictEqual(yield* (replyReader(response)).read(Xdr.uint32), Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject OPEN without read access without consuming open capacity when OPEN omits read access", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxOpens: 1
        }

        const { handler, client, session } = yield* openWireSession(caller, "invalid-open-access", {
          limits: constrained
        })

        const invalid = yield* handler.send(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.OPEN)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint64, client)
                yield* writer.write(Xdr.string(), "owner")
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.string(), "file")
              })
          ])
        )

        assert.strictEqual(yield* (replyReader(invalid)).read(Xdr.uint32), Status.INVAL)
        yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 2),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should coalesce repeated OPEN state and validate stateid sequences when one owner repeats OPEN and uses stateid sequences", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxOpens: 1
        }

        const { handler, client, session } = yield* openWireSession(caller, "repeated-open", { limits: constrained })

        const first = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        assert.strictEqual(new DataView(first.stateid.buffer, first.stateid.byteOffset, 4).getUint32(0), 1)

        const second = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 2),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        assert.strictEqual(new DataView(second.stateid.buffer, second.stateid.byteOffset, 4).getUint32(0), 2)
        assert.deepStrictEqual(second.stateid.subarray(4), first.stateid.subarray(4))

        const readStatus = Effect.fnUntraced(function*(requestSequence: number, stateid: Uint8Array) {
          return yield* handler.send(
            yield* call([sequence(session, requestSequence), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), second.filehandle)
              }), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.READ)
                yield* writer.write(Xdr.fixedOpaque(stateid.length), stateid)
                yield* writer.write(Xdr.uint64, 0n)
                yield* writer.write(Xdr.uint32, 1)
              })])
          ).pipe(Effect.flatMap((response) => replyReader(response).read(Xdr.uint32)))
        })

        assert.strictEqual(yield* readStatus(3, stateidWithSequence(second.stateid, 0)), Status.OK)
        assert.strictEqual(yield* readStatus(4, first.stateid), Status.OLD_STATEID)
        assert.strictEqual(yield* readStatus(5, stateidWithSequence(second.stateid, 3)), Status.BAD_STATEID)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should check an open-owner's own deny mode on a repeated OPEN when an open owner repeats OPEN with its own deny mode", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, client, session } = yield* openWireSession(caller, "self-deny")

        const first = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(client, "file", 1, 1),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        assert.strictEqual(
          (yield* statuses(
            yield* handler.send(
              yield* call([
                sequence(session, 2),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                openReadOnly(client, "file")
              ])
            )
          )).status,
          Status.SHARE_DENIED
        )
        assert.strictEqual(
          (yield* statuses(
            yield* handler.send(
              yield* call([sequence(session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), first.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.OPEN_DOWNGRADE)
                  yield* writer.write(Xdr.fixedOpaque(first.stateid.length), first.stateid)
                  yield* writer.write(Xdr.uint32, 0)
                  yield* writer.write(Xdr.uint32, 1)
                  yield* writer.write(Xdr.uint32, 0)
                })])
            )
          )).status,
          Status.OK
        )
        assert.strictEqual(
          (yield* statuses(
            yield* handler.send(
              yield* call([
                sequence(session, 4),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                openReadOnly(client, "file")
              ])
            )
          )).status,
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should support anonymous and current-stateid READ forms when READ uses anonymous or current-stateid forms", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, client, session } = yield* openWireSession(caller, "special-stateids")

        const anonymous = new Uint8Array(16)
        const current = stateidWithSequence(anonymous, 1)
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([
                sequence(session, 1),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                    yield* writer.write(Xdr.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.READ)
                    yield* writer.write(Xdr.fixedOpaque(anonymous.length), anonymous)
                    yield* writer.write(Xdr.uint64, 0n)
                    yield* writer.write(Xdr.uint32, 1)
                  })
              ])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([
                sequence(session, 2),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                openReadOnly(client, "file"),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.READ)
                    yield* writer.write(Xdr.fixedOpaque(current.length), current)
                    yield* writer.write(Xdr.uint64, 0n)
                    yield* writer.write(Xdr.uint32, 1)
                  })
              ])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([
                sequence(session, 3),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                    yield* writer.write(Xdr.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.READ)
                    yield* writer.write(Xdr.fixedOpaque(current.length), current)
                    yield* writer.write(Xdr.uint64, 0n)
                    yield* writer.write(Xdr.uint32, 1)
                  })
              ])
            )
          )).read(Xdr.uint32),
          Status.BAD_STATEID
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([
                sequence(session, 4),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                    yield* writer.write(Xdr.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.READ)
                    yield* writer.write(Xdr.fixedOpaque(anonymous.length), anonymous)
                    yield* writer.write(Xdr.uint64, 0n)
                    yield* writer.write(Xdr.uint32, ByteSize.toNumberUnsafe(limits.maxReadBytes) + 1)
                  })
              ])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
        assert.strictEqual(
          yield* (replyReader(
            yield* handler.send(
              yield* call([
                sequence(session, 5),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                    yield* writer.write(Xdr.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.READ)
                    yield* writer.write(
                      Xdr.fixedOpaque(new Uint8Array(16).fill(0xff).length),
                      new Uint8Array(16).fill(0xff)
                    )
                    yield* writer.write(Xdr.uint64, 0n)
                    yield* writer.write(Xdr.uint32, 1)
                  })
              ])
            )
          )).read(Xdr.uint32),
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should read successive offsets and report EOF only at the file boundary when READ advances through successive offsets", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6])
        yield* caller.writeFile("/file", bytes, {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxReadBytes: ByteSize.bytes(3)
        }

        const handler = yield* wireClient(caller, { limits: constrained })

        const client = yield* startSession(handler, "offset-reader")

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(client.session, 1, true),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openReadOnly(client.client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        const read = Effect.fnUntraced(function*(sequenceId: number, offset: bigint, count: number) {
          return yield* handler.send(
            yield* call([sequence(client.session, sequenceId), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.READ)
                yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
                yield* writer.write(Xdr.uint64, offset)
                yield* writer.write(Xdr.uint32, count)
              })])
          )
        })

        const parse = Effect.fnUntraced(function*(response: Uint8Array) {
          const reader = replyReader(response)
          const result = yield* statuses(response)

          if (result.status !== Status.OK) {
            return {
              status: result.status
            } as const
          }

          yield* reader.read(Xdr.uint32)
          yield* reader.read(Xdr.string())
          yield* reader.read(Xdr.uint32)
          yield* reader.read(Xdr.uint32)
          yield* reader.read(Xdr.uint32)
          yield* reader.read(Xdr.fixedOpaque(16))

          for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
          yield* reader.read(Xdr.uint32)
          yield* reader.read(Xdr.uint32)
          yield* reader.read(Xdr.uint32)
          yield* reader.read(Xdr.uint32)

          return {
            status: Status.OK,
            eof: yield* reader.read(Xdr.boolean),
            bytes: yield* reader.read(Xdr.opaque())
          } as const
        })

        assert.deepStrictEqual(yield* parse(yield* read(2, 0n, 3)), {
          status: Status.OK,
          eof: false,
          bytes: new Uint8Array([0, 1, 2])
        })
        assert.deepStrictEqual(yield* parse(yield* read(3, 3n, 3)), {
          status: Status.OK,
          eof: false,
          bytes: new Uint8Array([3, 4, 5])
        })
        assert.deepStrictEqual(yield* parse(yield* read(4, 6n, 3)), {
          status: Status.OK,
          eof: true,
          bytes: new Uint8Array([6])
        })
        assert.deepStrictEqual(yield* parse(yield* read(5, 20n, 3)), {
          status: Status.OK,
          eof: true,
          bytes: new Uint8Array()
        })
        assert.deepStrictEqual(yield* parse(yield* read(6, 0n, 4)), {
          status: Status.OK,
          eof: false,
          bytes: new Uint8Array([0, 1, 2])
        })
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should coordinate write opens across clients and release a denial on downgrade when clients contend for write opens and later downgrade", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* wireClient(caller, { writable: true })

        const a = yield* startSession(handler, "write-share-a")
        const b = yield* startSession(handler, "write-share-b")

        const held = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(a.session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(a.client, "file", 1, 2),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        const bWrite = Effect.fnUntraced(function*(slotSequence: number) {
          return yield* handler.send(
            yield* call([
              sequence(b.session, slotSequence),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(b.client, "file", 2)
            ])
          ).pipe(Effect.flatMap((reply) =>
            Effect.gen(function*() {
              return (yield* statuses(reply)).status
            })
          ))
        })

        assert.strictEqual(yield* bWrite(1), Status.SHARE_DENIED)
        assert.strictEqual(
          (yield* statuses(
            yield* handler.send(
              yield* call([sequence(a.session, 2), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), held.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.OPEN_DOWNGRADE)
                  yield* writer.write(Xdr.fixedOpaque(held.stateid.length), held.stateid)
                  yield* writer.write(Xdr.uint32, 0)
                  yield* writer.write(Xdr.uint32, 1)
                  yield* writer.write(Xdr.uint32, 0)
                })])
            )
          )).status,
          Status.OK
        )
        assert.strictEqual(
          (yield* statuses(
            yield* handler.send(
              yield* call([
                sequence(b.session, 2),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                openByName(b.client, "file", 2, 1)
              ])
            )
          )).status,
          Status.SHARE_DENIED
        )
        assert.strictEqual(yield* bWrite(3), Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject reads through a write-only stateid when READ uses a write-only stateid", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* wireClient(caller, { writable: true })

        const client = yield* startSession(handler, "write-only")

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(client.session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(client.client, "file", 2),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        const reply = yield* handler.send(
          yield* call([sequence(client.session, 2), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.PUTFH)
              yield* writer.write(Xdr.opaque(), opened.filehandle)
            }), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.READ)
              yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
              yield* writer.write(Xdr.uint64, 0n)
              yield* writer.write(Xdr.uint32, 1)
            })])
        )

        assert.strictEqual((yield* statuses(reply)).status, Status.OPENMODE)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should upgrade one open-owner from read to read-write and keep one open record when one owner upgrades a read OPEN to read-write", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const constrained = {
          ...limits,
          maxOpens: 1
        }

        const handler = yield* wireClient(caller, { limits: constrained, writable: true })

        const client = yield* startSession(handler, "upgrade")

        const firstRequest = yield* call([
          sequence(client.session, 1, true),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          openByName(client.client, "file", 1),
          (writer) => writer.write(Xdr.uint32, Operation.GETFH)
        ])

        const firstReply = yield* handler.send(firstRequest)
        const first = yield* parseOpen(firstReply)
        assert.deepStrictEqual(yield* handler.send(firstRequest), firstReply)

        const upgraded = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(client.session, 2),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(client.client, "file", 2),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        assert.deepStrictEqual(upgraded.stateid.subarray(4), first.stateid.subarray(4))
        assert.strictEqual(new DataView(upgraded.stateid.buffer, upgraded.stateid.byteOffset, 4).getUint32(0), 2)
        assert.strictEqual(
          (yield* statuses(
            yield* handler.send(
              yield* call([sequence(client.session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), upgraded.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.READ)
                  yield* writer.write(Xdr.fixedOpaque(upgraded.stateid.length), upgraded.stateid)
                  yield* writer.write(Xdr.uint64, 0n)
                  yield* writer.write(Xdr.uint32, 1)
                })])
            )
          )).status,
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should keep earlier read access when upgrading after read permission is removed", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller

        yield* admin.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive",
          mode: 0o600
        })
        yield* admin.chown("/file", {
          uid: 1000,
          gid: 1000
        })
        yield* admin.chmod("/", 0o111)

        const owner = yield* Testing.callerAs({
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        })

        const handler = yield* wireClient(admin, { writable: true, mappedCaller: owner })

        const client = yield* startSession(handler, "permission-upgrade")

        const first = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(client.session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(client.client, "file", 1),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        yield* admin.chmod("/file", 0o200)

        const upgraded = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(client.session, 2),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(client.client, "file", 2),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        assert.deepStrictEqual(upgraded.stateid.subarray(4), first.stateid.subarray(4))
        yield* admin.chmod("/file", 0o600)
        assert.strictEqual(
          (yield* statuses(
            yield* handler.send(
              yield* call([sequence(client.session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), upgraded.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.READ)
                  yield* writer.write(Xdr.fixedOpaque(upgraded.stateid.length), upgraded.stateid)
                  yield* writer.write(Xdr.uint64, 0n)
                  yield* writer.write(Xdr.uint32, 1)
                })])
            )
          )).status,
          Status.OK
        )
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should serve metadata, access, directory entries, and symbolic-link targets when GETATTR, ACCESS, READDIR, and READLINK query one export", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        yield* caller.symlink("file", "/link")

        const handler = yield* wireClient(caller, { storageGeneration: new Uint8Array(16).fill(7) })

        const client = yield* startSession(handler, "browser")
        const root = yield* caller.root
        const directoryObservation = yield* caller.readDirectory(root)

        const browse = yield* call([
          sequence(client.session, 1),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.GETATTR)
              yield* writer.write(Xdr.uint32, 1)
              yield* writer.write(Xdr.uint32, 1 << 0 | 1 << 1 | 1 << 2)
            }),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.ACCESS)
              yield* writer.write(Xdr.uint32, 3)
            }),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.READDIR)
              yield* writer.write(Xdr.uint64, 0n)
              yield* writer.write(Xdr.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
              yield* writer.write(Xdr.uint32, 4_096)
              yield* writer.write(Xdr.uint32, 4_096)
              yield* writer.write(Xdr.uint32, 1)
              yield* writer.write(Xdr.uint32, 1 << 1)
            })
        ])

        const browseResponse = replyReader(yield* handler.send(browse))
        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), Status.OK)
        yield* browseResponse.read(Xdr.string())
        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), 5)
        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), Operation.SEQUENCE)
        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), Status.OK)
        yield* browseResponse.read(Xdr.fixedOpaque(16))

        for (let field = 0; field < 5; field++) {
          yield* browseResponse.read(Xdr.uint32)
        }

        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), Operation.PUTROOTFH)
        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), Status.OK)
        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), Operation.GETATTR)
        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), Status.OK)
        assert.deepStrictEqual(yield* browseResponse.read(Xdr.array(Xdr.uint32)), [7])
        const attributeValues = replyReader(yield* browseResponse.read(Xdr.opaque()))
        // Every export reports its volume's maxfilesize (27); an unbounded volume adds no other capacity attribute.
        assert.deepStrictEqual(yield* attributeValues.read(Xdr.array(Xdr.uint32)), [
          3961196543,
          12099646,
          6144
        ])
        assert.strictEqual(yield* attributeValues.read(Xdr.uint32), 2)
        assert.strictEqual(yield* attributeValues.read(Xdr.uint32), 0x3)
        yield* attributeValues.finish
        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), Operation.ACCESS)
        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), Status.OK)
        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), 3)
        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), 3)
        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), Operation.READDIR)
        assert.strictEqual(yield* browseResponse.read(Xdr.uint32), Status.OK)
        const expectedVerifier = new Uint8Array(8).fill(7)

        const expectedVerifierView = new DataView(
          expectedVerifier.buffer,
          expectedVerifier.byteOffset,
          expectedVerifier.byteLength
        )

        expectedVerifierView.setBigUint64(
          0,
          expectedVerifierView.getBigUint64(0) ^ BigInt.asUintN(64, directoryObservation.revision)
        )
        assert.deepStrictEqual(yield* browseResponse.read(Xdr.fixedOpaque(8)), expectedVerifier)

        const entries: Array<{
          readonly cookie: bigint
          readonly name: string
          readonly type: number
        }> = []

        while (yield* browseResponse.read(Xdr.boolean)) {
          const cookie = yield* browseResponse.read(Xdr.uint64)
          const name = yield* browseResponse.read(Xdr.string())
          assert.deepStrictEqual(yield* browseResponse.read(Xdr.array(Xdr.uint32)), [2])
          const values = replyReader(yield* browseResponse.read(Xdr.opaque()))
          const type = yield* values.read(Xdr.uint32)
          yield* values.finish
          entries.push({
            cookie,
            name,
            type
          })
        }

        assert.deepStrictEqual(entries, [{
          cookie: 3n,
          name: "file",
          type: 1
        }, {
          cookie: 4n,
          name: "link",
          type: 5
        }])
        assert.isTrue(yield* browseResponse.read(Xdr.boolean))
        yield* browseResponse.finish

        const link = replyReader(
          yield* handler.send(
            yield* call([
              sequence(client.session, 2),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                  yield* writer.write(Xdr.string(), "link")
                }),
              (writer) => writer.write(Xdr.uint32, Operation.READLINK)
            ])
          )
        )

        assert.strictEqual(yield* link.read(Xdr.uint32), Status.OK)
        yield* link.read(Xdr.string())
        yield* link.read(Xdr.uint32)
        yield* link.read(Xdr.uint32)
        yield* link.read(Xdr.uint32)
        yield* link.read(Xdr.fixedOpaque(16))

        for (let field = 0; field < 5; field++) {
          yield* link.read(Xdr.uint32)
        }

        yield* link.read(Xdr.uint32)
        yield* link.read(Xdr.uint32)
        yield* link.read(Xdr.uint32)
        yield* link.read(Xdr.uint32)
        assert.strictEqual(yield* link.read(Xdr.uint32), Operation.READLINK)
        assert.strictEqual(yield* link.read(Xdr.uint32), Status.OK)
        assert.strictEqual(yield* link.read(Xdr.string()), "file")
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("ReadOnlyOperations over TCP", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should answer must-not-implement and optional operations with NOTSUPP when a must-not-implement or optional operation is sent", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const handler = yield* wireClient(caller)

        const setclientid = yield* run(
          handler,
          call([(writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.SETCLIENTID)
              yield* writer.write(Xdr.uint32, 1)
            })])
        )

        assert.strictEqual(setclientid.status, Status.NOTSUPP)
        assert.deepStrictEqual(setclientid.operations, [{ code: Operation.SETCLIENTID, status: Status.NOTSUPP }])

        const optionalFirst = yield* run(
          handler,
          call([(writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.OPENATTR)
              yield* writer.write(Xdr.boolean, false)
            })])
        )

        assert.strictEqual(optionalFirst.status, Status.OP_NOT_IN_SESSION)

        const { session } = yield* startSession(handler, "notsupp")

        for (
          const [index, code] of [
            Operation.RENEW,
            Operation.OPEN_CONFIRM,
            Operation.RELEASE_LOCKOWNER,
            Operation.OPENATTR,
            Operation.LAYOUTGET,
            Operation.DELEGRETURN
          ]
            .entries()
        ) {
          const reply = yield* run(
            handler,
            call([
              sequence(session, index + 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, code)
                  yield* writer.write(Xdr.uint32, 0xdead_beef)
                })
            ])
          )

          assert.strictEqual(reply.status, Status.NOTSUPP, `operation ${code}`)
          assert.strictEqual(reply.operations.length, 3)
          assert.strictEqual(reply.operations[1]!.status, Status.OK)
          assert.deepStrictEqual(reply.operations[2], { code, status: Status.NOTSUPP })
        }

        const unknown = yield* run(
          handler,
          call([sequence(session, 7), (writer) => writer.write(Xdr.uint32, 99_999)])
        )

        assert.deepStrictEqual(unknown.operations[1], { code: Operation.ILLEGAL, status: Status.OP_ILLEGAL })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should answer SECINFO_NO_NAME for the current object and its parent when SECINFO_NO_NAME targets the current object or parent", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/dir")
        const { handler, session } = yield* openWireSession(caller, "secinfo-no-name")

        const current = yield* run(
          handler,
          call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.SECINFO_NO_NAME)
                yield* writer.write(Xdr.uint32, 0)
              }),
            (writer) => writer.write(Xdr.uint32, Operation.GETFH)
          ])
        )

        assert.strictEqual(current.status, Status.NOFILEHANDLE)
        assert.deepStrictEqual(current.operations[2]!.value, [1, 0])

        const rootParent = yield* run(
          handler,
          call([
            sequence(session, 2),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.SECINFO_NO_NAME)
                yield* writer.write(Xdr.uint32, 1)
              })
          ])
        )

        assert.strictEqual(rootParent.status, Status.NOENT)

        const parent = yield* run(
          handler,
          call([
            sequence(session, 3),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                yield* writer.write(Xdr.string(), "dir")
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.SECINFO_NO_NAME)
                yield* writer.write(Xdr.uint32, 1)
              })
          ])
        )

        assert.strictEqual(parent.status, Status.OK)

        const lookupp = yield* run(
          handler,
          call([
            sequence(session, 4),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

            (writer) => writer.write(Xdr.uint32, Operation.LOOKUPP)
          ])
        )

        assert.strictEqual(lookupp.status, Status.NOENT)

        const badStyle = yield* run(
          handler,
          call([
            sequence(session, 5),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.SECINFO_NO_NAME)
                yield* writer.write(Xdr.uint32, 7)
              })
          ])
        )

        assert.strictEqual(badStyle.status, Status.BADXDR)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should check filehandles, object kinds, and name before rejecting mutations as read-only when mutation operands are invalid on a read-only export", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        yield* caller.symlink("file", "/link")
        const { handler, session } = yield* openWireSession(caller, "precedence")
        let sequenceId = 0

        const attempt = (
          ...operations: ReadonlyArray<(writer: RequestWriter) => Effect.Effect<void>>
        ) =>
          run(handler, call([sequence(session, ++sequenceId), ...operations])).pipe(Effect.map((reply) => reply.status))

        const root = (writer: RequestWriter) => writer.write(Xdr.uint32, Operation.PUTROOTFH)

        const lookup = (name: string) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.LOOKUP)
            yield* writer.write(Xdr.string(), name)
          })

        const remove = (name: string) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.REMOVE)
            yield* writer.write(Xdr.string(), name)
          })

        const rename = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.RENAME)
          yield* writer.write(Xdr.string(), "file")
          yield* writer.write(Xdr.string(), "moved")
        })

        const link = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.LINK)
          yield* writer.write(Xdr.string(), "linked")
        })

        const savefh = (writer: RequestWriter) => writer.write(Xdr.uint32, Operation.SAVEFH)

        assert.strictEqual(yield* attempt(remove("file")), Status.NOFILEHANDLE)
        assert.strictEqual(yield* attempt(root, rename), Status.NOFILEHANDLE, "RENAME needs a saved filehandle")
        assert.strictEqual(yield* attempt(root, link), Status.NOFILEHANDLE, "LINK needs a saved object")
        assert.strictEqual(yield* attempt(root, lookup("file"), remove("x")), Status.NOTDIR)
        assert.strictEqual(yield* attempt(root, lookup("link"), remove("x")), Status.NOTDIR, "REMOVE lists no SYMLINK")
        assert.strictEqual(
          yield* attempt(root, lookup("file"), savefh, root, rename),
          Status.NOTDIR,
          "saved source dir"
        )
        assert.strictEqual(
          yield* attempt(root, lookup("link"), savefh, root, rename),
          Status.NOTDIR,
          "RENAME lists no SYMLINK"
        )
        assert.strictEqual(yield* attempt(root, savefh, lookup("link"), link), Status.SYMLINK, "LINK lists SYMLINK")
        assert.strictEqual(yield* attempt(root, remove("..")), Status.BADNAME)
        assert.strictEqual(yield* attempt(root, remove("")), Status.INVAL)
        assert.strictEqual(yield* attempt(root, remove("x".repeat(300))), Status.NAMETOOLONG)
        assert.strictEqual(yield* attempt(root, savefh, rename), Status.ROFS)
        assert.strictEqual(yield* attempt(root, lookup("file"), savefh, root, link), Status.ROFS)
        assert.strictEqual(yield* attempt(root, remove("file")), Status.ROFS)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should name the object type when OPEN, READ, COMMIT, and locks meet a non-regular object", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2, 3, 4]), { access: "write", create: "exclusive" })
        yield* caller.mkdir("/dir")
        yield* caller.symlink("file", "/link")
        const { handler, client, session } = yield* openWireSession(caller, "object-types")
        let sequenceId = 0

        const attempt = (
          ...operations: ReadonlyArray<(writer: RequestWriter) => Effect.Effect<void>>
        ) => run(handler, call([sequence(session, ++sequenceId), ...operations]))

        const status = (
          ...operations: ReadonlyArray<(writer: RequestWriter) => Effect.Effect<void>>
        ) => attempt(...operations).pipe(Effect.map((reply) => reply.status))

        const root = (writer: RequestWriter) => writer.write(Xdr.uint32, Operation.PUTROOTFH)

        const lookup = (name: string) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.LOOKUP)
            yield* writer.write(Xdr.string(), name)
          })

        const anonymous = new Uint8Array(16)

        const read = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.READ)
          yield* writer.write(Xdr.fixedOpaque(anonymous.length), anonymous)
          yield* writer.write(Xdr.uint64, 0n)
          yield* writer.write(Xdr.uint32, 4)
        })

        const commit = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.COMMIT)
          yield* writer.write(Xdr.uint64, 0n)
          yield* writer.write(Xdr.uint32, 0)
        })

        const lock = (lockType: number) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.LOCK)
            yield* writer.write(Xdr.uint32, lockType)
            yield* writer.write(Xdr.boolean, false)
            yield* writer.write(Xdr.uint64, 0n)
            yield* writer.write(Xdr.uint64, 1n)
            yield* writer.write(Xdr.boolean, true)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(
              Xdr.fixedOpaque(
                anonymous.length
              ),
              anonymous
            )
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint64, client)
            yield* writer.write(Xdr.string(), "lock-owner")
          })

        const lockt = (lockType: number) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.LOCKT)
            yield* writer.write(Xdr.uint32, lockType)
            yield* writer.write(Xdr.uint64, 0n)
            yield* writer.write(Xdr.uint64, 1n)
            yield* writer.write(Xdr.uint64, client)
            yield* writer.write(Xdr.string(), "lock-owner")
          })

        const locku = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.LOCKU)
          yield* writer.write(Xdr.uint32, 1)
          yield* writer.write(Xdr.uint32, 0)
          yield* writer.write(Xdr.fixedOpaque(anonymous.length), anonymous)
          yield* writer.write(Xdr.uint64, 0n)
          yield* writer.write(Xdr.uint64, 1n)
        })

        // Sections 18.16.4 and 18.22.3 name the type; COMMIT lists SYMLINK and WRONG_TYPE, not INVAL.
        assert.strictEqual(yield* status(root, openReadOnly(client, "link")), Status.SYMLINK)
        assert.strictEqual(yield* status(root, openReadOnly(client, "dir")), Status.ISDIR)
        assert.strictEqual(yield* status(root, lookup("link"), read), Status.SYMLINK)
        assert.strictEqual(yield* status(root, read), Status.ISDIR)
        assert.strictEqual(yield* status(root, lookup("link"), commit), Status.SYMLINK)

        // Locks check the filehandle and object type before the read-only answer.
        assert.strictEqual(yield* status(lock(1)), Status.NOFILEHANDLE)
        assert.strictEqual(yield* status(root, lock(1)), Status.ISDIR)
        assert.strictEqual(yield* status(root, lookup("link"), lockt(1)), Status.SYMLINK)
        assert.strictEqual(yield* status(root, lookup("file"), lock(2)), Status.ROFS, "WRITE_LT")
        assert.strictEqual(yield* status(root, lookup("file"), lock(1)), Status.BAD_STATEID, "READ_LT needs open state")
        assert.strictEqual(
          yield* status(root, lookup("file"), lockt(1)),
          Status.OK,
          "no lock conflicts with a read test"
        )
        assert.strictEqual(yield* status(root, lookup("file"), lockt(4)), Status.ROFS, "WRITEW_LT")
        assert.strictEqual(yield* status(root, lookup("file"), locku), Status.BAD_STATEID)
        assert.strictEqual(yield* status(locku), Status.NOFILEHANDLE)

        const badLockType = yield* attempt(root, lookup("file"), lock(5))
        assert.strictEqual(badLockType.status, Status.BADXDR)
        assert.deepStrictEqual(badLockType.operations[3], { code: Operation.LOCK, status: Status.BADXDR })

        const badUnlockType = yield* attempt(
          root,
          lookup("file"),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.LOCKU)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.fixedOpaque(anonymous.length), anonymous)
              yield* writer.write(Xdr.uint64, 0n)
              yield* writer.write(Xdr.uint64, 1n)
            })
        )

        assert.deepStrictEqual(badUnlockType.operations[3], { code: Operation.LOCKU, status: Status.BADXDR })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should keep anonymous READ, LOOKUP, READLINK, LOCKU, and OPEN4_CREATE inside their error lists when anonymous operations produce RFC-listed errors", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2]), { access: "write", create: "exclusive" })
        yield* caller.mkdir("/dir")
        yield* caller.symlink("file", "/link")
        const { handler, client, session } = yield* openWireSession(caller, "error-lists")
        let sequenceId = 0

        const attempt = (
          ...operations: ReadonlyArray<(writer: RequestWriter) => Effect.Effect<void>>
        ) => run(handler, call([sequence(session, ++sequenceId), ...operations]))

        const status = (
          ...operations: ReadonlyArray<(writer: RequestWriter) => Effect.Effect<void>>
        ) => attempt(...operations).pipe(Effect.map((reply) => reply.status))

        const root = (writer: RequestWriter) => writer.write(Xdr.uint32, Operation.PUTROOTFH)

        const lookup = (name: string) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.LOOKUP)
            yield* writer.write(Xdr.string(), name)
          })

        const readlink = (writer: RequestWriter) => writer.write(Xdr.uint32, Operation.READLINK)

        const anonymous = new Uint8Array(16)
        const bypass = new Uint8Array(16).fill(0xff)

        const read = (stateid: Uint8Array) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.READ)
            yield* writer.write(Xdr.fixedOpaque(stateid.length), stateid)
            yield* writer.write(Xdr.uint64, 0n)
            yield* writer.write(Xdr.uint32, 2)
          })

        const openAs = (owner: string, deny: number) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.OPEN)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 1)
            yield* writer.write(Xdr.uint32, deny)
            yield* writer.write(Xdr.uint64, client)
            yield* writer.write(Xdr.string(), owner)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.string(), "file")
          })

        const create = (name: string, claim = 0, access = 1) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.OPEN)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, access)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint64, client)
            yield* writer.write(Xdr.string(), "creator")
            yield* writer.write(Xdr.uint32, 1)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.array(Xdr.uint32), [])
            yield* writer.write(Xdr.opaque(), new Uint8Array())
            yield* writer.write(Xdr.uint32, claim)

            if (claim === 0) yield* writer.write(Xdr.string(), name)
          })

        // Section 9.1.2: the anonymous stateid respects a deny-read reservation; all ones bypasses it.
        assert.strictEqual(yield* status(root, lookup("file"), read(anonymous)), Status.OK)
        const holder = yield* attempt(root, openAs("holder", 1))
        assert.strictEqual(holder.status, Status.OK)
        assert.strictEqual(yield* status(root, lookup("file"), read(anonymous)), Status.LOCKED)
        assert.strictEqual(yield* status(root, lookup("file"), read(bypass)), Status.OK)
        // SAFETY: OPEN succeeded, so its body is the OPEN result shape.
        const holderStateid = (holder.operations[2]!.value as { readonly stateid: Uint8Array }).stateid

        const close = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.CLOSE)
          yield* writer.write(Xdr.uint32, 0)
          yield* writer.write(Xdr.fixedOpaque(holderStateid.length), holderStateid)
        })

        assert.strictEqual(yield* status(root, lookup("file"), close), Status.OK)
        assert.strictEqual(yield* status(root, lookup("file"), read(anonymous)), Status.OK, "reservation released")

        // A plain OPEN through a symbolic-link current filehandle is SYMLINK, like LOOKUP.
        assert.strictEqual(yield* status(root, lookup("link"), openAs("x", 0)), Status.SYMLINK)

        // Sections 15.1.2.8 and 18.24.4.
        assert.strictEqual(yield* status(root, lookup("link"), lookup("x")), Status.SYMLINK)
        assert.strictEqual(yield* status(root, lookup("file"), lookup("x")), Status.NOTDIR)
        assert.strictEqual(yield* status(root, lookup("file"), readlink), Status.WRONG_TYPE)
        assert.strictEqual(yield* status(root, readlink), Status.WRONG_TYPE)
        assert.strictEqual(yield* status(root, lookup("link"), readlink), Status.OK)

        // LOCKU lists no object-type errors, so a directory is still BAD_STATEID.
        const locku = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.LOCKU)
          yield* writer.write(Xdr.uint32, 1)
          yield* writer.write(Xdr.uint32, 0)
          yield* writer.write(Xdr.fixedOpaque(anonymous.length), anonymous)
          yield* writer.write(Xdr.uint64, 0n)
          yield* writer.write(Xdr.uint64, 1n)
        })

        assert.strictEqual(yield* status(root, locku), Status.BAD_STATEID)

        // OPEN4_CREATE keeps structural precedence over ROFS and needs CLAIM_NULL.
        assert.strictEqual(yield* status(create("new")), Status.NOFILEHANDLE)
        assert.strictEqual(yield* status(root, lookup("link"), create("new")), Status.SYMLINK)
        assert.strictEqual(yield* status(root, lookup("file"), create("new")), Status.NOTDIR)
        assert.strictEqual(yield* status(root, create("a/b")), Status.BADCHAR)
        assert.strictEqual(yield* status(root, create("..")), Status.BADNAME)
        assert.strictEqual(yield* status(root, create("new", 4)), Status.INVAL, "CLAIM_FH cannot create")
        assert.strictEqual(yield* status(root, create("new")), Status.ROFS)
        assert.strictEqual(yield* status(root, lookup("link"), create("new", 0, 3)), Status.SYMLINK, "write access too")
        assert.strictEqual(yield* status(root, create("..", 0, 2)), Status.BADNAME)
        assert.strictEqual(yield* status(root, create("new", 0, 2)), Status.ROFS)
        assert.strictEqual(yield* status(root, openAs("w", 0)), Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject state protection it cannot honor and name forbidden bytes as BADCHAR when state protection or forbidden name bytes are requested", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const handler = yield* wireClient(caller)

        const exchange = (protection: (writer: RequestWriter) => Effect.Effect<void>) =>
          run(
            handler,
            call([(writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.EXCHANGE_ID)
                yield* writer.write(Xdr.fixedOpaque(new Uint8Array(8).length), new Uint8Array(8))
                yield* writer.write(Xdr.string(), "protected")
                yield* writer.write(Xdr.uint32, 0)
                yield* protection(writer)
                yield* writer.write(Xdr.array(Xdr.uint32), [])
              })])
          )

        const ops = Effect.fnUntraced(function*(writer: RequestWriter, how: number) {
          yield* writer.write(Xdr.uint32, how)
          yield* writer.write(Xdr.array(Xdr.uint32), [])
          yield* writer.write(Xdr.array(Xdr.uint32), [])
        })

        // Section 18.35.3: SP4_MACH_CRED needs RPCSEC_GSS integrity, which AUTH_SYS cannot give.
        const machCred = yield* exchange((writer) => ops(writer, 1))
        assert.deepStrictEqual(machCred.operations, [{ code: Operation.EXCHANGE_ID, status: Status.INVAL }])

        const machCredWithOps = yield* exchange((writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, 1)
            yield* writer.write(Xdr.array(Xdr.uint32), [0x0800_0000, 0x0000_0002])
            yield* writer.write(Xdr.array(Xdr.uint32), [0x0000_0400])
          })
        )

        assert.deepStrictEqual(machCredWithOps.operations, [{ code: Operation.EXCHANGE_ID, status: Status.INVAL }])

        // SP4_SSV decodes fully and fails on the algorithm list rather than on the XDR.
        const ssv = yield* exchange((writer) =>
          Effect.gen(function*() {
            yield* ops(writer, 2)
            yield* writer.write(Xdr.array(Xdr.opaque()), [new Uint8Array([1, 2])])
            yield* writer.write(Xdr.array(Xdr.opaque()), [new Uint8Array([3])])
            yield* writer.write(Xdr.uint32, 8)
            yield* writer.write(Xdr.uint32, 1)
          })
        )

        assert.deepStrictEqual(ssv.operations, [{ code: Operation.EXCHANGE_ID, status: Status.ENCR_ALG_UNSUPP }])

        const undefinedHow = yield* exchange((writer) => writer.write(Xdr.uint32, 3))

        assert.deepStrictEqual(undefinedHow.operations, [{ code: Operation.EXCHANGE_ID, status: Status.BADXDR }])

        // Section 14.5: valid UTF-8 the file system cannot store is BADCHAR; invalid UTF-8 is INVAL.
        const { session } = yield* startSession(handler, "badchar")

        const lookup = (sequenceId: number, name: Uint8Array) =>
          run(
            handler,
            call([
              sequence(session, sequenceId),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                  yield* writer.write(Xdr.opaque(), name)
                })
            ])
          ).pipe(Effect.map((reply) => reply.status))

        assert.strictEqual(yield* lookup(1, new TextEncoder().encode("a/b")), Status.BADCHAR)
        assert.strictEqual(yield* lookup(2, new Uint8Array([0x61, 0x00])), Status.BADCHAR)
        assert.strictEqual(yield* lookup(3, new Uint8Array([0xff, 0x61])), Status.INVAL)
        assert.strictEqual(yield* lookup(4, new TextEncoder().encode("file")), Status.OK)
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should report ACCESS from mode bits against the RPC identity without granting writes when ACCESS is requested under an RPC identity", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        yield* caller.chmod("/file", 0o640)
        yield* caller.chown("/file", { uid: 501, gid: 20 })
        yield* caller.writeFile("/tool", new Uint8Array([1]), { access: "write", create: "exclusive" })
        yield* caller.chmod("/tool", 0o750)
        yield* caller.chown("/tool", { uid: 501, gid: 20 })
        yield* caller.mkdir("/dir")
        yield* caller.chmod("/dir", 0o751)
        yield* caller.chown("/dir", { uid: 501, gid: 20 })
        const { handler, session } = yield* openWireSession(caller, "access")
        let sequenceId = 0

        const access = (credentials: Credentials, name: string) =>
          run(
            handler,
            callAs(credentials, [
              sequence(session, ++sequenceId),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                  yield* writer.write(Xdr.string(), name)
                }),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.ACCESS)
                  yield* writer.write(Xdr.uint32, ACCESS_ALL)
                })
            ])
          ).pipe(Effect.map((reply) => reply.operations[3]!.value))

        const fileSupported = 0x01 | 0x04 | 0x08 | 0x20
        assert.deepStrictEqual(yield* access(sys(501, 501), "file"), { supported: fileSupported, access: 0x01 })
        assert.deepStrictEqual(yield* access(sys(999, 20), "file"), { supported: fileSupported, access: 0x01 })
        assert.deepStrictEqual(yield* access(sys(999, 999, [20]), "file"), { supported: fileSupported, access: 0x01 })
        assert.deepStrictEqual(yield* access(sys(999, 999), "file"), { supported: fileSupported, access: 0 })
        assert.deepStrictEqual(yield* access({ _tag: "None" }, "file"), { supported: fileSupported, access: 0 })
        assert.deepStrictEqual(yield* access(sys(0, 0), "file"), { supported: fileSupported, access: 0x01 })
        assert.deepStrictEqual(yield* access(sys(501, 501), "tool"), { supported: fileSupported, access: 0x21 })
        assert.deepStrictEqual(yield* access(sys(0, 0), "tool"), { supported: fileSupported, access: 0x21 })

        const directorySupported = 0x01 | 0x02 | 0x04 | 0x08 | 0x10
        assert.deepStrictEqual(yield* access({ _tag: "None" }, "dir"), { supported: directorySupported, access: 0x02 })
        assert.deepStrictEqual(yield* access(sys(501, 501), "dir"), { supported: directorySupported, access: 0x03 })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should return INVAL when VERIFY requests a write-only time_access_set attribute", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const handler = yield* wireClient(caller)
        const { session } = yield* startSession(handler, "precedence-verify")

        const verify = yield* run(
          handler,
          call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                yield* writer.write(Xdr.string(), "file")
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.VERIFY)
                yield* fattr(writer, 48, (values) => values.write(Xdr.uint32, 0))
              })
          ])
        )

        assert.strictEqual(verify.status, Status.INVAL, "time_access_set is write-only, not unsupported")
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("ReadOnlyState over TCP", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should manage open stateids with OPEN_DOWNGRADE, TEST_STATEID, and FREE_STATEID when OPEN_DOWNGRADE, TEST_STATEID, or FREE_STATEID is sent", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const { handler, client, session } = yield* openWireSession(caller, "stateids")

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 1, true),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

              openReadOnly(client, "file"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        const downgrade = yield* run(
          handler,
          call([
            sequence(session, 2),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.OPEN_DOWNGRADE)
                yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 1)
                yield* writer.write(Xdr.uint32, 0)
              })
          ])
        )

        assert.strictEqual(downgrade.status, Status.OK)
        // SAFETY: OPEN_DOWNGRADE succeeded, so its decoded body is the returned 16-byte stateid.
        const downgraded = downgrade.operations[2]!.value as Uint8Array
        assert.strictEqual(new DataView(downgraded.buffer).getUint32(0), 2)
        assert.deepStrictEqual(downgraded.subarray(4), opened.stateid.subarray(4))

        const widen = yield* run(
          handler,
          call([
            sequence(session, 3),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.OPEN_DOWNGRADE)
                yield* writer.write(Xdr.fixedOpaque(downgraded.length), downgraded)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 2)
                yield* writer.write(Xdr.uint32, 0)
              })
          ])
        )

        assert.strictEqual(widen.status, Status.INVAL)

        const unknownStateid = new Uint8Array(16).fill(0x42)

        const tested = yield* run(
          handler,
          call([
            sequence(session, 4),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.TEST_STATEID)
                yield* writer.write(
                  Xdr.array(Xdr.fixedOpaque(16)),
                  [downgraded, opened.stateid, unknownStateid, new Uint8Array(16)]
                )
              })
          ])
        )

        assert.strictEqual(tested.status, Status.OK)
        assert.deepStrictEqual(tested.operations[1]!.value, [
          Status.OK,
          Status.OLD_STATEID,
          Status.BAD_STATEID,
          Status.BAD_STATEID
        ])

        const held = yield* run(
          handler,
          call([sequence(session, 5), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.FREE_STATEID)
              yield* writer.write(Xdr.fixedOpaque(downgraded.length), downgraded)
            })])
        )

        assert.strictEqual(held.status, Status.LOCKS_HELD)

        const freeUnknown = yield* run(
          handler,
          call([sequence(session, 6), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.FREE_STATEID)
              yield* writer.write(Xdr.fixedOpaque(unknownStateid.length), unknownStateid)
            })])
        )

        assert.strictEqual(freeUnknown.status, Status.BAD_STATEID)

        const badDowngrade = yield* run(
          handler,
          call([
            sequence(session, 7),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.OPEN_DOWNGRADE)
                yield* writer.write(Xdr.fixedOpaque(unknownStateid.length), unknownStateid)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 1)
                yield* writer.write(Xdr.uint32, 0)
              })
          ])
        )

        assert.strictEqual(badDowngrade.status, Status.BAD_STATEID)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should validate lock stateids and reject write-lock tests on a read-only export when a lock stateid or write-lock test reaches a read-only export", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const { handler, client, session } = yield* openWireSession(caller, "locks")

        const onFile = (
          sequenceId: number,
          operation: (writer: RequestWriter) => Effect.Effect<void>
        ) =>
          run(
            handler,
            call([
              sequence(session, sequenceId),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                  yield* writer.write(Xdr.string(), "file")
                }),
              operation
            ])
          ).pipe(Effect.map((reply) => reply.status))

        const lock = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.LOCK)
          yield* writer.write(Xdr.uint32, 1)
          yield* writer.write(Xdr.boolean, false)
          yield* writer.write(Xdr.uint64, 0n)
          yield* writer.write(Xdr.uint64, 0xffff_ffff_ffff_ffffn)
          yield* writer.write(Xdr.boolean, true)
          yield* writer.write(Xdr.uint32, 0)
          yield* writer.write(Xdr.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
          yield* writer.write(Xdr.uint32, 0)
          yield* writer.write(Xdr.uint64, client)
          yield* writer.write(Xdr.string(), "lock-owner")
        })

        assert.strictEqual(yield* onFile(1, lock), Status.BAD_STATEID)

        // A write-lock test reports the read-only file system; a read-lock test finds no conflict.
        const lockt = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.LOCKT)
          yield* writer.write(Xdr.uint32, 2)
          yield* writer.write(Xdr.uint64, 0n)
          yield* writer.write(Xdr.uint64, 1n)
          yield* writer.write(Xdr.uint64, client)
          yield* writer.write(Xdr.string(), "lock-owner")
        })

        assert.strictEqual(yield* onFile(2, lockt), Status.ROFS)

        const locku = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.LOCKU)
          yield* writer.write(Xdr.uint32, 1)
          yield* writer.write(Xdr.uint32, 0)
          yield* writer.write(Xdr.fixedOpaque(new Uint8Array(16).fill(9).length), new Uint8Array(16).fill(9))
          yield* writer.write(Xdr.uint64, 0n)
          yield* writer.write(Xdr.uint64, 1n)
        })

        assert.strictEqual(yield* onFile(3, locku), Status.BAD_STATEID)

        const setSsv = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.SET_SSV)
          yield* writer.write(Xdr.opaque(), new Uint8Array(4))
          yield* writer.write(Xdr.opaque(), new Uint8Array(4))
        })

        assert.strictEqual(yield* onFile(4, setSsv), Status.INVAL)

        const truncatedLock = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.LOCK)
          yield* writer.write(Xdr.uint32, 1)
          yield* writer.write(Xdr.boolean, false)
        })

        assert.strictEqual(yield* onFile(5, truncatedLock), Status.BADXDR)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should substitute the current stateid in OPEN_DOWNGRADE and CLOSE within one compound when OPEN_DOWNGRADE and CLOSE use the current stateid", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const { handler, client, session } = yield* openWireSession(caller, "current-stateid")
        const current = new Uint8Array([0, 0, 0, 1, ...new Uint8Array(12)])

        const reply = yield* run(
          handler,
          call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

            openReadOnly(client, "file"),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.OPEN_DOWNGRADE)
                yield* writer.write(Xdr.fixedOpaque(current.length), current)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 1)
                yield* writer.write(Xdr.uint32, 0)
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.READ)
                yield* writer.write(Xdr.fixedOpaque(current.length), current)
                yield* writer.write(Xdr.uint64, 0n)
                yield* writer.write(Xdr.uint32, 4)
              }),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.CLOSE)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.fixedOpaque(current.length), current)
              })
          ])
        )

        assert.strictEqual(reply.status, Status.OK)
        // SAFETY: OPEN succeeded, so the body reader table produced the OPEN result shape.
        const opened = reply.operations[2]!.value as { readonly stateid: Uint8Array }
        // SAFETY: OPEN_DOWNGRADE succeeded, so its body is the returned stateid.
        const downgraded = reply.operations[3]!.value as Uint8Array
        assert.strictEqual(new DataView(opened.stateid.buffer).getUint32(0), 1)
        assert.strictEqual(new DataView(downgraded.buffer).getUint32(0), 2)
        assert.deepStrictEqual(downgraded.subarray(4), opened.stateid.subarray(4))
        assert.strictEqual(reply.operations[5]!.status, Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should move the current stateid with the filehandle when the current filehandle changes", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/a", new Uint8Array([1]), { access: "write", create: "exclusive" })
        yield* caller.writeFile("/b", new Uint8Array([2]), { access: "write", create: "exclusive" })
        const { handler, client, session } = yield* openWireSession(caller, "current-stateid-set")
        const current = new Uint8Array([0, 0, 0, 1, ...new Uint8Array(12)])

        const root = (writer: RequestWriter) => writer.write(Xdr.uint32, Operation.PUTROOTFH)

        const lookup = (name: string) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.LOOKUP)
            yield* writer.write(Xdr.string(), name)
          })

        const read = (stateid: Uint8Array) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.READ)
            yield* writer.write(Xdr.fixedOpaque(stateid.length), stateid)
            yield* writer.write(Xdr.uint64, 0n)
            yield* writer.write(Xdr.uint32, 1)
          })

        const close = Effect.fnUntraced(function*(writer: RequestWriter) {
          yield* writer.write(Xdr.uint32, Operation.CLOSE)
          yield* writer.write(Xdr.uint32, 0)
          yield* writer.write(Xdr.fixedOpaque(current.length), current)
        })

        // Section 16.2.3.1.2: SAVEFH and RESTOREFH carry the stateid with the filehandle.
        const saved = yield* run(
          handler,
          call([
            sequence(session, 1),
            root,
            openReadOnly(client, "a"),
            (writer) => writer.write(Xdr.uint32, Operation.SAVEFH),

            root,
            openReadOnly(client, "b"),
            (writer) => writer.write(Xdr.uint32, Operation.RESTOREFH),

            close
          ])
        )

        assert.strictEqual(saved.status, Status.OK)
        // SAFETY: the first OPEN succeeded, so its body is the OPEN result shape.
        const openedA = (saved.operations[2]!.value as { readonly stateid: Uint8Array }).stateid
        // SAFETY: the second OPEN succeeded, so its body is the OPEN result shape.
        const openedB = (saved.operations[5]!.value as { readonly stateid: Uint8Array }).stateid
        // SAFETY: CLOSE succeeded, so its body is the closed stateid.
        const closed = saved.operations[7]!.value as Uint8Array
        assert.deepStrictEqual(closed.subarray(4), openedA.subarray(4), "RESTOREFH brought back a's stateid")

        const afterClose = yield* run(handler, call([sequence(session, 2), root, lookup("b"), read(openedB)]))
        assert.strictEqual(afterClose.status, Status.OK, "b stays open")
        const reuseA = yield* run(handler, call([sequence(session, 3), root, lookup("a"), read(openedA)]))
        assert.strictEqual(reuseA.status, Status.BAD_STATEID, "a is closed")

        // Setting a filehandle without a stateid resets the current stateid to all zeros, and
        // (1, 0) against a special current stateid is BAD_STATEID (Section 8.2.3).
        const reset = yield* run(
          handler,
          call([sequence(session, 4), root, openReadOnly(client, "b"), root, lookup("b"), read(current)])
        )

        assert.strictEqual(reset.status, Status.BAD_STATEID)
        assert.strictEqual(reset.operations.length, 6)

        // Stateid operations need a current filehandle before any stateid check.
        assert.strictEqual((yield* run(handler, call([sequence(session, 5), close]))).status, Status.NOFILEHANDLE)

        const downgrade = yield* run(
          handler,
          call([
            sequence(session, 6),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.OPEN_DOWNGRADE)
                yield* writer.write(Xdr.fixedOpaque(current.length), current)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 1)
                yield* writer.write(Xdr.uint32, 0)
              })
          ])
        )

        assert.strictEqual(downgrade.status, Status.NOFILEHANDLE)
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should answer delegation wants in OPEN share_access with OPEN_DELEGATE_NONE_EXT when OPEN requests a delegation", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2, 3]), { access: "write", create: "exclusive" })
        const { handler, session } = yield* openWireSession(caller, "wants")
        let sequenceId = 0

        // The macOS 26 client opens with CLAIM_FH and OPEN4_SHARE_ACCESS_WANT_READ_DELEG (0x0100).
        const open = (shareAccess: number) =>
          run(
            handler,
            callAs(sys(501, 20), [
              sequence(session, ++sequenceId),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),

              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                  yield* writer.write(Xdr.string(), "file")
                }),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.OPEN)
                  yield* writer.write(Xdr.uint32, 1)
                  yield* writer.write(Xdr.uint32, shareAccess)
                  yield* writer.write(Xdr.uint32, 0)
                  yield* writer.write(Xdr.uint64, 1n)
                  yield* writer.write(Xdr.string(), "mac")
                  yield* writer.write(Xdr.uint32, 0)
                  yield* writer.write(Xdr.uint32, 4)
                }),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.READ)
                  yield* writer.write(
                    Xdr.fixedOpaque(new Uint8Array([0, 0, 0, 1, ...new Uint8Array(12)]).length),
                    new Uint8Array([0, 0, 0, 1, ...new Uint8Array(12)])
                  )
                  yield* writer.write(Xdr.uint64, 0n)
                  yield* writer.write(Xdr.uint32, 16)
                })
            ])
          )

        const expectOpen = (reply: DecodedReply, delegation: number, why: number) => {
          assert.strictEqual(reply.status, Status.OK)
          // SAFETY: OPEN succeeded, so the body reader table produced the OPEN result shape.
          const result = reply.operations[3]!.value as { readonly delegation: number; readonly why: number }
          assert.deepStrictEqual({ delegation: result.delegation, why: result.why }, { delegation, why })
          // SAFETY: READ succeeded, so the body reader table produced the READ result shape.
          const read = reply.operations[4]!.value as { readonly data: Uint8Array }
          assert.deepStrictEqual(read.data, new Uint8Array([1, 2, 3]))
        }

        expectOpen(yield* open(0x0101), 3, 3)
        expectOpen(yield* open(0x0301), 3, 3)
        expectOpen(yield* open(0x0401), 3, 0)
        expectOpen(yield* open(0x0501), 3, 7)
        expectOpen(yield* open(0x0001_0101), 3, 3)
        expectOpen(yield* open(0x0001), 0, -1)
        assert.strictEqual((yield* open(0x0601)).status, Status.INVAL)
        assert.strictEqual((yield* open(0x0100)).status, Status.INVAL)
        assert.strictEqual((yield* open(0x0102)).status, Status.ROFS)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should answer reclaim claims, share reservations, and masked downgrades per Sections 18.16 and 18.18 when reclaim claims, reservations, or downgrades reach OPEN", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const { handler, client, session } = yield* openWireSession(caller, "share-reservations")
        let sequenceId = 0

        const attempt = (
          ...operations: ReadonlyArray<(writer: RequestWriter) => Effect.Effect<void>>
        ) => run(handler, call([sequence(session, ++sequenceId), ...operations]))

        const root = (writer: RequestWriter) => writer.write(Xdr.uint32, Operation.PUTROOTFH)

        const lookup = (name: string) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.LOOKUP)
            yield* writer.write(Xdr.string(), name)
          })

        const openAs = (owner: string, deny: number, claim = 0) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.OPEN)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, 1)
            yield* writer.write(Xdr.uint32, deny)
            yield* writer.write(Xdr.uint64, client)
            yield* writer.write(Xdr.string(), owner)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, claim)

            if (claim === 0) yield* writer.write(Xdr.string(), "file")
            else if (claim === 1) yield* writer.write(Xdr.uint32, 0)
            else if (claim === 3) yield* writer.write(Xdr.string(), "")
            else if (claim === 2) {
              yield* writer.write(Xdr.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
              yield* writer.write(Xdr.string(), "file")
            } else if (claim === 5) {
              yield* writer.write(Xdr.fixedOpaque(new Uint8Array(16).length), new Uint8Array(16))
            }
          })

        const stateidOf = (reply: DecodedReply, index: number) =>
          // SAFETY: the caller asserted that OPEN at this index succeeded, so its body is the OPEN result shape.
          (reply.operations[index]!.value as { readonly stateid: Uint8Array }).stateid

        const close = (stateid: Uint8Array) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.CLOSE)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.fixedOpaque(stateid.length), stateid)
          })

        const downgrade = (stateid: Uint8Array, access: number, deny: number) => (writer: RequestWriter) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.OPEN_DOWNGRADE)
            yield* writer.write(Xdr.fixedOpaque(stateid.length), stateid)
            yield* writer.write(Xdr.uint32, 0)
            yield* writer.write(Xdr.uint32, access)
            yield* writer.write(Xdr.uint32, deny)
          })

        // Without a grace period a reclaim is NO_GRACE; a delegation stateid can never be valid.
        assert.strictEqual((yield* attempt(root, lookup("file"), openAs("a", 0, 1))).status, Status.NO_GRACE)
        assert.strictEqual((yield* attempt(root, openAs("a", 0, 3))).status, Status.NO_GRACE, "CLAIM_DELEGATE_PREV")
        assert.strictEqual((yield* attempt(root, lookup("file"), openAs("a", 0, 6))).status, Status.NO_GRACE)
        assert.strictEqual((yield* attempt(root, openAs("a", 0, 2))).status, Status.BAD_STATEID)
        assert.strictEqual((yield* attempt(root, lookup("file"), openAs("a", 0, 5))).status, Status.BAD_STATEID)

        // Owner a denies reading; owner b is refused until a releases the reservation.
        const denyRead = yield* attempt(root, openAs("a", 1))
        assert.strictEqual(denyRead.status, Status.OK)
        assert.strictEqual((yield* attempt(root, openAs("b", 0))).status, Status.SHARE_DENIED)

        // A new read OPEN conflicts with a's own deny READ reservation too.
        const reopened = yield* attempt(root, openAs("a", 2))
        assert.strictEqual(reopened.status, Status.SHARE_DENIED)
        const first = stateidOf(denyRead, 2)
        assert.strictEqual((yield* attempt(root, openAs("b", 0))).status, Status.SHARE_DENIED, "deny READ retained")

        // Downgrading a's reservation to deny NONE is observable: b may now read.
        const released = yield* attempt(root, lookup("file"), downgrade(first, 1, 0))
        assert.strictEqual(released.status, Status.OK)
        const readerB0 = yield* attempt(root, openAs("b", 0))
        assert.strictEqual(readerB0.status, Status.OK, "deny READ released by OPEN_DOWNGRADE")
        assert.strictEqual((yield* attempt(root, lookup("file"), close(stateidOf(readerB0, 2)))).status, Status.OK)
        // SAFETY: OPEN_DOWNGRADE succeeded, so its body is the downgraded stateid.
        const downgraded = released.operations[3]!.value as Uint8Array
        assert.strictEqual((yield* attempt(root, lookup("file"), close(downgraded))).status, Status.OK)

        const readerB = yield* attempt(root, openAs("b", 0))
        assert.strictEqual(readerB.status, Status.OK)
        assert.strictEqual((yield* attempt(root, openAs("c", 1))).status, Status.SHARE_DENIED, "b already reads")
        const denyWrite = yield* attempt(root, openAs("c", 2))
        assert.strictEqual(denyWrite.status, Status.OK, "denying writes conflicts with nothing")

        // OPEN_DOWNGRADE masks want bits and requires subsets of the held modes.
        const masked = yield* attempt(root, lookup("file"), downgrade(stateidOf(readerB, 2), 0x401, 0))
        assert.strictEqual(masked.status, Status.OK)
        const widened = yield* attempt(root, lookup("file"), downgrade(stateidOf(denyWrite, 2), 1, 1))
        assert.strictEqual(widened.status, Status.INVAL, "deny READ is not a subset of deny WRITE")
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("Write over TCP", () => {
  const write = (stateid: Uint8Array, bytes: Uint8Array, offset = 0n, stable = 2) => (writer: RequestWriter) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.WRITE)
      yield* writer.write(Xdr.fixedOpaque(stateid.length), stateid)
      yield* writer.write(Xdr.uint64, offset)
      yield* writer.write(Xdr.uint32, stable)
      yield* writer.write(Xdr.opaque(), bytes)
    })

  const readWriteResult = Effect.fnUntraced(function*(bytes: Uint8Array) {
    const reader = replyReader(bytes)
    const status = yield* reader.read(Xdr.uint32)
    yield* reader.read(Xdr.string())
    yield* reader.read(Xdr.uint32)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SEQUENCE)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    yield* reader.read(Xdr.fixedOpaque(16))

    for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.PUTFH)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.WRITE)
    assert.strictEqual(yield* reader.read(Xdr.uint32), status)

    if (status !== Status.OK) {
      return {
        status
      }
    }

    const count = yield* reader.read(Xdr.uint32)
    const committed = yield* reader.read(Xdr.uint32)
    const verifier = yield* reader.read(Xdr.fixedOpaque(8))
    yield* reader.finish

    return {
      status,
      count,
      committed,
      verifier
    }
  })

  const readCommitResult = Effect.fnUntraced(function*(bytes: Uint8Array) {
    const reader = replyReader(bytes)
    const status = yield* reader.read(Xdr.uint32)
    yield* reader.read(Xdr.string())
    yield* reader.read(Xdr.uint32)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SEQUENCE)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    yield* reader.read(Xdr.fixedOpaque(16))

    for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.PUTFH)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.COMMIT)
    assert.strictEqual(yield* reader.read(Xdr.uint32), status)

    if (status !== Status.OK) {
      return {
        status
      }
    }

    const verifier = yield* reader.read(Xdr.fixedOpaque(8))
    yield* reader.finish

    return {
      status,
      verifier
    }
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should return IO without publishing bytes when storage rejects the write", () =>
      Effect.gen(function*() {
        let reject = false

        const store = Layer.succeed(
          LiveVolume.LiveImageStore,
          LiveVolume.LiveImageStore.of({
            durability: "survives-power-loss",
            loadOrCreate: (initial) => Effect.succeed(initial),
            commit: () => Effect.succeed(reject ? "rejected" as const : "committed" as const)
          })
        )

        return yield* Effect.gen(function*() {
          const volume = yield* LiveVolume.open({
            maxImageBytes: ByteSize.kilobytes(64),
            volume: {
              maxEntries: 16,
              maxBytes: ByteSize.bytes(32),
              maxFileBytes: ByteSize.bytes(32),
              maxPathBytes: ByteSize.bytes(255)
            }
          })

          const caller = yield* volume.caller()
          yield* caller.writeFile("/file", new Uint8Array([1]), {
            access: "write",
            create: "exclusive"
          })

          const { handler, client, session } = yield* openWireSession(caller, "write-reject", {
            writable: true
          }).pipe(Effect.provideService(Vfs.Volume, volume))

          const opened = yield* parseOpen(
            yield* handler.send(
              yield* call([
                sequence(session, 1),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                openByName(client, "file", 2),
                (writer) => writer.write(Xdr.uint32, Operation.GETFH)
              ])
            )
          )

          reject = true

          const result = yield* readWriteResult(
            yield* handler.send(
              yield* call([sequence(session, 2), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), opened.filehandle)
                }), write(opened.stateid, new Uint8Array([2]), 0n)])
            )
          )

          assert.strictEqual(result.status, Status.IO)
          reject = false
          assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([1]))
        }).pipe(Effect.provide(store))
      }))

    it.effect("should hold the WRITE reply until the store confirms the commit when the store has not confirmed the WRITE commit", () =>
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let hold = false

        const store = Layer.succeed(
          LiveVolume.LiveImageStore,
          LiveVolume.LiveImageStore.of({
            durability: "survives-power-loss",
            loadOrCreate: (initial) => Effect.succeed(initial),
            commit: () =>
              hold ?
                Effect.gen(function*() {
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(release)

                  return "committed" as const
                }) :
                Effect.succeed("committed" as const)
          })
        )

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open({
            maxImageBytes: ByteSize.kilobytes(64),
            volume: {
              maxEntries: 16,
              maxBytes: ByteSize.bytes(32),
              maxFileBytes: ByteSize.bytes(32),
              maxPathBytes: ByteSize.bytes(255)
            }
          })

          const caller = yield* volume.caller()
          yield* caller.writeFile("/file", new Uint8Array([1]), {
            access: "write",
            create: "exclusive"
          })

          const { handler, client, session } = yield* openWireSession(caller, "write-commit-order", {
            writable: true
          }).pipe(Effect.provideService(Vfs.Volume, volume))

          const opened = yield* parseOpen(
            yield* handler.send(
              yield* call([
                sequence(session, 1),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                openByName(client, "file", 2),
                (writer) => writer.write(Xdr.uint32, Operation.GETFH)
              ])
            )
          )

          hold = true

          const reply = yield* handler.send(
            yield* call([sequence(session, 2), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }), write(opened.stateid, new Uint8Array([2]), 0n)])
          ).pipe(Effect.forkChild({
            startImmediately: true
          }))

          yield* Deferred.await(started)
          assert.strictEqual(reply.pollUnsafe(), undefined)
          yield* Deferred.succeed(release, undefined)
          const result = yield* readWriteResult(yield* Fiber.join(reply))
          assert.strictEqual(result.status, Status.OK)
          assert.strictEqual(result.committed, 2)
          assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([2]))
        })).pipe(Effect.provide(store))
      }))

    it.effect("should return no success after an unknown storage outcome and stop COMMIT when the store reports an unknown outcome", () =>
      Effect.gen(function*() {
        let unknown = false

        const store = Layer.succeed(
          LiveVolume.LiveImageStore,
          LiveVolume.LiveImageStore.of({
            durability: "survives-power-loss",
            loadOrCreate: (initial) => Effect.succeed(initial),
            commit: () => Effect.succeed(unknown ? "unknown" as const : "committed" as const)
          })
        )

        return yield* Effect.gen(function*() {
          const volume = yield* LiveVolume.open({
            maxImageBytes: ByteSize.kilobytes(64),
            volume: {
              maxEntries: 16,
              maxBytes: ByteSize.bytes(32),
              maxFileBytes: ByteSize.bytes(32),
              maxPathBytes: ByteSize.bytes(255)
            }
          })

          const caller = yield* volume.caller()
          yield* caller.writeFile("/file", new Uint8Array([1]), {
            access: "write",
            create: "exclusive"
          })

          const { handler, client, session } = yield* openWireSession(caller, "write-unknown", {
            writable: true
          }).pipe(Effect.provideService(Vfs.Volume, volume))

          const opened = yield* parseOpen(
            yield* handler.send(
              yield* call([
                sequence(session, 1),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                openByName(client, "file", 2),
                (writer) => writer.write(Xdr.uint32, Operation.GETFH)
              ])
            )
          )

          unknown = true

          const result = yield* readWriteResult(
            yield* handler.send(
              yield* call([sequence(session, 2), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), opened.filehandle)
                }), write(opened.stateid, new Uint8Array([2]), 0n)])
            )
          )

          assert.strictEqual(result.status, Status.IO)

          const next = replyReader(
            yield* handler.send(
              yield* call([sequence(session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), opened.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.COMMIT)
                  yield* writer.write(Xdr.uint64, 0n)
                  yield* writer.write(Xdr.uint32, 0)
                })])
            )
          )

          assert.strictEqual(yield* next.read(Xdr.uint32), Status.SERVERFAULT)
          yield* next.read(Xdr.string())
          assert.strictEqual(yield* next.read(Xdr.uint32), 2)
          assert.strictEqual(yield* next.read(Xdr.uint32), Operation.SEQUENCE)
          assert.strictEqual(yield* next.read(Xdr.uint32), Status.OK)
          yield* next.read(Xdr.fixedOpaque(16))

          for (let field = 0; field < 5; field++) yield* next.read(Xdr.uint32)
          assert.strictEqual(yield* next.read(Xdr.uint32), Operation.PUTFH)
          assert.strictEqual(yield* next.read(Xdr.uint32), Status.SERVERFAULT)
          assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
        }).pipe(Effect.provide(store))
      }))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should write through the held write handle after either OPEN upgrade order when OPEN upgrades occur in either order", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/read-first", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        yield* caller.writeFile("/write-first", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, client, session } = yield* openWireSession(caller, "write-upgrade", {
          writable: true
        }).pipe(Effect.provideService(Vfs.Volume, volume))

        let sequenceId = 1

        for (const [name, firstAccess, secondAccess] of [["read-first", 1, 2], ["write-first", 2, 1]] as const) {
          yield* handler.send(
            yield* call([
              sequence(session, sequenceId++),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(client, name, firstAccess),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )

          const upgraded = yield* parseOpen(
            yield* handler.send(
              yield* call([
                sequence(session, sequenceId++),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                openByName(client, name, secondAccess),
                (writer) => writer.write(Xdr.uint32, Operation.GETFH)
              ])
            )
          )

          const result = yield* readWriteResult(
            yield* handler.send(
              yield* call([sequence(session, sequenceId++), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), upgraded.filehandle)
                }), write(upgraded.stateid, new Uint8Array([2]), 0n)])
            )
          )

          assert.strictEqual(result.status, Status.OK)
          assert.strictEqual(result.count, 1)
          assert.deepStrictEqual(yield* caller.readFile(`/${name}`), new Uint8Array([2]))
        }
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should report the committed prefix and replay a lost WRITE reply without writing twice when a WRITE reply is lost after a committed prefix", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume

        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1, 2]), {
          access: "write",
          create: "exclusive"
        })
        const storageGeneration = new Uint8Array(16).fill(9)

        const { handler, client, session } = yield* openWireSession(caller, "write-prefix", {
          storageGeneration,
          writable: true
        }).pipe(Effect.provideService(Vfs.Volume, volume))

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(client, "file", 2),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        const request = yield* call([sequence(session, 2, true), (writer) =>
          Effect.gen(function*() {
            yield* writer.write(Xdr.uint32, Operation.PUTFH)
            yield* writer.write(Xdr.opaque(), opened.filehandle)
          }), write(opened.stateid, new Uint8Array([3, 4, 5, 6]), 2n, 0)])

        const first = yield* handler.send(request)
        const result = yield* readWriteResult(first)
        assert.strictEqual(result.status, Status.OK)
        assert.strictEqual(result.count, 2)
        assert.strictEqual(result.committed, 2)
        assert.strictEqual(result.verifier?.length, 8)
        assert.deepStrictEqual(yield* handler.send(request), first)
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([1, 2, 3, 4]))

        const zero = yield* readWriteResult(
          yield* handler.send(
            yield* call([sequence(session, 3), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }), write(opened.stateid, new Uint8Array(0), 0n)])
          )
        )

        assert.strictEqual(zero.count, 0)

        const committed = yield* readCommitResult(
          yield* handler.send(
            yield* call([sequence(session, 4), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.COMMIT)
                yield* writer.write(Xdr.uint64, 0n)
                yield* writer.write(Xdr.uint32, 0)
              })])
          )
        )

        assert.deepStrictEqual(committed.verifier, result.verifier)

        const invalid = yield* readWriteResult(
          yield* handler.send(
            yield* call([sequence(session, 5), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }), write(new Uint8Array(16), new Uint8Array([8]), 0n)])
          )
        )

        assert.strictEqual(invalid.status, Status.BAD_STATEID)

        const badStability = yield* readWriteResult(
          yield* handler.send(
            yield* call([sequence(session, 6), (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), opened.filehandle)
              }), write(opened.stateid, new Uint8Array([8]), 0n, 3)])
          )
        )

        assert.strictEqual(badStability.status, Status.INVAL)
      }).pipe(
        Effect.provide(Testing.layer({ volume: { maxBytes: ByteSize.bytes(4), maxFileBytes: ByteSize.bytes(4) } }))
      ))
  })
})

describe("Create over TCP", () => {
  type Attributes = ReadonlyArray<readonly [number, WriteOperation]>

  const writeBitmap = Effect.fnUntraced(function*(writer: RequestWriter, attributes: ReadonlyArray<number>) {
    const words = Array.from({
      length: attributes.length === 0 ? 0 : Math.floor(Math.max(...attributes) / 32) + 1
    }, () => 0)

    for (const attribute of attributes) words[Math.floor(attribute / 32)]! |= 1 << attribute % 32
    yield* writer.write(Xdr.uint32, words.length)

    for (const xdrValue of words) {
      yield* ((item, word) => item.write(Xdr.uint32, word >>> 0))(writer, xdrValue)
    }
  })

  const readBitmap = Effect.fnUntraced(function*(reader: ReplyReader) {
    return (yield* reader.read(Xdr.array(Xdr.uint32))).flatMap((word, index) =>
      Array.from({
        length: 32
      }, (_, bit) => index * 32 + bit).filter((attribute) => (word & 1 << attribute % 32) !== 0)
    )
  })

  const create = (
    client: bigint,
    name: string,
    mode = 0,
    attrs: Attributes = [],
    verifier: Uint8Array = new Uint8Array(8).fill(17),
    access = 3,
    owner = "creator",
    deny = 0
  ) =>
  (writer: RequestWriter) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.OPEN)
      yield* writer.write(Xdr.uint32, 0)
      yield* writer.write(Xdr.uint32, access)
      yield* writer.write(Xdr.uint32, deny)
      yield* writer.write(Xdr.uint64, client)
      yield* writer.write(Xdr.string(), owner)
      yield* writer.write(Xdr.uint32, 1)
      yield* writer.write(Xdr.uint32, mode)

      if (mode === 2 || mode === 3) {
        yield* writer.write(Xdr.fixedOpaque(verifier.length), verifier)
      }

      if (mode !== 2) {
        yield* writeBitmap(writer, attrs.map(([attribute]) => attribute))
        const values = requestWriter()

        for (const [, encode] of attrs) yield* encode(values)
        yield* writer.write(Xdr.opaque(), yield* values.finish)
      }

      yield* writer.write(Xdr.uint32, 0)
      yield* writer.write(Xdr.string(), name)
    })

  const createCall = (
    client: bigint,
    session: Uint8Array,
    sequenceId: number,
    name = "file",
    mode = 0,
    attrs: Attributes = [],
    verifier?: Uint8Array,
    cache = true,
    owner = "creator"
  ) =>
    call([
      sequence(session, sequenceId, cache),
      (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
      create(client, name, mode, attrs, verifier, 3, owner),
      (writer) => writer.write(Xdr.uint32, Operation.GETFH)
    ])

  const responseStatus = Effect.fnUntraced(function*(bytes: Uint8Array) {
    return yield* (replyReader(bytes)).read(Xdr.uint32)
  })

  const afterRoot = Effect.fnUntraced(function*(bytes: Uint8Array) {
    const reader = replyReader(bytes)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    yield* reader.read(Xdr.string())
    yield* reader.read(Xdr.uint32)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SEQUENCE)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    yield* reader.read(Xdr.fixedOpaque(16))

    for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.PUTROOTFH)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)

    return reader
  })

  const readCreate = Effect.fnUntraced(function*(bytes: Uint8Array) {
    const reader = yield* afterRoot(bytes)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.OPEN)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    const stateid = yield* reader.read(Xdr.fixedOpaque(16))
    const atomic = yield* reader.read(Xdr.boolean)
    const before = yield* reader.read(Xdr.uint64)
    const after = yield* reader.read(Xdr.uint64)
    yield* reader.read(Xdr.uint32)
    const attrs = yield* readBitmap(reader)
    assert.strictEqual(yield* reader.read(Xdr.uint32), 0)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.GETFH)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    const filehandle = yield* reader.read(Xdr.opaque())
    yield* reader.finish

    return {
      stateid,
      filehandle,
      before,
      after,
      atomic,
      attrs
    }
  })

  const server = (caller: Vfs.Caller, volume: Vfs.Volume, options: {
    readonly maxOpens?: number
    readonly writable?: boolean
    readonly mapped?: Vfs.Caller
  } = {}) =>
    wireClient(caller, {
      limits: {
        ...limits,
        maxOpens: options.maxOpens ?? limits.maxOpens
      },
      writable: options.writable ?? true,
      mappedCaller: options.mapped ?? caller
    }).pipe(Effect.provideService(Vfs.Volume, volume))

  const setup = Effect.fnUntraced(function*(options: Parameters<typeof server>[2] = {}) {
    const volume = yield* Vfs.Volume
    const caller = yield* Vfs.Caller

    const handler = yield* server(caller, volume, options)
    const session = yield* startSession(handler, "create-client")

    return {
      volume,
      caller,
      handler,
      ...session
    }
  })

  const liveOptions: LiveVolume.Options = {
    maxImageBytes: ByteSize.kilobytes(64),
    volume: {
      maxEntries: 16,
      maxBytes: ByteSize.bytes(64),
      maxFileBytes: ByteSize.bytes(32),
      maxPathBytes: ByteSize.bytes(255)
    }
  }

  const simpleCreate = (
    client: bigint,
    name: string,
    mode: 0 | 1 = 0,
    access = 3,
    owner = "creator",
    attrs: ReadonlyArray<readonly [number, number | bigint]> = []
  ) =>
    create(
      client,
      name,
      mode,
      [...attrs].sort(([left], [right]) => left - right).map(([attribute, value]) => [attribute, (writer) => {
        if (attribute === 4) return writer.write(Xdr.uint64, BigInt(value))

        if (attribute === 36 || attribute === 37) return writer.write(Xdr.string(), String(value))

        return writer.write(Xdr.uint32, Number(value))
      }]),
      undefined,
      access,
      owner
    )

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should leave the file unpublished when its requested size exceeds the core limit", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume

        const caller = yield* Vfs.Caller

        const { handler, client, session } = yield* openWireSession(caller, "too-large", {
          writable: true
        }).pipe(Effect.provideService(Vfs.Volume, volume))

        const reply = yield* handler.send(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            simpleCreate(client, "too-large", 0, 1, "creator", [[4, 3n]])
          ])
        )

        assert.strictEqual(yield* responseStatus(reply), Status.FBIG)
        assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/too-large"))), true)
      }).pipe(Effect.provide(Testing.layer({ volume: { maxFileBytes: ByteSize.bytes(2) } }))))

    it.effect("should reopen only the confirmed create when a rejected commit is followed by a successful create", () => {
      let saved: Uint8Array | undefined
      let reject = false

      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          loadOrCreate: (initial) => Effect.succeed(saved ?? initial),
          commit: (image) =>
            Effect.sync(() => {
              if (reject) return "rejected" as const
              saved = new Uint8Array(image)

              return "committed" as const
            })
        })
      )

      const open = LiveVolume.open({
        maxImageBytes: ByteSize.kilobytes(64),
        volume: {
          maxEntries: 16,
          maxBytes: ByteSize.bytes(32),
          maxFileBytes: ByteSize.bytes(32),
          maxPathBytes: ByteSize.bytes(255)
        }
      })

      return Effect.gen(function*() {
        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* open
          const caller = yield* volume.caller()

          const { handler, client, session } = yield* openWireSession(caller, "store", {
            writable: true
          }).pipe(Effect.provideService(Vfs.Volume, volume))

          reject = true

          const rejected = yield* handler.send(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              simpleCreate(client, "rejected")
            ])
          )

          assert.strictEqual(yield* responseStatus(rejected), Status.IO)
          assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/rejected"))), true)
          reject = false
          yield* parseOpen(
            yield* handler.send(
              yield* call([
                sequence(session, 2),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                simpleCreate(client, "confirmed"),
                (writer) => writer.write(Xdr.uint32, Operation.GETFH)
              ])
            )
          )
          yield* parseOpen(
            yield* handler.send(
              yield* call([
                sequence(session, 3),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                simpleCreate(client, "confirmed"),
                (writer) => writer.write(Xdr.uint32, Operation.GETFH)
              ])
            )
          )
        }))

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* open
          const caller = yield* volume.caller()
          assert.deepInclude(yield* caller.stat("/confirmed"), { kind: "file" })
          assert.strictEqual((yield* Effect.flip(caller.stat("/rejected"))).code, "NotFound")
        }))
      }).pipe(Effect.provide(store))
    })
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should apply initial metadata and directory change information when OPEN4_CREATE supplies attributes", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        const root = yield* caller.root
        const before = yield* caller.readDirectory(root)

        const opened = yield* readCreate(
          yield* handler.send(
            yield* createCall(client, session, 1, "file", 0, [
              [4, (writer) => writer.write(Xdr.uint64, 3n)],
              [33, (writer) => writer.write(Xdr.uint32, 0o640)],
              [36, (writer) => writer.write(Xdr.string(), "12")],
              [37, (writer) => writer.write(Xdr.string(), "34")],
              [48, (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, 1)
                  yield* writer.write(Xdr.uint64, 5n)
                  yield* writer.write(Xdr.uint32, 6)
                })],
              [54, (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, 1)
                  yield* writer.write(Xdr.uint64, 7n)
                  yield* writer.write(Xdr.uint32, 8)
                })]
            ])
          )
        )

        const metadata = yield* caller.stat("/file")
        assert.deepStrictEqual([
          metadata.size,
          metadata.mode,
          metadata.uid,
          metadata.gid,
          metadata.atimeNs,
          metadata.mtimeNs
        ], [3n, 0o640, 12, 34, 5_000_000_006n, 7_000_000_008n])
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array(3))
        assert.deepStrictEqual(opened.attrs, [4, 33, 36, 37, 48, 54])
        assert.isTrue(opened.atomic)
        assert.strictEqual(opened.before, before.revision)
        assert.strictEqual(opened.after, (yield* caller.readDirectory(root)).revision)
        assert.notStrictEqual(opened.before, opened.after)
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should accept WRITE then reject the old stateid after CLOSE when OPEN4_CREATE returns an open state", () =>
      Effect.gen(function*() {
        const { caller, handler, client, session } = yield* setup()

        const opened = yield* readCreate(
          yield* handler.send(
            yield* createCall(
              client,
              session,
              1,
              "file",
              0,
              [[4, (writer) => writer.write(Xdr.uint64, 3n)]]
            )
          )
        )

        const written = yield* handler.send(
          yield* call([sequence(session, 2), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.PUTFH)
              yield* writer.write(Xdr.opaque(), opened.filehandle)
            }), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.WRITE)
              yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
              yield* writer.write(Xdr.uint64, 1n)
              yield* writer.write(Xdr.uint32, 2)
              yield* writer.write(Xdr.opaque(), new Uint8Array([9]))
            })])
        )

        assert.strictEqual(yield* responseStatus(written), Status.OK)
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([0, 9, 0]))

        const closed = yield* handler.send(
          yield* call([sequence(session, 3), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.PUTFH)
              yield* writer.write(Xdr.opaque(), opened.filehandle)
            }), (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.CLOSE)
              yield* writer.write(Xdr.uint32, 0)
              yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
            })])
        )

        assert.strictEqual(yield* responseStatus(closed), Status.OK)
        assert.strictEqual(
          yield* responseStatus(
            yield* handler.send(
              yield* call([sequence(session, 4), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), opened.filehandle)
                }), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.WRITE)
                  yield* writer.write(Xdr.fixedOpaque(opened.stateid.length), opened.stateid)
                  yield* writer.write(Xdr.uint64, 0n)
                  yield* writer.write(Xdr.uint32, 2)
                  yield* writer.write(Xdr.opaque(), new Uint8Array([1]))
                })])
            )
          ),
          Status.BAD_STATEID
        )
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should reject an existing name without changing its contents or metadata when guarded creation is requested", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        yield* readCreate(
          yield* handler.send(
            yield* createCall(client, session, 1, "file", 1, [[33, (writer) => writer.write(Xdr.uint32, 0o600)]])
          )
        )
        yield* caller.writeFile("/file", new Uint8Array([4, 5]), {
          access: "write"
        })
        const before = yield* caller.stat("/file")
        assert.strictEqual(
          yield* responseStatus(
            yield* handler.send(
              yield* createCall(client, session, 2, "file", 1, [[4, (writer) => writer.write(Xdr.uint64, 0n)], [
                33,
                (writer) => writer.write(Xdr.uint32, 0o777)
              ]])
            )
          ),
          Status.EXIST
        )
        assert.deepStrictEqual(yield* caller.stat("/file"), before)
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4, 5]))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should ignore existing-file attributes except size zero truncation when an unchecked OPEN is requested", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        yield* caller.writeFile("/file", new Uint8Array([4, 5]), {
          access: "write",
          create: "exclusive",
          mode: 0o600
        })
        const initial = yield* caller.stat("/file")

        const first = yield* readCreate(
          yield* handler.send(
            yield* createCall(client, session, 1, "file", 0, [
              [4, (writer) => writer.write(Xdr.uint64, 8n)],
              [33, (writer) => writer.write(Xdr.uint32, 0o777)],
              [36, (writer) => writer.write(Xdr.string(), "12")],
              [37, (writer) => writer.write(Xdr.string(), "34")]
            ])
          )
        )

        assert.deepStrictEqual(first.attrs, [])
        assert.strictEqual(first.before, first.after)
        assert.deepStrictEqual(yield* caller.stat("/file"), initial)

        const truncated = yield* readCreate(
          yield* handler.send(
            yield* createCall(client, session, 2, "file", 0, [[4, (writer) => writer.write(Xdr.uint64, 0n)], [
              33,
              (writer) => writer.write(Xdr.uint32, 0o777)
            ]])
          )
        )

        assert.deepStrictEqual(truncated.attrs, [4])
        assert.deepStrictEqual(truncated.filehandle, first.filehandle)
        assert.strictEqual((yield* caller.stat("/file")).mode, 0o600)
        assert.strictEqual((yield* caller.stat("/file")).size, 0n)
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array())
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should recognize the verifier and reject another creation attempt when either exclusive mode is used", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        let seq = 1

        for (const mode of [2, 3]) {
          const name = `exclusive-${mode}`
          const attrs: Attributes = mode === 3 ? [[33, (writer) => writer.write(Xdr.uint32, 0o600)]] : []

          const first = yield* readCreate(
            yield* handler.send(yield* createCall(client, session, seq++, name, mode, attrs))
          )

          assert.deepStrictEqual(first.attrs, mode === 2 ? [47, 53] : [33, 47, 53])
          const metadata = yield* caller.stat(`/${name}`)

          const retry = yield* readCreate(
            yield* handler.send(
              yield* createCall(
                client,
                session,
                seq++,
                name,
                mode,
                mode === 3
                  ? [[33, (writer) => writer.write(Xdr.uint32, 0o777)]]
                  : []
              )
            )
          )

          assert.deepStrictEqual(retry.filehandle, first.filehandle)
          assert.deepStrictEqual(retry.attrs, [47, 53])
          assert.strictEqual(retry.before, retry.after)
          assert.deepStrictEqual(yield* caller.stat(`/${name}`), metadata)
          assert.strictEqual(
            yield* responseStatus(
              yield* handler.send(
                yield* createCall(client, session, seq++, name, mode, attrs, new Uint8Array(8).fill(18))
              )
            ),
            Status.EXIST
          )
        }
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should ignore unused initial attribute values when the named file already exists", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        yield* caller.writeFile("/file", new Uint8Array([4, 5]), {
          access: "write",
          create: "exclusive"
        })
        const initial = yield* caller.stat("/file")

        const unused: Attributes = [[33, (writer) => writer.write(Xdr.uint32, 0xffff_ffff)], [
          36,
          (writer) => writer.write(Xdr.string(), "unmapped@example.test")
        ]]

        const opened = yield* readCreate(
          yield* handler.send(yield* createCall(client, session, 1, "file", 0, unused))
        )

        assert.deepStrictEqual(opened.attrs, [])
        assert.deepStrictEqual(yield* caller.stat("/file"), initial)
        assert.strictEqual(
          yield* responseStatus(yield* handler.send(yield* createCall(client, session, 2, "file", 1, unused))),
          Status.EXIST
        )
        yield* readCreate(yield* handler.send(yield* createCall(client, session, 3, "exclusive", 3)))
        const exclusiveInitial = yield* caller.stat("/exclusive")

        const retry = yield* readCreate(
          yield* handler.send(yield* createCall(client, session, 4, "exclusive", 3, unused))
        )

        assert.deepStrictEqual(retry.attrs, [47, 53])
        assert.deepStrictEqual(yield* caller.stat("/exclusive"), exclusiveInitial)

        const unsupported: Attributes = [[35, (writer) => writer.write(Xdr.uint32, 1)]]
        yield* readCreate(yield* handler.send(yield* createCall(client, session, 5, "file", 0, unsupported)))
        assert.strictEqual(
          yield* responseStatus(yield* handler.send(yield* createCall(client, session, 6, "file", 1, unsupported))),
          Status.EXIST
        )
        yield* readCreate(
          yield* handler.send(
            yield* createCall(client, session, 7, "file", 0, [[
              33,
              (writer) => writer.write(Xdr.uint32, 0o10000)
            ]])
          )
        )
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4, 5]))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should reject timestamp setters before creating a file when EXCLUSIVE4_1 is used", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        for (const [index, attribute] of [48, 54].entries()) {
          assert.strictEqual(
            yield* responseStatus(
              yield* handler.send(
                yield* createCall(client, session, index + 1, "file", 3, [[
                  attribute,
                  (writer) =>
                    Effect.gen(function*() {
                      yield* writer.write(Xdr.uint32, 1)
                      yield* writer.write(Xdr.uint64, 1n)
                      yield* writer.write(Xdr.uint32, 0)
                    })
                ]])
              )
            ),
            Status.INVAL
          )
          assert.strictEqual((yield* Effect.flip(caller.stat("/file"))).code, "NotFound")
        }
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should advertise the EXCLUSIVE4_1 initial attributes without timestamp setters when GETATTR requests supported EXCLUSIVE4_1 attributes", () =>
      Effect.gen(function*() {
        const {
          handler,
          session
        } = yield* setup()

        const reader = yield* afterRoot(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.GETATTR)
                  yield* writeBitmap(writer, [75])
                })
            ])
          )
        )

        assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.GETATTR)
        assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
        assert.deepStrictEqual(yield* readBitmap(reader), [75])
        const attributes = replyReader(yield* reader.read(Xdr.opaque()))
        assert.deepStrictEqual(yield* readBitmap(attributes), [4, 33, 36, 37])
        yield* attributes.finish
        yield* reader.finish
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should reject unsupported initial attributes without leaving a directory entry when OPEN4_CREATE supplies an unsupported attribute", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        assert.strictEqual(
          yield* responseStatus(
            yield* handler.send(
              yield* createCall(client, session, 1, "file", 0, [[12, (writer) => writer.write(Xdr.uint32, 0)]])
            )
          ),
          Status.ATTRNOTSUPP
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/file"))).code, "NotFound")
        yield* readCreate(yield* handler.send(yield* createCall(client, session, 2, "file")))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should check share reservations before an unchecked open can truncate when an unchecked OPEN requests truncation against a share reservation", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        yield* caller.writeFile("/file", new Uint8Array([4, 5]), {
          access: "write",
          create: "exclusive"
        })
        yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(client, "file", 1, 2),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )
        assert.strictEqual(
          yield* responseStatus(
            yield* handler.send(
              yield* createCall(client, session, 2, "file", 0, [[4, (writer) => writer.write(Xdr.uint64, 0n)]])
            )
          ),
          Status.SHARE_DENIED
        )
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4, 5]))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should use the mapped caller's authority before creating or truncating when a mapped caller lacks creation or truncation authority", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume

        const caller = yield* Vfs.Caller

        yield* caller.writeFile("/file", new Uint8Array([4, 5]), {
          access: "write",
          create: "exclusive",
          mode: 0o600
        })

        const guest = yield* Testing.callerAs({
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        })

        const handler = yield* server(caller, volume, {
          mapped: guest
        })

        const {
          client,
          session
        } = yield* startSession(handler, "guest")

        assert.strictEqual(
          yield* responseStatus(yield* handler.send(yield* createCall(client, session, 1, "new"))),
          Status.ACCESS
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/new"))).code, "NotFound")
        assert.strictEqual(
          yield* responseStatus(
            yield* handler.send(
              yield* createCall(client, session, 2, "file", 0, [[4, (writer) => writer.write(Xdr.uint64, 0n)]])
            )
          ),
          Status.ACCESS
        )
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4, 5]))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should leave files unchanged when open-state capacity is exhausted", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup({
          maxOpens: 1
        })

        yield* readCreate(yield* handler.send(yield* createCall(client, session, 1, "held")))
        yield* caller.writeFile("/file", new Uint8Array([4]), {
          access: "write",
          create: "exclusive"
        })
        assert.strictEqual(
          yield* responseStatus(yield* handler.send(yield* createCall(client, session, 2, "new"))),
          Status.DELAY
        )
        assert.strictEqual(
          yield* responseStatus(
            yield* handler.send(
              yield* createCall(client, session, 3, "file", 0, [[4, (writer) => writer.write(Xdr.uint64, 0n)]])
            )
          ),
          Status.DELAY
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/new"))).code, "NotFound")
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4]))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should leave no file or open reservation when entry capacity is exhausted", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup({
          maxOpens: 1
        })

        yield* caller.writeFile("/occupied", new Uint8Array(), {
          access: "write",
          create: "exclusive"
        })
        assert.strictEqual(
          yield* responseStatus(yield* handler.send(yield* createCall(client, session, 1, "new"))),
          Status.NOSPC
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/new"))).code, "NotFound")
        yield* caller.unlink("/occupied")
        yield* readCreate(yield* handler.send(yield* createCall(client, session, 2, "new")))
      }).pipe(Effect.provide(Testing.layer({ volume: { maxEntries: 1 }, caller: { umask: 0 } }))))

    it.effect("should reject every creation mode and preserve existing data when the handler is read-only", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup({
          writable: false
        })

        yield* caller.writeFile("/file", new Uint8Array([4]), {
          access: "write",
          create: "exclusive"
        })

        for (const mode of [0, 1, 2, 3]) {
          assert.strictEqual(
            yield* responseStatus(yield* handler.send(yield* createCall(client, session, mode + 1, "new", mode))),
            Status.ROFS
          )
        }

        assert.strictEqual(
          yield* responseStatus(
            yield* handler.send(
              yield* createCall(client, session, 5, "file", 0, [[4, (writer) => writer.write(Xdr.uint64, 0n)]])
            )
          ),
          Status.ROFS
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/new"))).code, "NotFound")
        assert.deepStrictEqual(yield* caller.readFile("/file"), new Uint8Array([4]))
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should replay a cached reply and never reexecute an uncached creation request when a cached or uncached creation request is replayed", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          client,
          session
        } = yield* setup()

        const cached = yield* createCall(client, session, 1, "cached", 1)
        const first = yield* handler.send(cached)
        yield* readCreate(first)
        yield* caller.unlink("/cached")
        assert.deepStrictEqual(yield* handler.send(cached), first)
        assert.strictEqual((yield* Effect.flip(caller.stat("/cached"))).code, "NotFound")
        const uncached = yield* createCall(client, session, 2, "uncached", 1, [], undefined, false)
        yield* readCreate(yield* handler.send(uncached))
        yield* caller.unlink("/uncached")
        assert.strictEqual(yield* responseStatus(yield* handler.send(uncached)), Status.RETRY_UNCACHED_REP)
        assert.strictEqual((yield* Effect.flip(caller.stat("/uncached"))).code, "NotFound")
      }).pipe(Effect.provide(Testing.layer({ caller: { umask: 0 } }))))

    it.effect("should publish neither the file nor an open reservation when a commit is rejected", () => {
      let reject = true

      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          durability: "survives-power-loss",
          loadOrCreate: (initial) => Effect.succeed(initial),
          commit: () => Effect.succeed(reject ? "rejected" as const : "committed" as const)
        })
      )

      return Effect.gen(function*() {
        const volume = yield* LiveVolume.open(liveOptions)
        const caller = yield* volume.caller()

        const handler = yield* server(caller, volume, {
          maxOpens: 1
        })

        const {
          client,
          session
        } = yield* startSession(handler, "rejected-create")

        assert.strictEqual(
          yield* responseStatus(yield* handler.send(yield* createCall(client, session, 1, "file", 2))),
          Status.IO
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/file"))).code, "NotFound")
        reject = false
        yield* readCreate(yield* handler.send(yield* createCall(client, session, 2, "file", 2)))
      }).pipe(Effect.provide(store))
    })

    it.effect("should refuse success and block subsequent volume access when a commit outcome is unknown", () => {
      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          durability: "survives-power-loss",
          loadOrCreate: (initial) => Effect.succeed(initial),
          commit: () => Effect.succeed("unknown" as const)
        })
      )

      return Effect.gen(function*() {
        const volume = yield* LiveVolume.open(liveOptions)
        const caller = yield* volume.caller()
        const handler = yield* server(caller, volume)

        const {
          client,
          session
        } = yield* startSession(handler, "unknown-create")

        assert.strictEqual(
          yield* responseStatus(yield* handler.send(yield* createCall(client, session, 1, "file", 2))),
          Status.IO
        )
        assert.strictEqual((yield* Effect.flip(volume.usage)).code, "VolumeUnavailable")
        assert.strictEqual(
          yield* responseStatus(yield* handler.send(yield* createCall(client, session, 2, "other"))),
          Status.IO
        )
      }).pipe(Effect.provide(store))
    })

    it.effect("should recover the file and exclusive verifier together from the committed image when a committed image is reopened after exclusive creation", () => {
      let image: Uint8Array | undefined

      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          durability: "survives-power-loss",
          loadOrCreate: (initial) => Effect.sync(() => image ??= initial),
          commit: (candidate) =>
            Effect.sync(() => {
              image = candidate.slice()

              return "committed" as const
            })
        })
      )

      return Effect.gen(function*() {
        const inode = yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(liveOptions)
          const caller = yield* volume.caller()
          const handler = yield* server(caller, volume)

          const {
            client,
            session
          } = yield* startSession(handler, "before-restart")

          yield* readCreate(
            yield* handler.send(
              yield* createCall(client, session, 1, "file", 3, [[33, (writer) => writer.write(Xdr.uint32, 0o640)]])
            )
          )

          return (yield* caller.stat("/file")).ino
        }))

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(liveOptions)
          const caller = yield* volume.caller()
          const handler = yield* server(caller, volume)

          const {
            client,
            session
          } = yield* startSession(handler, "after-restart")

          const retry = yield* readCreate(
            yield* handler.send(
              yield* createCall(client, session, 1, "file", 3, [[33, (writer) => writer.write(Xdr.uint32, 0o777)]])
            )
          )

          const metadata = yield* caller.stat("/file")
          assert.strictEqual(metadata.ino, inode)
          assert.strictEqual(metadata.mode, 0o640)
          assert.strictEqual(retry.before, retry.after)
          assert.strictEqual(
            yield* responseStatus(
              yield* handler.send(yield* createCall(client, session, 2, "file", 3, [], new Uint8Array(8).fill(19)))
            ),
            Status.EXIST
          )
        }))
      }).pipe(Effect.provide(store))
    })

    it.effect("should wait for confirmed commit before returning a successful open when the store delays a creation commit", () =>
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const store = Layer.succeed(
          LiveVolume.LiveImageStore,
          LiveVolume.LiveImageStore.of({
            durability: "survives-power-loss",
            loadOrCreate: (initial) => Effect.succeed(initial),
            commit: Effect.fnUntraced(function*() {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)

              return "committed" as const
            })
          })
        )

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(liveOptions)
          const caller = yield* volume.caller()
          const handler = yield* server(caller, volume)

          const {
            client,
            session
          } = yield* startSession(handler, "held-create")

          const reply = yield* handler.send(yield* createCall(client, session, 1, "file", 2)).pipe(
            Effect.forkChild({
              startImmediately: true
            })
          )

          yield* Deferred.await(started)
          assert.strictEqual(reply.pollUnsafe(), undefined)
          yield* Deferred.succeed(release, undefined)
          yield* readCreate(yield* Fiber.join(reply))
          assert.strictEqual((yield* caller.stat("/file")).size, 0n)
        })).pipe(Effect.provide(store))
      }))

    it.effect("should apply an explicit mode exactly and reject undefined mode bits when a create requests explicit or undefined mode bits", () =>
      Effect.gen(function*() {
        const { caller, handler, client, session } = yield* setup()

        yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              simpleCreate(client, "exact", 0, 3, "owner", [[4, 0n], [33, 0o1666]]),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )
        assert.deepInclude(yield* caller.stat("/exact"), {
          mode: 0o1666
        })

        const invalid = yield* handler.send(
          yield* call([
            sequence(session, 2),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            simpleCreate(client, "invalid", 0, 3, "owner", [[33, 0o10000]])
          ])
        )

        assert.strictEqual(yield* responseStatus(invalid), Status.INVAL)
        assert.isTrue(Result.isFailure(yield* Effect.result(caller.stat("/invalid"))))
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should report a symbolic-link target as SYMLINK for ordinary create when ordinary create names a symbolic link", () =>
      Effect.gen(function*() {
        const { caller, handler, client, session } = yield* setup()
        yield* caller.symlink("target", "/link")

        const reply = yield* handler.send(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            simpleCreate(client, "link")
          ])
        )

        assert.strictEqual(yield* responseStatus(reply), Status.SYMLINK)
        assert.strictEqual(Result.isFailure(yield* Effect.result(caller.stat("/target"))), true)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should upgrade the same owner's create open and keep its stateid identity when the same owner upgrades a create OPEN", () =>
      Effect.gen(function*() {
        const { handler, client, session } = yield* setup()

        const first = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              simpleCreate(client, "upgrade", 0, 1),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        const second = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 2),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              simpleCreate(client, "upgrade", 0, 2),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        assert.deepStrictEqual(second.stateid.subarray(4), first.stateid.subarray(4))
        assert.deepStrictEqual(second.filehandle, first.filehandle)
        assert.strictEqual(new DataView(second.stateid.buffer, second.stateid.byteOffset).getUint32(0), 2)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should use the mapped caller's directory permission when a mapped caller lacks directory permission", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller

        const guest = yield* Testing.callerAs({
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        })

        const { handler, client, session } = yield* openWireSession(admin, "guest", {
          writable: true,
          mappedCaller: guest
        })

        const reply = yield* handler.send(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            simpleCreate(client, "forbidden")
          ])
        )

        assert.strictEqual(yield* responseStatus(reply), Status.ACCESS)
        assert.strictEqual(Result.isFailure(yield* Effect.result(admin.stat("/forbidden"))), true)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should refuse a create that names another owner for an unprivileged caller as not permitted when an unprivileged caller requests another owner", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller
        yield* admin.chmod(yield* admin.root, 0o777)

        const guest = yield* Testing.callerAs({
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        })

        const { handler, client, session } = yield* openWireSession(admin, "guest-owner", {
          writable: true,
          mappedCaller: guest
        })

        const foreign = yield* handler.send(
          yield* call([
            sequence(session, 1),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            simpleCreate(client, "foreign", 0, 3, "creator", [[36, 0]])
          ])
        )

        assert.strictEqual(yield* responseStatus(foreign), Status.PERM)
        assert.strictEqual(Result.isFailure(yield* Effect.result(admin.stat("/foreign"))), true)

        const own = yield* handler.send(
          yield* call([
            sequence(session, 2),
            (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
            simpleCreate(client, "own", 0, 3, "creator", [[36, 1000]])
          ])
        )

        assert.strictEqual(yield* responseStatus(own), Status.OK)
        assert.strictEqual((yield* admin.stat("/own")).uid, 1000)
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("Namespace over TCP", () => {
  const root = (writer: RequestWriter) => writer.write(Xdr.uint32, Operation.PUTROOTFH)

  const save = (writer: RequestWriter) => writer.write(Xdr.uint32, Operation.SAVEFH)

  const lookup = (name: string) => (writer: RequestWriter) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.LOOKUP)
      yield* writer.write(Xdr.string(), name)
    })

  const createDirectory = (name: string) => (writer: RequestWriter) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.CREATE)
      yield* writer.write(Xdr.uint32, 2)
      yield* writer.write(Xdr.string(), name)
      yield* writer.write(Xdr.uint32, 0)
      yield* writer.write(Xdr.opaque(), new Uint8Array())
    })

  const createSymlink = (name: string, target: string) => (writer: RequestWriter) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.CREATE)
      yield* writer.write(Xdr.uint32, 5)
      yield* writer.write(Xdr.string(), target)
      yield* writer.write(Xdr.string(), name)
      yield* writer.write(Xdr.uint32, 0)
      yield* writer.write(Xdr.opaque(), new Uint8Array())
    })

  const link = (name: string) => (writer: RequestWriter) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.LINK)
      yield* writer.write(Xdr.string(), name)
    })

  const remove = (name: string) => (writer: RequestWriter) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.REMOVE)
      yield* writer.write(Xdr.string(), name)
    })

  const rename = (from: string, to: string) => (writer: RequestWriter) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.RENAME)
      yield* writer.write(Xdr.string(), from)
      yield* writer.write(Xdr.string(), to)
    })

  const status = Effect.fnUntraced(function*(bytes: Uint8Array) {
    return yield* (replyReader(bytes)).read(Xdr.uint32)
  })

  const namespaceChange = Effect.fnUntraced(
    function*(bytes: Uint8Array, operation: number, prefix: ReadonlyArray<number>) {
      const reader = replyReader(bytes)
      assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
      yield* reader.read(Xdr.string())
      assert.strictEqual(yield* reader.read(Xdr.uint32), prefix.length + 2)
      assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SEQUENCE)
      assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
      yield* reader.read(Xdr.fixedOpaque(16))

      for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)

      for (const code of prefix) {
        assert.strictEqual(yield* reader.read(Xdr.uint32), code)
        assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
      }

      assert.strictEqual(yield* reader.read(Xdr.uint32), operation)
      assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)

      const readChange = Effect.fnUntraced(function*() {
        assert.isTrue(yield* reader.read(Xdr.boolean))
        const before = yield* reader.read(Xdr.uint64)
        const after = yield* reader.read(Xdr.uint64)
        assert.notStrictEqual(before, after)

        return {
          before,
          after
        }
      })

      const first = yield* readChange()
      const second = operation === Operation.RENAME ? yield* readChange() : undefined

      if (operation === Operation.CREATE) {
        assert.deepStrictEqual(yield* reader.read(Xdr.array(Xdr.uint32)), [])
      }

      yield* reader.finish

      return {
        first,
        second
      }
    }
  )

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should link and rename by saved and current handles while preserving inode identity when LINK and RENAME use saved and current filehandles", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/from")
        yield* caller.mkdir("/to")
        yield* caller.writeFile("/from/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const original = yield* caller.stat("/from/file")

        const { handler, session } = yield* openWireSession(caller, "namespace-move", {
          writable: true
        })

        assert.strictEqual(
          yield* status(
            yield* handler.send(
              yield* call([
                sequence(session, 1),
                root,
                lookup("from"),
                lookup("file"),
                save,
                root,
                lookup("to"),
                link("linked")
              ])
            )
          ),
          Status.OK
        )
        assert.strictEqual((yield* caller.stat("/to/linked")).ino, original.ino)
        assert.strictEqual(
          yield* status(
            yield* handler.send(
              yield* call([
                sequence(session, 2),
                root,
                lookup("from"),
                save,
                root,
                lookup("to"),
                rename("file", "moved")
              ])
            )
          ),
          Status.OK
        )
        assert.strictEqual((yield* caller.stat("/to/moved")).ino, original.ino)
        assert.strictEqual(
          yield* status(
            yield* handler.send(yield* call([sequence(session, 3), root, lookup("to"), remove("linked")]))
          ),
          Status.OK
        )
        assert.deepStrictEqual(yield* caller.readFile("/to/moved"), new Uint8Array([1]))
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should keep earlier compound mutations when a later operation fails", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openWireSession(caller, "namespace-partial", {
          writable: true
        })

        const reply = yield* handler.send(
          yield* call([sequence(session, 1), root, createDirectory("kept"), root, remove("missing")])
        )

        assert.strictEqual(yield* status(reply), Status.NOENT)
        assert.strictEqual((yield* caller.stat("/kept")).kind, "directory")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should report changes for links, directory removal, and replacement rename when LINK, REMOVE, and replacement RENAME change directories", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.mkdir("/from")
        yield* caller.mkdir("/to")
        yield* caller.mkdir("/to/empty")
        yield* caller.writeFile("/from/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        yield* caller.writeFile("/to/replaced", new Uint8Array([2]), {
          access: "write",
          create: "exclusive"
        })
        const original = yield* caller.stat("/from/file")
        const rootReference = yield* caller.root
        const fromReference = yield* caller.lookup(Vfs.Entry(rootReference, new TextEncoder().encode("from")))
        const toReference = yield* caller.lookup(Vfs.Entry(rootReference, new TextEncoder().encode("to")))

        const { handler, session } = yield* openWireSession(caller, "namespace-change", {
          writable: true
        })

        const beforeLink = (yield* caller.stat(toReference)).revision

        const linked = yield* namespaceChange(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              root,
              lookup("from"),
              lookup("file"),
              save,
              root,
              lookup("to"),
              link("alias")
            ])
          ),
          Operation.LINK,
          [
            Operation.PUTROOTFH,
            Operation.LOOKUP,
            Operation.LOOKUP,
            Operation.SAVEFH,
            Operation.PUTROOTFH,
            Operation.LOOKUP
          ]
        )

        assert.deepStrictEqual(linked.first, {
          before: beforeLink,
          after: (yield* caller.stat(toReference)).revision
        })
        assert.strictEqual((yield* caller.stat("/to/alias")).ino, original.ino)
        yield* namespaceChange(
          yield* handler.send(yield* call([sequence(session, 2), root, lookup("to"), remove("empty")])),
          Operation.REMOVE,
          [Operation.PUTROOTFH, Operation.LOOKUP]
        )
        assert.strictEqual((yield* Effect.flip(caller.stat("/to/empty"))).code, "NotFound")
        const beforeFrom = (yield* caller.stat(fromReference)).revision
        const beforeTo = (yield* caller.stat(toReference)).revision

        const renamed = yield* namespaceChange(
          yield* handler.send(
            yield* call([
              sequence(session, 3),
              root,
              lookup("from"),
              save,
              root,
              lookup("to"),
              rename("file", "replaced")
            ])
          ),
          Operation.RENAME,
          [Operation.PUTROOTFH, Operation.LOOKUP, Operation.SAVEFH, Operation.PUTROOTFH, Operation.LOOKUP]
        )

        assert.deepStrictEqual(renamed.first, {
          before: beforeFrom,
          after: (yield* caller.stat(fromReference)).revision
        })
        assert.deepStrictEqual(renamed.second, {
          before: beforeTo,
          after: (yield* caller.stat(toReference)).revision
        })
        assert.strictEqual((yield* caller.stat("/to/replaced")).ino, original.ino)
        assert.deepStrictEqual(yield* caller.readFile("/to/replaced"), new Uint8Array([1]))
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject invalid namespace operands when a namespace operand is invalid", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })
        const writable = yield* wireClient(caller, { writable: true })

        const {
          session
        } = yield* startSession(writable, "namespace-errors")

        assert.strictEqual(
          yield* status(yield* writable.send(yield* call([sequence(session, 1), root, remove("..")]))),
          Status.BADNAME
        )
        assert.strictEqual(
          yield* status(yield* writable.send(yield* call([sequence(session, 2), root, remove("")]))),
          Status.INVAL
        )
        assert.strictEqual(
          yield* status(yield* writable.send(yield* call([sequence(session, 3), root, remove("absent")]))),
          Status.NOENT
        )
        assert.strictEqual(
          yield* status(
            yield* writable.send(yield* call([sequence(session, 4), root, lookup("file"), remove("x")]))
          ),
          Status.NOTDIR
        )
        assert.strictEqual(
          yield* status(yield* writable.send(yield* call([sequence(session, 5), root, rename("file", "other")]))),
          Status.NOFILEHANDLE
        )
      }).pipe(Effect.provide(Testing.layer())))
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should refuse removing, moving or replacing another owner's entry in a sticky directory as ACCESS when a sticky directory entry belongs to another owner", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller
        yield* admin.chmod(yield* admin.root, 0o1777)
        yield* admin.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const guest = yield* Testing.callerAs({
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        })

        yield* guest.writeFile("/mine", new Uint8Array([2, 2]), {
          access: "write",
          create: "exclusive"
        })

        const { handler, session } = yield* openWireSession(admin, "namespace-sticky-denial", {
          writable: true,
          mappedCaller: guest
        })

        assert.deepStrictEqual(
          {
            remove: yield* status(yield* handler.send(yield* call([sequence(session, 1), root, remove("file")]))),
            moveSource: yield* status(
              yield* handler.send(yield* call([sequence(session, 2), root, save, root, rename("file", "moved")]))
            ),
            replaceTarget: yield* status(
              yield* handler.send(yield* call([sequence(session, 3), root, save, root, rename("mine", "file")]))
            )
          },
          {
            remove: Status.ACCESS,
            moveSource: Status.ACCESS,
            replaceTarget: Status.ACCESS
          }
        )
        assert.strictEqual((yield* admin.stat("/file")).size, 1n)
        assert.strictEqual((yield* admin.stat("/mine")).size, 2n)
        assert.strictEqual((yield* Effect.flip(admin.stat("/moved"))).code, "NotFound")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reopen an injected committed image with NFS namespace and metadata changes when a committed namespace image is reopened", () => {
      let image: Uint8Array | undefined

      const store = Layer.succeed(
        LiveVolume.LiveImageStore,
        LiveVolume.LiveImageStore.of({
          durability: "survives-power-loss",
          loadOrCreate: (initial) => Effect.sync(() => image ??= initial),
          commit: (candidate) =>
            Effect.sync(() => {
              image = candidate.slice()

              return "committed" as const
            })
        })
      )

      const options: LiveVolume.Options = {
        maxImageBytes: ByteSize.kilobytes(64),
        volume: {
          maxEntries: 16,
          maxBytes: ByteSize.bytes(64),
          maxFileBytes: ByteSize.bytes(32),
          maxPathBytes: ByteSize.bytes(255)
        }
      }

      return Effect.gen(function*() {
        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(options)
          const caller = yield* volume.caller()

          const { handler, session } = yield* openWireSession(caller, "namespace-live-before", {
            writable: true
          }).pipe(Effect.provideService(Vfs.Volume, volume))

          assert.strictEqual(
            yield* status(yield* handler.send(yield* call([sequence(session, 1), root, createDirectory("docs")]))),
            Status.OK
          )
          assert.strictEqual(
            yield* status(
              yield* handler.send(
                yield* call([sequence(session, 2), root, lookup("docs"), createSymlink("guide", "../target")])
              )
            ),
            Status.OK
          )
          assert.strictEqual(
            yield* status(
              yield* handler.send(
                yield* call([sequence(session, 3), root, lookup("docs"), (writer) =>
                  Effect.gen(function*() {
                    const values = requestWriter()
                    yield* values.write(Xdr.uint32, 0o750)
                    yield* writer.write(Xdr.uint32, Operation.SETATTR)
                    yield* writer.write(Xdr.fixedOpaque(16), new Uint8Array(16))
                    yield* writer.write(Xdr.array(Xdr.uint32), [0, 1 << 1])
                    yield* writer.write(Xdr.opaque(), yield* values.finish)
                  })])
              )
            ),
            Status.OK
          )
        }))
        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(options)
          const caller = yield* volume.caller()
          assert.strictEqual((yield* caller.stat("/docs")).mode, 0o750)
          assert.strictEqual(new TextDecoder().decode(yield* caller.readLink("/docs/guide")), "../target")
        }))
      }).pipe(Effect.provide(store))
    })
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should create a directory and symlink, reporting the directory change and retaining the created handle when CREATE makes a directory or symlink", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller

        const { handler, session } = yield* openWireSession(caller, "namespace-create", {
          writable: true
        })

        const response = replyReader(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              root,
              createDirectory("docs"),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
        yield* response.read(Xdr.string())
        assert.strictEqual(yield* response.read(Xdr.uint32), 4)
        assert.strictEqual(yield* response.read(Xdr.uint32), Operation.SEQUENCE)
        assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
        yield* response.read(Xdr.fixedOpaque(16))

        for (let field = 0; field < 5; field++) yield* response.read(Xdr.uint32)
        assert.strictEqual(yield* response.read(Xdr.uint32), Operation.PUTROOTFH)
        assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
        assert.strictEqual(yield* response.read(Xdr.uint32), Operation.CREATE)
        assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
        assert.strictEqual(yield* response.read(Xdr.boolean), true)
        assert.notStrictEqual(yield* response.read(Xdr.uint64), yield* response.read(Xdr.uint64))
        assert.deepStrictEqual(yield* response.read(Xdr.array(Xdr.uint32)), [])
        assert.strictEqual(yield* response.read(Xdr.uint32), Operation.GETFH)
        assert.strictEqual(yield* response.read(Xdr.uint32), Status.OK)
        const directoryHandle = yield* response.read(Xdr.opaque())
        assert.ok(directoryHandle.length > 0)
        yield* response.finish
        assert.strictEqual(
          yield* status(
            yield* handler.send(yield* call([sequence(session, 2), root, createSymlink("shortcut", "docs/guide")]))
          ),
          Status.OK
        )
        assert.strictEqual(new TextDecoder().decode(yield* caller.readLink("/shortcut")), "docs/guide")
        assert.strictEqual(
          yield* status(
            yield* handler.send(
              yield* call([sequence(session, 3), (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.PUTFH)
                  yield* writer.write(Xdr.opaque(), directoryHandle)
                }), createDirectory("nested")])
            )
          ),
          Status.OK
        )
        assert.strictEqual((yield* caller.stat("/docs/nested")).kind, "directory")
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should enforce the mapped caller's directory permissions for namespace changes when a mapped caller changes a directory", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller
        yield* admin.mkdir("/private", {
          mode: 0o700
        })
        yield* admin.writeFile("/private/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const guest = yield* Testing.callerAs({
          uid: 1000,
          gid: 1000,
          groups: [],
          privileged: false
        })

        const { handler, session } = yield* openWireSession(admin, "namespace-mapped-denial", {
          writable: true,
          mappedCaller: guest
        })

        assert.strictEqual(
          yield* status(yield* handler.send(yield* call([sequence(session, 1), root, createDirectory("blocked")]))),
          Status.ACCESS
        )
        assert.strictEqual(
          yield* status(yield* handler.send(yield* call([sequence(session, 2), root, remove("private")]))),
          Status.ACCESS
        )
        assert.strictEqual((yield* admin.stat("/private/file")).kind, "file")
        assert.strictEqual((yield* Effect.flip(admin.stat("/blocked"))).code, "NotFound")
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("Setattr over TCP", () => {
  type Attribute = readonly [number, WriteOperation]

  const bitmap = Effect.fnUntraced(function*(writer: RequestWriter, attributes: ReadonlyArray<number>) {
    const words = Array.from({
      length: attributes.length === 0 ? 0 : Math.floor(Math.max(...attributes) / 32) + 1
    }, () => 0)

    for (const attribute of attributes) words[Math.floor(attribute / 32)]! |= 1 << attribute % 32
    yield* writer.write(Xdr.uint32, words.length)

    for (const xdrValue of words) {
      yield* ((item, word) => item.write(Xdr.uint32, word >>> 0))(writer, xdrValue)
    }
  })

  const readBitmap = Effect.fnUntraced(function*(reader: ReplyReader) {
    return (yield* reader.read(Xdr.array(Xdr.uint32))).flatMap((word, index) =>
      Array.from({
        length: 32
      }, (_, bit) => index * 32 + bit).filter((attribute) => (word & 1 << attribute % 32) !== 0)
    )
  })

  const setattr =
    (attributes: ReadonlyArray<Attribute>, stateid: Uint8Array = new Uint8Array(16)) => (writer: RequestWriter) =>
      Effect.gen(function*() {
        yield* writer.write(Xdr.uint32, Operation.SETATTR)
        yield* writer.write(Xdr.fixedOpaque(stateid.length), stateid)
        yield* bitmap(writer, attributes.map(([attribute]) => attribute))
        const values = requestWriter()

        for (const [, write] of attributes) yield* write(values)
        yield* writer.write(Xdr.opaque(), yield* values.finish)
      })

  const setup = Effect.fnUntraced(function*(mapped = false, writable = true, mappedUid = 1000) {
    const caller = yield* Vfs.Caller
    yield* caller.writeFile("/file", new Uint8Array([1, 2]), {
      access: "write",
      create: "exclusive"
    })

    const guest = mapped ?
      yield* Testing.callerAs({
        uid: mappedUid,
        gid: 1000,
        groups: [1001],
        privileged: false
      }) :
      undefined

    if (guest !== undefined) {
      const reference = yield* caller.lookup(Vfs.Entry(yield* caller.root, new TextEncoder().encode("file")))
      yield* caller.chown(reference, {
        uid: 1000,
        gid: 1000
      })
    }

    const overrides = { writable }

    const { client, handler, session } = yield* openWireSession(
      caller,
      "setattr-client",
      guest === undefined ? overrides : { ...overrides, mappedCaller: guest }
    )

    return {
      caller,
      client,
      handler,
      session
    }
  })

  const run = Effect.fnUntraced(
    function*(
      handler: WireClient,
      session: Uint8Array,
      seq: number,
      attributes: ReadonlyArray<Attribute>,
      stateid?: Uint8Array
    ) {
      return yield* handler.send(
        yield* call([
          sequence(session, seq),
          (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(Xdr.uint32, Operation.LOOKUP)
              yield* writer.write(Xdr.string(), "file")
            }),
          setattr(attributes, stateid)
        ])
      )
    }
  )

  const result = Effect.fnUntraced(function*(bytes: Uint8Array) {
    const reader = replyReader(bytes)
    const status = yield* reader.read(Xdr.uint32)
    yield* reader.read(Xdr.string())
    assert.strictEqual(yield* reader.read(Xdr.uint32), 4)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SEQUENCE)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    yield* reader.read(Xdr.fixedOpaque(16))

    for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.PUTROOTFH)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.LOOKUP)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SETATTR)
    assert.strictEqual(yield* reader.read(Xdr.uint32), status)
    const attrsset = yield* readBitmap(reader)
    yield* reader.finish

    return {
      status,
      attrsset
    }
  })

  const readOwners = Effect.fnUntraced(function*(bytes: Uint8Array) {
    const reader = replyReader(bytes)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    yield* reader.read(Xdr.string())
    assert.strictEqual(yield* reader.read(Xdr.uint32), 4)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.SEQUENCE)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    yield* reader.read(Xdr.fixedOpaque(16))

    for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.PUTROOTFH)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.LOOKUP)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.GETATTR)
    assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
    assert.deepStrictEqual(yield* readBitmap(reader), [36, 37])
    const values = replyReader(yield* reader.read(Xdr.opaque()))
    const owners = [yield* values.read(Xdr.string()), yield* values.read(Xdr.string())]
    yield* values.finish
    yield* reader.finish

    return owners
  })

  const racingSetup = Effect.fnUntraced(function*(races: number) {
    const caller = yield* Vfs.Caller
    yield* caller.writeFile("/file", new Uint8Array([1, 2]), { access: "write", create: "exclusive" })
    yield* caller.chown("/file", { uid: 1000, gid: 1000 })
    yield* caller.chmod("/file", 0o755)
    let raced = 0

    const racing: Vfs.Caller = {
      ...caller,
      stat: (target) =>
        Effect.tap(caller.stat(target), (metadata) =>
          metadata.kind === "file" && raced < races
            ? caller.chown("/file", { uid: 2000 + raced++ })
            : Effect.void)
    }

    const { handler, session } = yield* openWireSession(caller, "setattr-client", {
      writable: true,
      mappedCaller: racing
    })

    return { caller, handler, session, raced: () => raced }
  })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should distinguish read-only attributes from unsupported attributes when SETATTR requests read-only or unsupported fields", () =>
      Effect.gen(function*() {
        const {
          handler,
          session
        } = yield* setup()

        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 1, [[1, (writer) => writer.write(Xdr.uint32, 1)]])),
          {
            status: Status.INVAL,
            attrsset: []
          }
        )
        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 2, [[63, (writer) => writer.write(Xdr.uint32, 1)]])),
          {
            status: Status.ATTRNOTSUPP,
            attrsset: []
          }
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should report mode and owner attributes applied through the mapped caller when a mapped caller sets mode and owner", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(Xdr.uint32, 0o640)], [
            36,
            (writer) => writer.write(Xdr.string(), "4294967295")
          ], [37, (writer) => writer.write(Xdr.string(), "0")]])
        )

        assert.deepStrictEqual(changed, {
          status: Status.OK,
          attrsset: [33, 36, 37]
        })
        assert.deepInclude(yield* caller.stat("/file"), {
          mode: 0o640,
          uid: 4294967295,
          gid: 0
        })
        assert.deepStrictEqual(
          yield* readOwners(
            yield* handler.send(
              yield* call([
                sequence(session, 2),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                    yield* writer.write(Xdr.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.GETATTR)
                    yield* writer.write(Xdr.uint32, [0, 1 << 4 | 1 << 5].length)

                    for (const xdrValue of [0, 1 << 4 | 1 << 5]) {
                      yield* ((item, word) => item.write(Xdr.uint32, word))(writer, xdrValue)
                    }
                  })
              ])
            )
          ),
          ["4294967295", "0"]
        )
        assert.deepStrictEqual(
          yield* result(
            yield* run(handler, session, 3, [[36, (writer) => writer.write(Xdr.string(), "0")], [
              37,
              (writer) => writer.write(Xdr.string(), "4294967295")
            ]])
          ),
          {
            status: Status.OK,
            attrsset: [36, 37]
          }
        )
        assert.deepInclude(yield* caller.stat("/file"), {
          uid: 0,
          gid: 4294967295
        })
        assert.deepStrictEqual(
          yield* readOwners(
            yield* handler.send(
              yield* call([
                sequence(session, 4),
                (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.LOOKUP)
                    yield* writer.write(Xdr.string(), "file")
                  }),
                (writer) =>
                  Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.GETATTR)
                    yield* writer.write(Xdr.uint32, [0, 1 << 4 | 1 << 5].length)

                    for (const xdrValue of [0, 1 << 4 | 1 << 5]) {
                      yield* ((item, word) => item.write(Xdr.uint32, word))(writer, xdrValue)
                    }
                  })
              ])
            )
          ),
          ["0", "4294967295"]
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject noncanonical owner strings without changing ownership when an owner string is noncanonical", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        const original = yield* caller.stat("/file")

        const invalid = [
          "",
          "00",
          "+1",
          "-1",
          " 1",
          "1 ",
          "1.0",
          "1e2",
          "alice",
          "alice@example.com",
          "4294967296",
          "999999999999999999999999999999999999"
        ]

        let seq = 1

        for (const value of invalid) {
          for (const attribute of [36, 37]) {
            const changed = yield* result(
              yield* run(handler, session, seq++, [[attribute, (writer) => writer.write(Xdr.string(), value)]])
            )

            assert.deepStrictEqual(changed, {
              status: Status.BADOWNER,
              attrsset: []
            })
          }
        }

        assert.strictEqual((yield* caller.stat("/file")).uid, original.uid)
        assert.strictEqual((yield* caller.stat("/file")).gid, original.gid)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject malformed timestamp selectors and nanoseconds before mutation when a timestamp selector or nanosecond value is malformed", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        const original = yield* caller.stat("/file")

        for (const attribute of [48, 54]) {
          for (
            const [index, write] of [
              (writer: RequestWriter) => writer.write(Xdr.uint32, 2),
              (writer: RequestWriter) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, 1)
                  yield* writer.write(Xdr.uint64, 1n)
                  yield* writer.write(Xdr.uint32, 1_000_000_000)
                })
            ].entries()
          ) {
            const response = yield* run(handler, session, (attribute === 48 ? 0 : 2) + index + 1, [[attribute, write]])
            assert.strictEqual(yield* (replyReader(response)).read(Xdr.uint32), Status.BADXDR)
          }
        }

        assert.deepInclude(yield* caller.stat("/file"), {
          atimeNs: original.atimeNs,
          mtimeNs: original.mtimeNs
        })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should map explicit and server-time timestamp setters to the correct metadata fields when explicit or server-time timestamps are requested", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        assert.deepStrictEqual(
          yield* result(
            yield* run(handler, session, 1, [[48, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, 1)
                yield* writer.write(Xdr.uint64, 12n)
                yield* writer.write(Xdr.uint32, 345)
              })], [54, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, 1)
                yield* writer.write(Xdr.uint64, 34n)
                yield* writer.write(Xdr.uint32, 567)
              })]])
          ),
          {
            status: Status.OK,
            attrsset: [48, 54]
          }
        )
        assert.deepInclude(yield* caller.stat("/file"), {
          atimeNs: 12_000_000_345n,
          mtimeNs: 34_000_000_567n
        })
        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 2, [[48, (writer) => writer.write(Xdr.uint32, 0)]])),
          {
            status: Status.OK,
            attrsset: [48]
          }
        )
        const after = yield* caller.stat("/file")
        assert.notStrictEqual(after.atimeNs, 12_000_000_345n)
        assert.strictEqual(after.mtimeNs, 34_000_000_567n)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should let a mapped non-owner writer set both timestamps to server time when a mapped non-owner writer requests server time", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true)

        const reference = yield* caller.lookup(Vfs.Entry(yield* caller.root, new TextEncoder().encode("file")))
        yield* caller.chown(reference, {
          uid: 2000,
          gid: 2000
        })
        yield* caller.chmod(reference, 0o666)
        assert.deepStrictEqual(
          yield* result(
            yield* run(handler, session, 1, [[48, (writer) => writer.write(Xdr.uint32, 0)], [
              54,
              (writer) => writer.write(Xdr.uint32, 0)
            ]])
          ),
          {
            status: Status.OK,
            attrsset: [48, 54]
          }
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should require a writable open stateid for size and refuse conflicting share denial when size changes lack a writable stateid or conflict with share denial", () =>
      Effect.gen(function*() {
        const {
          caller,
          client,
          handler,
          session
        } = yield* setup()

        const size = [[4, (writer: RequestWriter) => writer.write(Xdr.uint64, 5n)]] as const
        assert.deepStrictEqual(yield* result(yield* run(handler, session, 1, size)), {
          status: Status.BAD_STATEID,
          attrsset: []
        })

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 2),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(client, "file", 2),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        assert.deepStrictEqual(yield* result(yield* run(handler, session, 3, size, opened.stateid)), {
          status: Status.OK,
          attrsset: [4]
        })
        assert.strictEqual((yield* caller.stat("/file")).size, 5n)
        const invalid = new Uint8Array(opened.stateid)
        invalid[15] = invalid[15]! ^ 1
        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 4, [[4, (writer) => writer.write(Xdr.uint64, 6n)]], invalid)),
          {
            status: Status.BAD_STATEID,
            attrsset: []
          }
        )
        assert.strictEqual((yield* caller.stat("/file")).size, 5n)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should refuse size changes while a write-denying open exists when another OPEN denies writes", () =>
      Effect.gen(function*() {
        const {
          caller,
          client,
          handler,
          session
        } = yield* setup()

        const opened = yield* parseOpen(
          yield* handler.send(
            yield* call([
              sequence(session, 1),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              openByName(client, "file", 2, 2),
              (writer) => writer.write(Xdr.uint32, Operation.GETFH)
            ])
          )
        )

        assert.deepStrictEqual(
          yield* result(
            yield* run(handler, session, 2, [[4, (writer) => writer.write(Xdr.uint64, 5n)]], opened.stateid)
          ),
          {
            status: Status.SHARE_DENIED,
            attrsset: []
          }
        )
        assert.strictEqual((yield* caller.stat("/file")).size, 2n)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should apply no attribute and report none when a later ownership change is denied", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true)

        const before = yield* caller.stat("/file")

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(Xdr.uint32, 0o640)], [
            36,
            (writer) => writer.write(Xdr.string(), "2000")
          ]])
        )

        assert.deepStrictEqual(changed, {
          status: Status.PERM,
          attrsset: []
        })
        assert.deepInclude(yield* caller.stat("/file"), {
          mode: before.mode,
          uid: 1000
        })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should clear setuid from a mode sent with an owner change, as knfsd does, under one change when mode and owner change together on a file", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        const volume = yield* Vfs.Volume
        const changes = yield* Testing.collectChanges(yield* volume.watch(), 2)
        const before = yield* caller.stat("/file")

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(Xdr.uint32, 0o6745)], [
            36,
            (writer) => writer.write(Xdr.string(), "7")
          ], [37, (writer) => writer.write(Xdr.string(), "7")]])
        )

        yield* caller.mkdir("/done")

        assert.deepStrictEqual(changed, {
          status: Status.OK,
          attrsset: [33, 36, 37]
        })
        // Without group execute, setgid marks mandatory locking rather than privilege, and knfsd keeps it.
        assert.deepInclude(yield* caller.stat("/file"), {
          mode: 0o2745,
          uid: 7,
          gid: 7,
          revision: before.revision + 1n
        })
        assert.deepStrictEqual((yield* changes).map((change) => change._tag), ["Update", "Create"])
      }).pipe(Effect.scoped, Effect.provide(Testing.layer())))

    it.effect("should clear setgid too from a group-executable mode sent with a group change when group changes with a group-executable mode", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(Xdr.uint32, 0o6755)], [
            37,
            (writer) => writer.write(Xdr.string(), "7")
          ]])
        )

        assert.deepStrictEqual(changed, {
          status: Status.OK,
          attrsset: [33, 37]
        })
        assert.deepInclude(yield* caller.stat("/file"), { mode: 0o755, gid: 7 })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should keep a set-ID mode sent with an owner change on a directory, as knfsd does when owner changes with set-ID mode on a directory", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup()

        yield* caller.unlink("/file")
        yield* caller.mkdir("/file")

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(Xdr.uint32, 0o2755)], [
            36,
            (writer) => writer.write(Xdr.string(), "7")
          ]])
        )

        assert.deepStrictEqual(changed, {
          status: Status.OK,
          attrsset: [33, 36]
        })
        assert.deepInclude(yield* caller.stat("/file"), { mode: 0o2755, uid: 7 })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should accept an owner re-sending a group it is not a member of when the group is unchanged, as knfsd does", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true)

        yield* caller.chown("/file", { gid: 2000 })
        const before = yield* caller.stat("/file")

        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 1, [[37, (writer) => writer.write(Xdr.string(), "2000")]])),
          {
            status: Status.OK,
            attrsset: [37]
          }
        )
        assert.deepInclude(yield* caller.stat("/file"), { gid: 2000, revision: before.revision })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should refuse an unchanged owner or group when the caller does not own the file", () =>
      Effect.gen(function*() {
        const {
          handler,
          session
        } = yield* setup(true, true, 1002)

        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 1, [[36, (writer) => writer.write(Xdr.string(), "1000")]])),
          {
            status: Status.PERM,
            attrsset: []
          }
        )
        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 2, [[37, (writer) => writer.write(Xdr.string(), "1000")]])),
          {
            status: Status.PERM,
            attrsset: []
          }
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should keep a set-ID mode sent with the owner the file already has, as knfsd does when the owner is resent unchanged with set-ID mode", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true)

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(Xdr.uint32, 0o4755)], [
            36,
            (writer) => writer.write(Xdr.string(), "1000")
          ]])
        )

        assert.deepStrictEqual(changed, {
          status: Status.OK,
          attrsset: [33, 36]
        })
        assert.deepInclude(yield* caller.stat("/file"), { mode: 0o4755, uid: 1000 })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should clear set-ID bits when the group changes even though the owner sent is unchanged", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true)

        const changed = yield* result(
          yield* run(handler, session, 1, [
            [33, (writer) => writer.write(Xdr.uint32, 0o6755)],
            [36, (writer) => writer.write(Xdr.string(), "1000")],
            [37, (writer) => writer.write(Xdr.string(), "1001")]
          ])
        )

        assert.deepStrictEqual(changed, {
          status: Status.OK,
          attrsset: [33, 36, 37]
        })
        assert.deepInclude(yield* caller.stat("/file"), { mode: 0o755, uid: 1000, gid: 1001 })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should let an owner select a supplementary group but reject another group when an owner selects a supplementary or foreign group", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true)

        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 1, [[37, (writer) => writer.write(Xdr.string(), "1000")]])),
          {
            status: Status.OK,
            attrsset: [37]
          }
        )
        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 2, [[37, (writer) => writer.write(Xdr.string(), "1001")]])),
          {
            status: Status.OK,
            attrsset: [37]
          }
        )
        assert.strictEqual((yield* caller.stat("/file")).gid, 1001)
        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 3, [[37, (writer) => writer.write(Xdr.string(), "1002")]])),
          {
            status: Status.PERM,
            attrsset: []
          }
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should refuse a mode change by a caller that does not own the file as not permitted when a non-owner requests a mode change", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true, true, 1002)

        const before = (yield* caller.stat("/file")).mode

        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 1, [[33, (writer) => writer.write(Xdr.uint32, 0o600)]])),
          {
            status: Status.PERM,
            attrsset: []
          }
        )
        assert.strictEqual((yield* caller.stat("/file")).mode, before)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should refuse explicit timestamps from a caller that does not own the file as not permitted when a non-owner requests explicit timestamps", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true, true, 1002)

        const before = (yield* caller.stat("/file")).mtimeNs

        assert.deepStrictEqual(
          yield* result(
            yield* run(handler, session, 1, [[54, (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, 1)
                yield* writer.write(Xdr.uint64, 34n)
                yield* writer.write(Xdr.uint32, 567)
              })]])
          ),
          {
            status: Status.PERM,
            attrsset: []
          }
        )
        assert.strictEqual((yield* caller.stat("/file")).mtimeNs, before)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should not treat an unprivileged mapped UID zero as the file owner when UID zero is mapped without privilege", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(true, true, 0)

        assert.deepStrictEqual(
          yield* result(yield* run(handler, session, 1, [[36, (writer) => writer.write(Xdr.string(), "0")]])),
          {
            status: Status.PERM,
            attrsset: []
          }
        )
        assert.strictEqual((yield* caller.stat("/file")).uid, 1000)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should keep a read-only export immutable when SETATTR reaches a read-only export", () =>
      Effect.gen(function*() {
        const {
          caller,
          handler,
          session
        } = yield* setup(false, false)

        const response = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(Xdr.uint32, 0o600)]])
        )

        assert.deepStrictEqual(response, {
          status: Status.ROFS,
          attrsset: []
        })
        assert.notStrictEqual((yield* caller.stat("/file")).mode, 0o600)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should clear setuid when another client changes the owner mid-SETATTR", () =>
      Effect.gen(function*() {
        const { caller, handler, session } = yield* racingSetup(1)

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(Xdr.uint32, 0o4755)], [
            36,
            (writer) => writer.write(Xdr.string(), "1000")
          ]])
        )

        assert.deepStrictEqual(changed, { status: Status.OK, attrsset: [33, 36] })
        // The owner moved to 2000 after the first observation, so 1000 is a real change and knfsd clears setuid.
        assert.deepInclude(yield* caller.stat("/file"), { uid: 1000, mode: 0o755 })
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should answer DELAY and apply nothing when the owner keeps moving under SETATTR", () =>
      Effect.gen(function*() {
        const { caller, handler, session, raced } = yield* racingSetup(Number.POSITIVE_INFINITY)

        const changed = yield* result(
          yield* run(handler, session, 1, [[33, (writer) => writer.write(Xdr.uint32, 0o4755)], [
            36,
            (writer) => writer.write(Xdr.string(), "1000")
          ]])
        )

        assert.deepStrictEqual(changed, { status: Status.DELAY, attrsset: [] })
        // One observation and three re-observations, each overtaken by a chown.
        assert.strictEqual(raced(), 4)
        assert.deepInclude(yield* caller.stat("/file"), { uid: 2003, mode: 0o755 })
      }).pipe(Effect.provide(Testing.layer())))
  })
})

const ACCESS_ALL = 0x3f

const sys = (uid: number, gid: number, groups: ReadonlyArray<number> = []): Credentials => ({
  _tag: "Sys",
  stamp: 0,
  machineName: "probe",
  uid,
  gid,
  supplementaryGroups: groups
})

const callAs = (
  credentials: Credentials,
  operations: ReadonlyArray<(writer: RequestWriter) => Effect.Effect<void>>
) => Effect.map(call(operations), (request) => ({ ...request, credentials }))

const fattr = Effect.fnUntraced(
  function*(
    writer: RequestWriter,
    attribute: number,
    value: (values: RequestWriter) => Effect.Effect<void>
  ) {
    const values = requestWriter()
    yield* value(values)
    const words = Array.from<number>({ length: Math.floor(attribute / 32) + 1 }).fill(0)
    words[Math.floor(attribute / 32)] = 1 << attribute % 32 >>> 0
    yield* writer.write(Xdr.array(Xdr.uint32), words)
    yield* writer.write(Xdr.opaque(), yield* values.finish)
  }
)

describe("Backchannel over TCP", () => {
  const connectionHandler = Effect.flatMap(Vfs.Caller, (caller) => wireClient(caller))

  const destroySession = (id: Uint8Array) => (writer: RequestWriter) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.DESTROY_SESSION)
      yield* writer.write(Xdr.fixedOpaque(id.length), id)
    })

  const bindToSession = (id: Uint8Array) => (writer: RequestWriter) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.BIND_CONN_TO_SESSION)
      yield* writer.write(Xdr.fixedOpaque(id.length), id)
      yield* writer.write(Xdr.uint32, 1)
      yield* writer.write(Xdr.boolean, false)
    })

  const backChannelHandler = Effect.flatMap(Vfs.Caller, (caller) => wireClient(caller))

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should associate a connection that only ever carried a SEQUENCE when a connection carries only SEQUENCE", () =>
      Effect.gen(function*() {
        const handler = yield* connectionHandler
        const owner = connection(1)
        const bySequence = connection(2)

        const {
          session
        } = yield* startSession(handler, "associate", {}, new Uint8Array(8), owner)

        // Before any SEQUENCE this connection is a stranger to the session.
        assert.deepStrictEqual(
          (yield* statuses(yield* handler.send(yield* call([destroySession(session)], "probe", bySequence))))
            .operations,
          [[Operation.DESTROY_SESSION, Status.CONN_NOT_BOUND_TO_SESSION]]
        )

        // Section 2.10.3.1: under SP4_NONE the SEQUENCE itself associates it.
        assert.strictEqual(
          (yield* statuses(yield* handler.send(yield* call([sequence(session, 1)], "probe", bySequence)))).status,
          Status.OK
        )
        assert.deepStrictEqual(
          (yield* statuses(yield* handler.send(yield* call([destroySession(session)], "probe", bySequence))))
            .operations,
          [[Operation.DESTROY_SESSION, Status.OK]]
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should let a connection associated only by BIND_CONN_TO_SESSION destroy the session when BIND_CONN_TO_SESSION associates a connection", () =>
      Effect.gen(function*() {
        const handler = yield* connectionHandler
        const owner = connection(1)
        const byBind = connection(3)

        const {
          session
        } = yield* startSession(handler, "bind-assoc", {}, new Uint8Array(8), owner)

        // Before binding, the connection is a stranger.
        assert.deepStrictEqual(
          (yield* statuses(yield* handler.send(yield* call([destroySession(session)], "probe", byBind))))
            .operations,
          [[Operation.DESTROY_SESSION, Status.CONN_NOT_BOUND_TO_SESSION]]
        )
        assert.strictEqual(
          (yield* statuses(yield* handler.send(yield* call([bindToSession(session)], "probe", byBind)))).status,
          Status.OK
        )

        // Section 18.34.3 binding is what makes the connection eligible.
        assert.deepStrictEqual(
          (yield* statuses(yield* handler.send(yield* call([destroySession(session)], "probe", byBind))))
            .operations,
          [[Operation.DESTROY_SESSION, Status.OK]]
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should associate a reconnecting client that retransmits a cached SEQUENCE when a reconnecting client retransmits a cached SEQUENCE", () =>
      Effect.gen(function*() {
        const handler = yield* connectionHandler
        const owner = connection(1)
        const reconnected = connection(5)

        const {
          session
        } = yield* startSession(handler, "replay", {}, new Uint8Array(8), owner)

        const cached = yield* call(
          [sequence(session, 1, true), (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)],
          "replay",
          owner
        )

        assert.strictEqual((yield* statuses(yield* handler.send(cached))).status, Status.OK)

        // The same bytes arriving on a new connection hit the reply cache and never reach the
        // SEQUENCE handler, but Section 2.10.3.1 still associates the connection.
        const retransmitted = yield* call(
          [sequence(session, 1, true), (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH)],
          "replay",
          reconnected
        )

        assert.strictEqual((yield* statuses(yield* handler.send(retransmitted))).status, Status.OK)
        assert.deepStrictEqual(
          (yield* statuses(yield* handler.send(yield* call([destroySession(session)], "probe", reconnected))))
            .operations,
          [[Operation.DESTROY_SESSION, Status.OK]]
        )
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should give one client id to several connections and serve a session on each when several connections serve one client session", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler
        const first = connection(1)
        const second = connection(2)

        const identify = Effect.fnUntraced(function*(on: typeof first) {
          const reply = replyReader(yield* handler.send(yield* call([ownerExchange("trunked")], "probe", on)))

          assert.strictEqual(yield* reply.read(Xdr.uint32), Status.OK)
          yield* reply.read(Xdr.string())
          yield* reply.read(Xdr.uint32)
          yield* reply.read(Xdr.uint32)
          yield* reply.read(Xdr.uint32)
          const id = yield* reply.read(Xdr.uint64)
          yield* reply.read(Xdr.uint32)

          return {
            id,
            flags: yield* reply.read(Xdr.uint32)
          }
        })

        // Section 18.35.4 case 4: a second EXCHANGE_ID against an UNCONFIRMED record replaces it
        // and issues a new client ID, so trunking cannot be detected until the record is confirmed.
        const unconfirmed = yield* identify(first)
        const replaced = yield* identify(first)
        assert.notStrictEqual(replaced.id, unconfirmed.id)

        // CREATE_SESSION confirms the record.
        const session = replyReader(
          yield* handler.send(
            yield* call(
              [(writer) =>
                Effect.gen(function*() {
                  yield* Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
                    yield* writer.write(Xdr.uint64, replaced.id)
                    yield* writer.write(Xdr.uint32, 1)
                    yield* writer.write(Xdr.uint32, 0)
                  })
                  yield* channel(writer, 2)
                  yield* channel(writer, 0)
                  yield* Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, 0)
                    yield* writer.write(Xdr.uint32, 0)
                  })
                })],
              "probe",
              first
            )
          )
        )

        assert.strictEqual(yield* session.read(Xdr.uint32), Status.OK)
        yield* session.read(Xdr.string())
        yield* session.read(Xdr.uint32)
        yield* session.read(Xdr.uint32)
        yield* session.read(Xdr.uint32)
        const sessionOne = yield* session.read(Xdr.fixedOpaque(16))

        // Section 18.35.4 case 2 and Section 2.10.5 client-ID trunking: the same co_ownerid,
        // verifier, and principal arriving over another connection resolve to the same confirmed
        // client ID, and CONFIRMED_R must be set so the client knows it may trunk.
        const trunked = yield* identify(second)
        assert.strictEqual(trunked.id, replaced.id, "one client ID across both connections")
        // The bitwise AND is signed in JavaScript, so compare the shifted bit rather than the mask.
        assert.strictEqual((trunked.flags & 0x8000_0000) !== 0, true, "EXCHGID4_FLAG_CONFIRMED_R")

        // A second session for that one client ID, created over the second connection.
        const other = replyReader(
          yield* handler.send(
            yield* call(
              [(writer) =>
                Effect.gen(function*() {
                  yield* Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
                    yield* writer.write(Xdr.uint64, replaced.id)
                    yield* writer.write(Xdr.uint32, 2)
                    yield* writer.write(Xdr.uint32, 0)
                  })
                  yield* channel(writer, 2)
                  yield* channel(writer, 0)
                  yield* Effect.gen(function*() {
                    yield* writer.write(Xdr.uint32, 0)
                    yield* writer.write(Xdr.uint32, 0)
                  })
                })],
              "probe",
              second
            )
          )
        )

        assert.strictEqual(yield* other.read(Xdr.uint32), Status.OK)
        yield* other.read(Xdr.string())
        yield* other.read(Xdr.uint32)
        yield* other.read(Xdr.uint32)
        yield* other.read(Xdr.uint32)
        const sessionTwo = yield* other.read(Xdr.fixedOpaque(16))
        assert.notDeepEqual(sessionOne, sessionTwo, "distinct sessions on one client ID")

        for (const [id, on] of [[sessionOne, first], [sessionTwo, second]] as const) {
          assert.strictEqual(
            (yield* statuses(yield* handler.send(yield* call([sequence(id, 1)], "probe", on)))).status,
            Status.OK
          )
        }
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should reject a requested backchannel that offers no slots when a requested backchannel has no slots", () =>
      Effect.gen(function*() {
        const handler = yield* backChannelHandler
        const client = connection(1)

        const reply = replyReader(yield* handler.send(yield* call([ownerExchange("noslots")], "probe", client)))

        yield* reply.read(Xdr.uint32)
        yield* reply.read(Xdr.string())

        for (let field = 0; field < 3; field++) yield* reply.read(Xdr.uint32)
        const clientId = yield* reply.read(Xdr.uint64)

        // CONN_BACK_CHAN with ca_maxrequests zero: a backchannel that can carry nothing. Section
        // 18.36.3 forbids changing ca_maxrequests, so it cannot be rounded up either.
        const created = yield* handler.send(
          yield* call(
            [(writer) =>
              Effect.gen(function*() {
                yield* Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.CREATE_SESSION)
                  yield* writer.write(Xdr.uint64, clientId)
                  yield* writer.write(Xdr.uint32, 1)
                  yield* writer.write(Xdr.uint32, 2)
                })
                yield* channel(writer, 2)
                yield* channel(writer, 0)
                yield* Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, callbackProgram)
                  yield* writer.write(Xdr.uint32, [0].length)

                  for (const xdrValue of [0]) {
                    yield* ((item, flavor) =>
                      Effect.gen(function*() {
                        const xdrWriter = item
                        yield* xdrWriter.write(Xdr.uint32, flavor)
                      }))(writer, xdrValue)
                  }
                })
              })],
            "probe",
            client
          )
        )

        assert.deepStrictEqual((yield* statuses(created)).operations, [[Operation.CREATE_SESSION, Status.TOOSMALL]])
      }).pipe(Effect.provide(Testing.layer())))
  })
})

describe("Filehandles over TCP", () => {
  const FH_EXPIRE_TYPE = 2

  const UNIQUE_HANDLES = 9

  const PUTFH_ERRORS: ReadonlyArray<number> = [
    Status.BADHANDLE,
    Status.DELAY,
    Status.FHEXPIRED,
    Status.SERVERFAULT,
    Status.STALE
  ]

  const liveOptions: LiveVolume.Options = {
    maxImageBytes: ByteSize.kilobytes(64),
    volume: {
      maxEntries: 16,
      maxBytes: ByteSize.bytes(64),
      maxFileBytes: ByteSize.bytes(32),
      maxPathBytes: ByteSize.bytes(255)
    }
  }

  const durableStore = () => {
    let image: Uint8Array | undefined

    return Layer.succeed(
      LiveVolume.LiveImageStore,
      LiveVolume.LiveImageStore.of({
        durability: "survives-power-loss",
        loadOrCreate: (initial) => Effect.sync(() => image ??= initial),
        commit: (candidate) =>
          Effect.sync(() => {
            image = candidate.slice()

            return "committed" as const
          })
      })
    )
  }

  const putfh = (filehandle: Uint8Array): WriteOperation => (writer) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.PUTFH)
      yield* writer.write(Xdr.opaque(), filehandle)
    })

  const getfh: WriteOperation = (writer) => writer.write(Xdr.uint32, Operation.GETFH)

  const op = (code: number): WriteOperation => (writer) => writer.write(Xdr.uint32, code)

  const remove = (name: string): WriteOperation => (writer) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.REMOVE)
      yield* writer.write(Xdr.string(), name)
    })

  const getattr = (...attributes: ReadonlyArray<number>): WriteOperation => (writer) =>
    Effect.gen(function*() {
      const words = [0, 0]

      for (const attribute of attributes) words[attribute >> 5]! |= 1 << (attribute & 31)
      yield* writer.write(Xdr.uint32, Operation.GETATTR)
      yield* writer.write(Xdr.array(Xdr.uint32), words)
    })

  const read: WriteOperation = Effect.fnUntraced(function*(writer) {
    yield* writer.write(Xdr.uint32, Operation.READ)
    yield* writer.write(Xdr.fixedOpaque(16), new Uint8Array(16))
    yield* writer.write(Xdr.uint64, 0n)
    yield* writer.write(Xdr.uint32, 16)
  })

  const replyStatuses = Effect.fnUntraced(function*(response: Uint8Array) {
    const reader = replyReader(response)
    yield* reader.read(Xdr.uint32)
    yield* reader.read(Xdr.string())
    const count = yield* reader.read(Xdr.uint32)
    const result: Array<number> = []

    for (let index = 0; index < count; index++) {
      const code = yield* reader.read(Xdr.uint32)
      const status = yield* reader.read(Xdr.uint32)
      result.push(status)

      if (status !== Status.OK) break

      if (code === Operation.SEQUENCE) {
        yield* reader.read(Xdr.fixedOpaque(16))

        for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
      }

      // change_info4: atomic, before, after.
      if (code === Operation.REMOVE) {
        yield* reader.read(Xdr.boolean)
        yield* reader.read(Xdr.uint64)
        yield* reader.read(Xdr.uint64)
      }
    }

    return result
  })

  const serve = Effect.fnUntraced(
    function*(volume: Vfs.Volume, owner: string, serverGeneration = new Uint8Array(16).fill(7)) {
      const handler = yield* wireClient(yield* volume.caller(), { generation: serverGeneration }).pipe(
        Effect.provideService(Vfs.Volume, volume)
      )

      const { session } = yield* startSession(handler, owner)
      // Each compound takes the slot's next sequence id; repeating one would replay the cached reply.
      let sequenceId = 0

      const compound = Effect.fnUntraced(function*(operations: ReadonlyArray<WriteOperation>) {
        return yield* handler.send(yield* call([sequence(session, ++sequenceId), ...operations]))
      })

      // The status PUTFH answers for `filehandle`, followed by GETFH so a resolved handle is re-encoded.
      const put = Effect.fnUntraced(function*(filehandle: Uint8Array) {
        const reply = yield* statuses(yield* compound([putfh(filehandle), getfh]))

        return reply.operations[1]![1]
      })

      // The root's fh_expire_type attribute, read beside unique_handles so neither can take the other's place.
      const expireType = Effect.gen(function*() {
        const reader = replyReader(
          yield* handler.send(
            yield* call([
              sequence(session, ++sequenceId),
              (writer) => writer.write(Xdr.uint32, Operation.PUTROOTFH),
              (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(Xdr.uint32, Operation.GETATTR)
                  yield* writer.write(Xdr.array(Xdr.uint32), [(1 << FH_EXPIRE_TYPE) | (1 << UNIQUE_HANDLES)])
                })
            ])
          )
        )

        assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
        yield* reader.read(Xdr.string())
        yield* reader.read(Xdr.uint32)
        yield* reader.read(Xdr.uint32)
        yield* reader.read(Xdr.uint32)
        yield* reader.read(Xdr.fixedOpaque(16))

        for (let field = 0; field < 5; field++) yield* reader.read(Xdr.uint32)
        yield* reader.read(Xdr.uint32)
        yield* reader.read(Xdr.uint32)
        assert.strictEqual(yield* reader.read(Xdr.uint32), Operation.GETATTR)
        assert.strictEqual(yield* reader.read(Xdr.uint32), Status.OK)
        yield* reader.read(Xdr.array(Xdr.uint32))
        const values = replyReader(yield* reader.read(Xdr.opaque()))

        const expire = yield* values.read(Xdr.uint32)
        assert.isTrue(yield* values.read(Xdr.boolean), "unique_handles")

        return expire
      })

      return {
        handler,
        session,
        compound,
        put,
        expireType,
        handleAt: (path: string) => lookupHandle(handler, session, ++sequenceId, path)
      }
    }
  )

  const lookupHandle = Effect.fnUntraced(
    function*(handler: WireClient, session: Uint8Array, sequenceId: number, path: string) {
      const result = yield* decodeCompound(
        yield* handler.send(
          yield* call([
            sequence(session, sequenceId),
            op(Operation.PUTROOTFH),
            ...path.split("/").filter(Boolean).map(lookupName),
            getfh
          ])
        )
      )

      assert.strictEqual(result.status, Status.OK)
      const handle = result.operations.at(-1)?.value
      assert.instanceOf(handle, Uint8Array)

      return handle
    }
  )

  const lookupName = (name: string): WriteOperation => (writer) =>
    Effect.gen(function*() {
      yield* writer.write(Xdr.uint32, Operation.LOOKUP)
      yield* writer.write(Xdr.string(), name)
    })

  it.layer(NodeCrypto.layer)((it) => {
    it.effect("should require a fresh session to read through a persistent filehandle after restart", () =>
      Effect.gen(function*() {
        const content = new Uint8Array([1, 2, 3])

        const { handle, session } = yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(liveOptions)
          const caller = yield* volume.caller()
          yield* caller.mkdir("/d")
          yield* caller.writeFile("/d/f", content, { access: "write", create: "exclusive" })
          const served = yield* serve(volume, "before-restart")

          assert.strictEqual(yield* served.expireType, 0, "FH4_PERSISTENT")

          return { handle: yield* served.handleAt("/d/f"), session: served.session }
        }))

        yield* Effect.scoped(Effect.gen(function*() {
          const volume = yield* LiveVolume.open(liveOptions)
          const served = yield* serve(volume, "after-restart", new Uint8Array(16).fill(8))

          const oldSession = yield* statuses(
            yield* served.handler.send(yield* call([sequence(session, 2), putfh(handle), read]))
          )

          assert.strictEqual(oldSession.status, Status.BADSESSION)
          assert.deepStrictEqual(oldSession.operations, [[Operation.SEQUENCE, Status.BADSESSION]])

          assert.strictEqual(yield* served.put(handle), Status.OK)

          const reply = yield* decodeCompound(yield* served.compound([putfh(handle), read]))
          assert.deepStrictEqual(reply, {
            status: Status.OK,
            operations: [
              { code: Operation.SEQUENCE, status: Status.OK, value: undefined },
              { code: Operation.PUTFH, status: Status.OK, value: undefined },
              { code: Operation.READ, status: Status.OK, value: { eof: true, data: content } }
            ]
          })
        }))
      }).pipe(Effect.provide(durableStore())))

    it.effect("should answer STALE when a persistent handle names a removed object or another volume", () =>
      Effect.scoped(Effect.gen(function*() {
        const volume = yield* LiveVolume.open(liveOptions)
        const caller = yield* volume.caller()
        yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const served = yield* serve(volume, "persistent-stale")
        const removed = yield* served.handleAt("/f")
        yield* caller.unlink("/f")

        const other = yield* Vfs.make()
        const otherServer = yield* serve(other, "other-volume")
        const foreign = yield* otherServer.handleAt("/")

        assert.strictEqual(yield* served.put(removed), Status.STALE)
        assert.strictEqual(yield* served.put(foreign), Status.STALE)
        assert.strictEqual(yield* served.put(removed.subarray(0, 56)), Status.BADHANDLE)
      })).pipe(Effect.provide(durableStore())))

    it.effect("should expire after restart when a memory volume retains the same identity", () =>
      Effect.gen(function*() {
        const identity = Vfs.VolumeIdentity.make("0123456789abcdef0123456789abcdef")
        const volume = yield* Vfs.make({ identity })
        const caller = yield* volume.caller()
        yield* caller.writeFile("/f", new Uint8Array([1]), { access: "write", create: "exclusive" })
        const before = yield* serve(volume, "memory-before")
        const handle = yield* before.handleAt("/f")

        assert.strictEqual(yield* before.expireType, 0x3, "FH4_VOLATILE_ANY | FH4_NOEXPIRE_WITH_OPEN")
        assert.strictEqual(yield* before.put(handle), Status.OK)

        // A restart builds a new volume: a fresh one, or one restored from a snapshot under the same identity.
        for (const next of [yield* Vfs.make(), yield* Vfs.fromSnapshot(yield* volume.snapshot, { identity })]) {
          assert.strictEqual(yield* (yield* serve(next, "memory-after")).put(handle), Status.FHEXPIRED)
        }
      }))

    it.effect("should answer BADHANDLE when a handle is forged by changing its inode or tag", () =>
      Effect.gen(function*() {
        const admin = yield* Vfs.Caller
        yield* admin.mkdir("/secret", { mode: 0o700 })
        yield* admin.writeFile("/secret/f", new Uint8Array([42]), { access: "write", create: "exclusive" })
        const secret = (yield* admin.stat("/secret/f")).ino
        const guest = yield* Testing.callerAs({ uid: 2000, gid: 2000, groups: [], privileged: false })
        assert.strictEqual((yield* Effect.flip(guest.lookup("/secret/f"))).code, "AccessDenied")

        const handler = yield* wireClient(guest)
        const { session } = yield* startSession(handler, "forged")
        const root = yield* lookupHandle(handler, session, 1, "/")
        const forged = root.slice()
        new DataView(forged.buffer).setBigUint64(33, secret)
        const altered = root.slice()
        altered[41] = altered[41]! ^ 0x80

        let sequenceId = 1

        for (const handle of [forged, altered]) {
          const reply = yield* replyStatuses(
            yield* handler.send(yield* call([sequence(session, ++sequenceId), putfh(handle), read]))
          )

          assert.deepStrictEqual(reply, [Status.OK, Status.BADHANDLE])
        }
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should answer STALE from GETFH and filehandle attributes when the current object is removed", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        const handler = yield* wireClient(caller, { writable: true })
        const { session } = yield* startSession(handler, "removed-current")
        let sequenceId = 0

        for (const [name, last] of [["f", getfh], ["g", getattr(19)]] as const) {
          yield* caller.writeFile(`/${name}`, new Uint8Array([1]), { access: "write", create: "exclusive" })
          const handle = yield* lookupHandle(handler, session, ++sequenceId, `/${name}`)

          // The file stays current across SAVEFH and RESTOREFH while REMOVE takes its only name.
          const reply = yield* replyStatuses(
            yield* handler.send(
              yield* call([
                sequence(session, ++sequenceId),
                putfh(handle),
                op(Operation.SAVEFH),
                op(Operation.PUTROOTFH),
                remove(name),
                op(Operation.RESTOREFH),
                last
              ])
            )
          )

          assert.deepStrictEqual(reply, [
            Status.OK,
            Status.OK,
            Status.OK,
            Status.OK,
            Status.OK,
            Status.OK,
            Status.STALE
          ])
          assert.strictEqual(
            yield* (replyReader(yield* handler.send(yield* call([sequence(session, ++sequenceId), putfh(handle)]))))
              .read(Xdr.uint32),
            Status.STALE
          )
        }
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should open the current filehandle with the macOS CLAIM_FH sequence when macOS sends OPEN with CLAIM_FH", () =>
      Effect.gen(function*() {
        const caller = yield* Vfs.Caller
        yield* caller.writeFile("/file", new Uint8Array([1]), {
          access: "write",
          create: "exclusive"
        })

        const handler = yield* wireClient(caller)
        const client = yield* startSession(handler, "claim-fh")
        const filehandle = yield* lookupHandle(handler, client.session, 1, "/file")

        const response = yield* handler.send(
          yield* call([
            sequence(client.session, 2),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.PUTFH)
                yield* writer.write(Xdr.opaque(), filehandle)
              }),
            (writer) => writer.write(Xdr.uint32, Operation.SAVEFH),
            (writer) => writer.write(Xdr.uint32, Operation.RESTOREFH),
            (writer) =>
              Effect.gen(function*() {
                yield* writer.write(Xdr.uint32, Operation.OPEN)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 1)
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint64, client.client)
                yield* writer.write(Xdr.string(), "owner")
                yield* writer.write(Xdr.uint32, 0)
                yield* writer.write(Xdr.uint32, 4)
              })
          ])
        )

        assert.strictEqual(yield* replyReader(response).read(Xdr.uint32), Status.OK)
      }).pipe(Effect.provide(Testing.layer())))

    it.effect("should answer PUTFH with an allowed status when the volume reports a failure", () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.Volume
        const caller = yield* Vfs.Caller
        const original = yield* serve(volume, "root-handle")
        const handle = yield* original.handleAt("/")

        const pinned = new Map([
          ["InvalidReference", Status.BADHANDLE],
          ["ForeignReference", Status.FHEXPIRED],
          ["StaleReference", Status.STALE],
          ["VolumeBusy", Status.DELAY],
          ["VolumeUnavailable", Status.SERVERFAULT],
          ["StorageRejected", Status.SERVERFAULT],
          ["FutureCode", Status.SERVERFAULT]
        ])

        for (const code of [...Vfs.VfsCode.literals, "FutureCode"]) {
          // The constructor validates its code, so an unknown runtime code is forced onto a valid error afterwards.
          // SAFETY: the stub stands in for a volume whose failure carries any code, a newer core's included.
          // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
          const failure = Object.assign(new Vfs.VfsError({ code: "NotFound", operation: "resolveReferenceKey" }), {
            code
          }) as Vfs.FsFailure

          const handler = yield* wireClient(caller).pipe(Effect.provideService(Vfs.Volume, {
            ...volume,
            resolveReferenceKey: () => Effect.fail(failure)
          }))

          const { session } = yield* startSession(handler, `putfh-${code}`)

          const [, status] = yield* replyStatuses(
            yield* handler.send(yield* call([sequence(session, 1), putfh(handle)]))
          )

          assert.isTrue(PUTFH_ERRORS.some((listed) => listed === status), `${code} answered ${status}`)

          if (pinned.has(code)) assert.strictEqual(status, pinned.get(code), code)
        }
      }).pipe(Effect.provide(Testing.layer())))
  })
})
