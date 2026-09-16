import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer"
import { assert, describe, it } from "@effect/vitest"
import * as ByteSize from "effect/ByteSize"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as NetAddress from "effect/unstable/net/NetAddress"
import * as SocketServer from "effect/unstable/socket/SocketServer"
import * as Net from "node:net"
import {
  ConfigurationError,
  NfsServer,
  type NfsServerAddress,
  NfsServerConfig,
  NfsServerConfigOverrides,
  NfsServerLimitOverrides,
  NfsServerLimits,
  type NfsServerOptions
} from "../src/index.js"
import { Operation, Status } from "../src/internal/nfs4.js"
import { encodeRecord, RecordDecoder } from "../src/internal/recordMarking.js"
import { Reader, Writer } from "../src/internal/xdr.js"

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
  maxPendingClientReplacements: 1,
  maxSessions: 8,
  maxSlotsPerSession: 4,
  maxReplayBytes: ByteSize.bytes(4_096),
  maxOpens: 16,
  maxOwnerBytes: ByteSize.bytes(256),
  maxReadBytes: ByteSize.bytes(1_024),
  maxWriteBytes: ByteSize.bytes(1_024),
  maxReaddirEntries: 64,
  maxReaddirReplyBytes: ByteSize.bytes(2_048),
  maxNameBytes: ByteSize.bytes(255),
  maxFilehandles: 128
}

const rpcNull = (xid: number): Uint8Array => {
  const none = new Writer().uint32(0).opaque(new Uint8Array()).bytes()

  const header = new Writer()
    .uint32(xid)
    .uint32(0)
    .uint32(2)
    .uint32(100003)
    .uint32(4)
    .uint32(0)
    .bytes()

  const result = new Uint8Array(header.length + none.length * 2)
  result.set(header)
  result.set(none, header.length)
  result.set(none, header.length + none.length)

  return encodeRecord(result)
}

const exchange = (
  port: number,
  request: Uint8Array,
  expectedRecords = 1
): Effect.Effect<ReadonlyArray<Uint8Array>, TestSocketError> =>
  Effect.callback((resume) => {
    const socket = Net.createConnection({ host: "127.0.0.1", port })

    const decoder = new RecordDecoder({
      maxFragmentBytes: limits.maxFragmentBytes,
      maxRecordBytes: limits.maxRecordBytes,
      maxFragmentsPerRecord: limits.maxFragmentsPerRecord
    })

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
const rpcCompound = (xid: number, operations: ReadonlyArray<(writer: Writer) => void>): Uint8Array => {
  const args = new Writer().string("conn").uint32(1).uint32(operations.length)

  for (const operation of operations) operation(args)

  const header = new Writer()
    .uint32(xid).uint32(0).uint32(2).uint32(100003).uint32(4).uint32(1)
    .uint32(0).opaque(new Uint8Array())
    .uint32(0).opaque(new Uint8Array())
    .bytes()

  return encodeRecord(concat(header, args.bytes()))
}

/** Skips the RPC accepted-reply header and returns a reader positioned at the COMPOUND result. */
const compoundReply = (record: Uint8Array): Reader => {
  const reader = new Reader(record, limits)
  reader.uint32()

  for (let field = 0; field < 5; field++) reader.uint32()

  return reader
}

const firstOperationStatus = (record: Uint8Array): number => {
  const reader = compoundReply(record)
  reader.uint32()
  reader.string()
  reader.uint32()
  reader.uint32()

  return reader.uint32()
}

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

    const decoder = new RecordDecoder({
      maxFragmentBytes: limits.maxFragmentBytes,
      maxRecordBytes: limits.maxRecordBytes,
      maxFragmentsPerRecord: limits.maxFragmentsPerRecord
    })

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

describe("NfsServer", () => {
  it("models configuration units and bounds with Schema", () => {
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
    "rejects transport options and invalid explicit limits before binding",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const caller = yield* volume.caller()

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
        Effect.provideService(SocketServer.SocketServer, testSocketServer)
      )
  )

  it.effect("accepts a socket server bound to a UNIX-domain socket path as a local address", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()

      const unix = SocketServer.SocketServer.of({
        address: NetAddress.unixPathAddress("/tmp/effect-vfs-nfs.sock"),
        run: () => Effect.never
      })

      const server = yield* NfsServer.make(options(volume, caller)).pipe(
        Effect.provideService(SocketServer.SocketServer, unix)
      )

      assert.deepStrictEqual(server.address, { path: "/tmp/effect-vfs-nfs.sock" })
    }).pipe(Effect.scoped))

  it.effect("rejects a socket server that is not bound to loopback TCP", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()

      const nonLoopback = SocketServer.SocketServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("0.0.0.0", 2049),
        run: () => Effect.never
      })

      const error = yield* NfsServer.make(options(volume, caller)).pipe(
        Effect.provideService(SocketServer.SocketServer, nonLoopback),
        Effect.flip
      )

      assert.instanceOf(error, ConfigurationError)
      assert.strictEqual(error.option, "socketServer.address")
    }))

  it.live(
    "binds an ephemeral loopback port, serves RPC, and releases the port with its scope",
    () =>
      Effect.gen(function*() {
        const volume = yield* Vfs.make()
        const caller = yield* volume.caller()
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
          tcpPort(first),
          concat(rpcNull(91), rpcNull(92)),
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
        const afterMalformed = yield* exchange(tcpPort(first), rpcNull(93))
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
      })
  )

  it.effect("gives each concurrently open socket its own connection identity", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      const scope = yield* Scope.make()

      const socketServer = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(Scope.provide(scope))

      const server = yield* NfsServer.make(options(volume, caller)).pipe(
        Effect.provideService(SocketServer.SocketServer, socketServer),
        Scope.provide(scope)
      )

      const exchangeId = (owner: string) => (writer: Writer) =>
        writer.uint32(Operation.EXCHANGE_ID).fixedOpaque(new Uint8Array(8)).string(owner)
          .uint32(0).uint32(0).uint32(0)

      const createSession = (client: bigint) => (writer: Writer) => {
        writer.uint32(Operation.CREATE_SESSION).uint64(client).uint32(1).uint32(0)

        for (const slots of [2, 0]) {
          writer.uint32(0).uint32(1_024).uint32(1_024).uint32(1_024).uint32(8).uint32(slots).uint32(0)
        }

        writer.uint32(0).uint32(0)
      }

      const destroySession = (session: Uint8Array) => (writer: Writer) =>
        writer.uint32(Operation.DESTROY_SESSION).fixedOpaque(session)

      const afterHeader = (record: Uint8Array): Reader => {
        const reader = compoundReply(record)
        reader.uint32()
        reader.string()

        for (let field = 0; field < 3; field++) reader.uint32()

        return reader
      }

      // Both sockets stay open for the whole test, so neither one's close can mask the other's
      // identity by disassociating it early.
      const owner = yield* openConnection(tcpPort(server))
      const stranger = yield* openConnection(tcpPort(server))

      const client = afterHeader((yield* owner.send(rpcCompound(1, [exchangeId("owner")])))[0]!).uint64()
      const session = afterHeader((yield* owner.send(rpcCompound(2, [createSession(client)])))[0]!).fixedOpaque(16)

      // The stranger socket presents a valid session id it never carried. If every socket shared
      // one Connection this would answer NFS4_OK.
      const refused = yield* stranger.send(rpcCompound(3, [destroySession(session)]))
      assert.strictEqual(firstOperationStatus(refused[0]!), Status.CONN_NOT_BOUND_TO_SESSION)

      // The socket that created the session may destroy it.
      const accepted = yield* owner.send(rpcCompound(4, [destroySession(session)]))
      assert.strictEqual(firstOperationStatus(accepted[0]!), Status.OK)

      yield* owner.close
      yield* stranger.close
      yield* Scope.close(scope, Exit.void)
    }))

  it.effect("closes a connection it has no permit for instead of abandoning it", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      const scope = yield* Scope.make()

      const socketServer = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(Scope.provide(scope))

      // One permit, so the second connection is refused.
      const server = yield* NfsServer.make({ ...options(volume, caller), limits: { maxConnections: 1 } }).pipe(
        Effect.provideService(SocketServer.SocketServer, socketServer),
        Scope.provide(scope)
      )

      const held = yield* openConnection(tcpPort(server))
      const answered = yield* held.send(rpcNull(1))
      assert.strictEqual(new DataView(answered[0]!.buffer, answered[0]!.byteOffset, 4).getUint32(0), 1)

      // Without an explicit refusal this connection is accepted and then abandoned, so it never
      // closes and this times out rather than failing an assertion.
      yield* awaitRejectedConnection(tcpPort(server), rpcNull(2)).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.die("a refused connection was never closed")
        })
      )

      // The permit is still held, so the server keeps serving the connection that has it.
      const stillServing = yield* held.send(rpcNull(3))
      assert.strictEqual(new DataView(stillServing[0]!.buffer, stillServing[0]!.byteOffset, 4).getUint32(0), 3)

      // Shutting down while a connection is still live must not hang waiting on it.
      yield* Scope.close(scope, Exit.void).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.die("shutdown did not complete with a live connection")
        })
      )

      yield* held.close
    }))

  it.effect("sends a callback down the backchannel and accepts the client's reply over TCP", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const caller = yield* volume.caller()
      const scope = yield* Scope.make()

      const socketServer = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(Scope.provide(scope))

      const server = yield* NfsServer.make(options(volume, caller)).pipe(
        Effect.provideService(SocketServer.SocketServer, socketServer),
        Scope.provide(scope)
      )

      const client = yield* openConnection(tcpPort(server))

      const exchangeId = (writer: Writer) =>
        writer.uint32(Operation.EXCHANGE_ID).fixedOpaque(new Uint8Array(8)).string("cb")
          .uint32(0).uint32(0).uint32(0)

      const identity = yield* client.send(rpcCompound(1, [exchangeId]))
      const idReader = compoundReply(identity[0]!)
      idReader.uint32()
      idReader.string()

      for (let field = 0; field < 3; field++) idReader.uint32()
      const clientId = idReader.uint64()

      // CREATE_SESSION asking for CONN_BACK_CHAN, with a real callback program number.
      const created = yield* client.send(rpcCompound(2, [(writer) => {
        writer.uint32(Operation.CREATE_SESSION).uint64(clientId).uint32(1).uint32(2)

        for (const slots of [2, 2]) {
          writer.uint32(0).uint32(1_024).uint32(1_024).uint32(1_024).uint32(8).uint32(slots).uint32(0)
        }

        // csa_sec_parms authorizing AUTH_NONE for callbacks (Section 18.36.3).
        writer.uint32(0x4000_0001).array([0], (item, flavor) => item.uint32(flavor))
      }]))

      const sessionReader = compoundReply(created[0]!)
      sessionReader.uint32()
      sessionReader.string()

      for (let field = 0; field < 3; field++) sessionReader.uint32()
      const session = sessionReader.fixedOpaque(16)
      assert.strictEqual(sessionReader.uint32(), 1, "csr_sequence")
      assert.strictEqual(sessionReader.uint32(), 2, "csr_flags echoes CONN_BACK_CHAN")

      // The first SEQUENCE triggers the probe, so this exchange yields two records: the SEQUENCE
      // reply and the server's CB_COMPOUND arriving on the same connection.
      const both = yield* client.send(
        rpcCompound(3, [
          (writer) =>
            writer.uint32(Operation.SEQUENCE).fixedOpaque(session).uint32(1).uint32(0).uint32(1).boolean(false)
        ]),
        2
      )

      const callback = both.find((record) => {
        const view = new DataView(record.buffer, record.byteOffset, record.byteLength)

        return view.getUint32(4) === 0
      })

      assert.isDefined(callback, "the server sent a CALL down the backchannel")
      const cb = new Reader(callback, limits)
      const callbackXid = cb.uint32()
      cb.uint32()
      assert.strictEqual(cb.uint32(), 2, "RPC version")
      assert.strictEqual(cb.uint32(), 0x4000_0001, "callback program")
      assert.strictEqual(cb.uint32(), 1, "callback version is 1 per erratum 2291")
      assert.strictEqual(cb.uint32(), 1, "CB_COMPOUND procedure")

      // Read the CB_SEQUENCE the server asked, so the answer echoes the session, sequence and
      // slot it was given. Anything less is not a reply the server may accept.
      cb.uint32()
      cb.opaque()
      cb.uint32()
      cb.opaque()
      cb.string()
      cb.uint32()
      cb.uint32()
      assert.strictEqual(cb.uint32(), 1, "one callback operation")
      assert.strictEqual(cb.uint32(), 11, "OP_CB_SEQUENCE")
      const callbackSession = cb.fixedOpaque(16)
      const callbackSequence = cb.uint32()
      const callbackSlot = cb.uint32()

      // Answer it exactly as a client would, and the server must accept the reply rather than
      // treating it as a request.
      const reply = new Writer().uint32(callbackXid).uint32(1).uint32(0).uint32(0)
        .opaque(new Uint8Array()).uint32(0)
        .uint32(0).string("probe").uint32(1)
        .uint32(11).uint32(0)
        .fixedOpaque(callbackSession).uint32(callbackSequence).uint32(callbackSlot)
        .uint32(callbackSlot).uint32(callbackSlot)
        .bytes()

      yield* client.sendWithoutReply(encodeRecord(reply))

      // The connection still serves ordinary traffic afterwards, proving the reply was routed and
      // not mistaken for a call.
      const after = yield* client.send(
        rpcCompound(4, [
          (writer) =>
            writer.uint32(Operation.SEQUENCE).fixedOpaque(session).uint32(2).uint32(0).uint32(1).boolean(false)
        ])
      )

      assert.strictEqual(firstOperationStatus(after[0]!), Status.OK)

      // And the server accepted that reply as a working callback path: sr_status_flags is clear
      // rather than carrying SEQ4_STATUS_CB_PATH_DOWN_SESSION.
      const status = compoundReply(after[0]!)
      status.uint32()
      status.string()

      for (let field = 0; field < 3; field++) status.uint32()
      status.fixedOpaque(16)

      for (let field = 0; field < 4; field++) status.uint32()

      assert.strictEqual(status.uint32(), 0, "the callback path is reported up")

      yield* client.close
      yield* Scope.close(scope, Exit.void)
    }))
})
