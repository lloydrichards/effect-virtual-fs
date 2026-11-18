import { Testing, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer"
import { assert, it, live as liveTest } from "@effect/vitest"
import * as ByteSize from "effect/ByteSize"
import type * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as NetAddress from "effect/net/NetAddress"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"

const live = <E>(
  name: string,
  body: () => Effect.Effect<void, E, Digest.Digest | SecureRandom.SecureRandom | Scope.Scope>,
  timeout?: number
) => liveTest(name, () => body().pipe(Effect.provide(NodeCrypto.layer)), timeout)

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
      const caller = yield* Vfs.Caller

      // SAFETY: This test deliberately passes the forbidden local writable option to exercise runtime validation.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime validation requires an invalid typed input.
      const error = yield* Effect.flip(NfsServer.make({
        volume: { ...volume, durability: "survives-power-loss" },
        caller,
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
