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
  NfsServerConfig,
  NfsServerConfigOverrides,
  NfsServerLimitOverrides,
  NfsServerLimits,
  type NfsServerOptions
} from "../src/index.js"
import { encodeRecord, RecordDecoder } from "../src/internal/recordMarking.js"
import { Writer } from "../src/internal/xdr.js"

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
        limits
      })
    )
    assert.isFalse(
      Schema.is(NfsServerConfig)({
        leaseDurationSeconds: 0,
        limits
      })
    )

    const withUnknownField = {
      host: "127.0.0.1" as const,
      port: 0,
      leaseDurationSeconds: 30,
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

        assert.strictEqual(first.address.host, "127.0.0.1")
        assert.notStrictEqual(first.address.port, 0)

        const responses = yield* exchange(
          first.address.port,
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
        yield* awaitRejectedConnection(first.address.port, oversizedMarker)
        const afterMalformed = yield* exchange(first.address.port, rpcNull(93))
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
          port: first.address.port
        }).pipe(Scope.provide(secondScope))

        const second = yield* NfsServer.make(
          options(volume, caller)
        ).pipe(
          Effect.provideService(SocketServer.SocketServer, secondSocketServer),
          Scope.provide(secondScope)
        )

        assert.strictEqual(second.address.port, first.address.port)
        yield* Scope.close(secondScope, Exit.void)
      })
  )
})
