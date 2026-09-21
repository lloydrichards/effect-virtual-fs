import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer"
import { assert, it, live as liveTest } from "@effect/vitest"
import * as ByteSize from "effect/ByteSize"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as NetAddress from "effect/unstable/net/NetAddress"

const live = <E>(
  name: string,
  body: () => Effect.Effect<void, E, Crypto.Crypto | Scope.Scope>,
  timeout?: number
) => liveTest(name, () => body().pipe(Effect.provide(NodeCrypto.layer)), timeout)

import * as SocketServer from "effect/unstable/socket/SocketServer"
import * as Net from "node:net"
import {
  ConfigurationError,
  type NfsIdentityPolicy,
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
import { type DecoderSession, type EncoderSession, make, XdrCodec, type XdrEncodeError } from "../src/internal/xdr.js"

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
  maxNameBytes: ByteSize.bytes(255),
  maxFilehandles: 128
}

const writeWords = (writer: EncoderSession, values: ReadonlyArray<number>) =>
  Effect.forEach(values, (value) => writer.write(XdrCodec.uint32, value), { discard: true })

const skipWords = (reader: DecoderSession, count: number) =>
  Effect.forEach(Array.from({ length: count }), () => reader.read(XdrCodec.uint32), { discard: true })

const rpcNull = (xid: number) =>
  Effect.gen(function*() {
    const writer = yield* make.openWriter(limits, 4_096)
    yield* writeWords(writer, [xid, 0, 2, 100003, 4, 0, 0])
    yield* writer.write(XdrCodec.opaque(), new Uint8Array())
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.opaque(), new Uint8Array())

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
const rpcCompound = (
  xid: number,
  operations: ReadonlyArray<(writer: EncoderSession) => Effect.Effect<void, XdrEncodeError>>,
  credential?: Uint8Array
): Effect.Effect<Uint8Array, XdrEncodeError> =>
  Effect.gen(function*() {
    const writer = yield* make.openWriter(limits, 4_096)

    yield* writeWords(writer, [xid, 0, 2, 100003, 4, 1])

    if (credential === undefined) {
      yield* writer.write(XdrCodec.uint32, 0)
      yield* writer.write(XdrCodec.opaque(), new Uint8Array())
    } else {
      yield* writer.appendEncoded(credential)
    }

    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.opaque(), new Uint8Array())
    yield* writer.write(XdrCodec.string(), "conn")
    yield* writeWords(writer, [1, operations.length])
    yield* Effect.forEach(operations, (operation) => operation(writer), { discard: true })

    return encodeRecord(yield* writer.finish)
  })

const authSysCredential = (uid: number) =>
  Effect.gen(function*() {
    const body = yield* make.openWriter(limits, 1_024)
    yield* body.write(XdrCodec.uint32, 0)
    yield* body.write(XdrCodec.string(), "test-client")
    yield* writeWords(body, [uid, uid])
    yield* body.write(XdrCodec.array(XdrCodec.uint32), [])
    const writer = yield* make.openWriter(limits, 1_024)
    yield* writer.write(XdrCodec.uint32, 1)
    yield* writer.write(XdrCodec.opaque(), yield* body.finish)

    return yield* writer.finish
  })

/** Skips the RPC accepted-reply header and returns a reader positioned at the COMPOUND result. */
const compoundReply = (record: Uint8Array) =>
  Effect.gen(function*() {
    const reader = yield* make.openReader(record, limits)
    yield* skipWords(reader, 6)

    return reader
  })

const firstOperationStatus = (record: Uint8Array) =>
  Effect.gen(function*() {
    const reader = yield* compoundReply(record)
    yield* reader.read(XdrCodec.uint32)
    yield* reader.read(XdrCodec.string())
    yield* skipWords(reader, 2)

    return yield* reader.read(XdrCodec.uint32)
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

it.layer(NodeCrypto.layer)("NfsServer", (it) => {
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
      assert.strictEqual(error.option, "policy")
    }))

  it.effect("requires both network policy and explicit opt-in for a non-loopback bind", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()

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
    }).pipe(Effect.scoped))

  live("passes the accepted TCP peer to the identity policy", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
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
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)
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
    }))

  live("passes a UNIX peer with no invented client address to the identity policy", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
      const nonce = yield* (yield* Crypto.Crypto).randomBytes(8)
      const path = `/tmp/effect-vfs-nfs-${process.pid}-${Encoding.encodeHex(nonce)}.sock`
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
          (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)
        ])
      )

      assert.strictEqual(response.length, 1)
      assert.deepStrictEqual(observed, {
        credential: { flavor: "none" },
        peer: { transport: "unix", address: null, port: null, path }
      })
    }))

  live("bounds mapped callers and gives policy denial the same RPC response", () =>
    Effect.gen(function*() {
      const volume = yield* Vfs.make()
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

      const request = (xid: number, uid: number) =>
        Effect.gen(function*() {
          const credential = yield* authSysCredential(uid)

          return yield* rpcCompound(xid, [
            (writer) => writer.write(XdrCodec.uint32, Operation.PUTROOTFH)
          ], credential)
        })

      const allowed = (yield* exchange({ port: tcpPort(server) }, yield* request(81, 1000)))[0]!
      const deniedByPolicy = (yield* exchange({ port: tcpPort(server) }, yield* request(82, 2000)))[0]!
      const deniedByLimit = (yield* exchange({ port: tcpPort(server) }, yield* request(83, 3000)))[0]!

      const fields = (bytes: Uint8Array) =>
        Effect.gen(function*() {
          const reader = yield* make.openReader(bytes, limits)

          return yield* Effect.forEach(Array.from({ length: 5 }), () => reader.read(XdrCodec.uint32))
        })

      assert.deepStrictEqual((yield* fields(allowed)).slice(0, 3), [81, 1, 0])
      assert.deepStrictEqual(yield* fields(deniedByPolicy), [82, 1, 1, 1, 7])
      assert.deepStrictEqual(yield* fields(deniedByLimit), [83, 1, 1, 1, 7])
    }))

  live(
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

      const exchangeId = (owner: string) => (writer: EncoderSession) =>
        Effect.gen(function*() {
          yield* writer.write(XdrCodec.uint32, Operation.EXCHANGE_ID)
          yield* writer.write(XdrCodec.fixedOpaque(8), new Uint8Array(8))
          yield* writer.write(XdrCodec.string(), owner)
          yield* writeWords(writer, [0, 0, 0])
        })

      const createSession = (client: bigint) => (writer: EncoderSession) =>
        Effect.gen(function*() {
          yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
          yield* writer.write(XdrCodec.uint64, client)
          yield* writeWords(writer, [1, 0])
          yield* Effect.forEach([2, 0], (slots) => writeWords(writer, [0, 1_024, 1_024, 1_024, 8, slots, 0]), {
            discard: true
          })
          yield* writeWords(writer, [0, 0])
        })

      const destroySession = (session: Uint8Array) => (writer: EncoderSession) =>
        Effect.gen(function*() {
          yield* writer.write(XdrCodec.uint32, Operation.DESTROY_SESSION)
          yield* writer.write(XdrCodec.fixedOpaque(16), session)
        })

      const afterHeader = (record: Uint8Array) =>
        Effect.gen(function*() {
          const reader = yield* compoundReply(record)
          yield* reader.read(XdrCodec.uint32)
          yield* reader.read(XdrCodec.string())
          yield* skipWords(reader, 3)

          return reader
        })

      // Both sockets stay open for the whole test, so neither one's close can mask the other's
      // identity by disassociating it early.
      const owner = yield* openConnection(tcpPort(server))
      const stranger = yield* openConnection(tcpPort(server))

      const clientReply = (yield* owner.send(yield* rpcCompound(1, [exchangeId("owner")])))[0]!
      const client = yield* (yield* afterHeader(clientReply)).read(XdrCodec.uint64)
      const sessionReply = (yield* owner.send(yield* rpcCompound(2, [createSession(client)])))[0]!
      const session = yield* (yield* afterHeader(sessionReply)).read(XdrCodec.fixedOpaque(16))

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

      const exchangeId = (writer: EncoderSession) =>
        Effect.gen(function*() {
          yield* writer.write(XdrCodec.uint32, Operation.EXCHANGE_ID)
          yield* writer.write(XdrCodec.fixedOpaque(8), new Uint8Array(8))
          yield* writer.write(XdrCodec.string(), "cb")
          yield* writeWords(writer, [0, 0, 0])
        })

      const identity = yield* client.send(yield* rpcCompound(1, [exchangeId]))
      const idReader = yield* compoundReply(identity[0]!)
      yield* idReader.read(XdrCodec.uint32)
      yield* idReader.read(XdrCodec.string())
      yield* skipWords(idReader, 3)
      const clientId = yield* idReader.read(XdrCodec.uint64)

      // CREATE_SESSION asking for CONN_BACK_CHAN, with a real callback program number.
      const created = yield* client.send(
        yield* rpcCompound(2, [(writer) =>
          Effect.gen(function*() {
            yield* writer.write(XdrCodec.uint32, Operation.CREATE_SESSION)
            yield* writer.write(XdrCodec.uint64, clientId)
            yield* writeWords(writer, [1, 2])
            yield* Effect.forEach([2, 2], (slots) => writeWords(writer, [0, 1_024, 1_024, 1_024, 8, slots, 0]), {
              discard: true
            })

            // csa_sec_parms authorizing AUTH_NONE for callbacks (Section 18.36.3).
            yield* writer.write(XdrCodec.uint32, 0x4000_0001)
            yield* writer.write(XdrCodec.array(XdrCodec.uint32), [0])
          })])
      )

      const sessionReader = yield* compoundReply(created[0]!)
      yield* sessionReader.read(XdrCodec.uint32)
      yield* sessionReader.read(XdrCodec.string())
      yield* skipWords(sessionReader, 3)
      const session = yield* sessionReader.read(XdrCodec.fixedOpaque(16))
      assert.strictEqual(yield* sessionReader.read(XdrCodec.uint32), 1, "csr_sequence")
      assert.strictEqual(yield* sessionReader.read(XdrCodec.uint32), 2, "csr_flags echoes CONN_BACK_CHAN")

      // The first SEQUENCE triggers the probe, so this exchange yields two records: the SEQUENCE
      // reply and the server's CB_COMPOUND arriving on the same connection.
      const both = yield* client.send(
        yield* rpcCompound(3, [
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.SEQUENCE)
              yield* writer.write(XdrCodec.fixedOpaque(16), session)
              yield* writeWords(writer, [1, 0, 1])
              yield* writer.write(XdrCodec.boolean, false)
            })
        ]),
        2
      )

      const callback = both.find((record) => {
        const view = new DataView(record.buffer, record.byteOffset, record.byteLength)

        return view.getUint32(4) === 0
      })

      assert.isDefined(callback, "the server sent a CALL down the backchannel")
      const cb = yield* make.openReader(callback, limits)
      const callbackXid = yield* cb.read(XdrCodec.uint32)
      yield* cb.read(XdrCodec.uint32)
      assert.strictEqual(yield* cb.read(XdrCodec.uint32), 2, "RPC version")
      assert.strictEqual(yield* cb.read(XdrCodec.uint32), 0x4000_0001, "callback program")
      assert.strictEqual(yield* cb.read(XdrCodec.uint32), 1, "callback version is 1 per erratum 2291")
      assert.strictEqual(yield* cb.read(XdrCodec.uint32), 1, "CB_COMPOUND procedure")

      // Read the CB_SEQUENCE the server asked, so the answer echoes the session, sequence and
      // slot it was given. Anything less is not a reply the server may accept.
      yield* cb.read(XdrCodec.uint32)
      yield* cb.read(XdrCodec.opaque())
      yield* cb.read(XdrCodec.uint32)
      yield* cb.read(XdrCodec.opaque())
      yield* cb.read(XdrCodec.string())
      yield* skipWords(cb, 2)
      assert.strictEqual(yield* cb.read(XdrCodec.uint32), 1, "one callback operation")
      assert.strictEqual(yield* cb.read(XdrCodec.uint32), 11, "OP_CB_SEQUENCE")
      const callbackSession = yield* cb.read(XdrCodec.fixedOpaque(16))
      const callbackSequence = yield* cb.read(XdrCodec.uint32)
      const callbackSlot = yield* cb.read(XdrCodec.uint32)

      // Answer it exactly as a client would, and the server must accept the reply rather than
      // treating it as a request.
      const replyWriter = yield* make.openWriter(limits, 4_096)
      yield* writeWords(replyWriter, [callbackXid, 1, 0, 0])
      yield* replyWriter.write(XdrCodec.opaque(), new Uint8Array())
      yield* writeWords(replyWriter, [0, 0])
      yield* replyWriter.write(XdrCodec.string(), "probe")
      yield* writeWords(replyWriter, [1, 11, 0])
      yield* replyWriter.write(XdrCodec.fixedOpaque(16), callbackSession)
      yield* writeWords(replyWriter, [callbackSequence, callbackSlot, callbackSlot, callbackSlot])
      const reply = yield* replyWriter.finish

      yield* client.sendWithoutReply(encodeRecord(reply))

      // The connection still serves ordinary traffic afterwards, proving the reply was routed and
      // not mistaken for a call.
      const after = yield* client.send(
        yield* rpcCompound(4, [
          (writer) =>
            Effect.gen(function*() {
              yield* writer.write(XdrCodec.uint32, Operation.SEQUENCE)
              yield* writer.write(XdrCodec.fixedOpaque(16), session)
              yield* writeWords(writer, [2, 0, 1])
              yield* writer.write(XdrCodec.boolean, false)
            })
        ])
      )

      assert.strictEqual(yield* firstOperationStatus(after[0]!), Status.OK)

      // And the server accepted that reply as a working callback path: sr_status_flags is clear
      // rather than carrying SEQ4_STATUS_CB_PATH_DOWN_SESSION.
      const status = yield* compoundReply(after[0]!)
      yield* status.read(XdrCodec.uint32)
      yield* status.read(XdrCodec.string())
      yield* skipWords(status, 3)
      yield* status.read(XdrCodec.fixedOpaque(16))
      yield* skipWords(status, 4)

      assert.strictEqual(yield* status.read(XdrCodec.uint32), 0, "the callback path is reported up")

      yield* client.close
      yield* Scope.close(scope, Exit.void)
    }))
})
