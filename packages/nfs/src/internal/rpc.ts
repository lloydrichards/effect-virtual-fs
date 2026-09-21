import * as ByteSize from "effect/ByteSize"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import type { NfsPeer } from "../NfsServer.js"
import { type DecodeLimits, type DecoderSession, make, XdrCodec, type XdrEncodeError } from "./xdr.js"

/** @internal */
export interface RpcLimits extends DecodeLimits {
  readonly maxAuthBytes: ByteSize.ByteSize
  readonly maxMachineNameBytes: ByteSize.ByteSize
  readonly maxSupplementaryGroups: number
  readonly maxRecordBytes: ByteSize.ByteSize
}

/** @internal */
export type Credentials =
  | { readonly _tag: "None" }
  | {
    readonly _tag: "Sys"
    readonly stamp: number
    readonly machineName: string
    readonly uid: number
    readonly gid: number
    readonly supplementaryGroups: ReadonlyArray<number>
  }

const Credentials = Data.taggedEnum<Credentials>()

/**
 * One transport connection, identified by object identity. A session records the connections
 * associated with its channels (RFC 8881 Section 2.10.5), so the identity must outlive a single
 * call and end when the connection does.
 *
 * @internal
 */
export interface Connection {
  readonly id: number
  /** Address verified by the application's transport resolver, when networked mode is active. */
  readonly peer?: NfsPeer
  /**
   * Writes one RPC message to the peer, answering false when the connection can no longer carry
   * it. The server uses this to send callbacks down a session's backchannel. The message is an
   * unframed RPC call; applying record marking is the transport implementation's job, so callers
   * must not frame it themselves.
   */
  readonly send: (message: Uint8Array) => Effect.Effect<boolean>
}

/** @internal */
export interface CompoundCall {
  /** The connection the call arrived on. */
  readonly connection: Connection
  /** Untrusted identity claims. Only the caller configured on `NfsServer` supplies VFS authority. */
  readonly credentials: Credentials
  readonly arguments: Uint8Array
  readonly requestBytes?: number
}

/** @internal */
export interface RpcHandlers {
  readonly compound: (call: CompoundCall) => Effect.Effect<Uint8Array, RpcPolicyDenied | XdrEncodeError>
  /** Called once when a connection ends, however it ended. */
  readonly disconnect: (connection: Connection) => Effect.Effect<void>
  /** Called with an RPC REPLY, which on a backchannel answers a callback the server sent. */
  readonly callbackReply: (connection: Connection, message: Uint8Array) => Effect.Effect<void>
}

const CALL = 0

const REPLY = 1

/**
 * True when a record is an RPC REPLY rather than a CALL. A backchannel shares its connection with
 * the fore channel, so callback replies arrive interleaved with ordinary requests and must be
 * routed to the callback that is waiting for them instead of being answered as a call.
 */
export const isReply = (message: Uint8Array): boolean =>
  message.length >= 8 &&
  new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(4) === REPLY

const MSG_ACCEPTED = 0

const MSG_DENIED = 1

const RPC_VERSION = 2

const NFS_PROGRAM = 100003

const NFS_VERSION = 4

const AUTH_NONE = 0

const AUTH_SYS = 1

const RPCSEC_GSS = 6

/** RFC 5531 Section 9 `auth_stat` values this server emits. */
const AUTH_BADCRED = 1

const AUTH_BADVERF = 3

const AUTH_TOOWEAK = 5

const AUTH_FAILED = 7

/** A policy refusal is an RPC authentication failure and dispatches no NFS compound. */
export class RpcPolicyDenied extends Data.TaggedError("RpcPolicyDenied")<{}> {}

class CredentialError extends Data.TaggedError("CredentialError")<{
  readonly detail: string
  readonly status: typeof AUTH_BADCRED | typeof AUTH_TOOWEAK
}> {
  constructor(message: string, status: typeof AUTH_BADCRED | typeof AUTH_TOOWEAK = AUTH_BADCRED) {
    super({ detail: message, status })
  }
}

class VerifierError extends Data.TaggedError("VerifierError")<{ readonly detail: string }> {
  constructor(message: string) {
    super({ detail: message })
  }
}

const AuthSysCodec = (limits: RpcLimits) =>
  XdrCodec.struct({
    stamp: XdrCodec.uint32,
    machineName: XdrCodec.string(limits.maxMachineNameBytes),
    uid: XdrCodec.uint32,
    gid: XdrCodec.uint32,
    supplementaryGroups: XdrCodec.array(XdrCodec.uint32, limits.maxSupplementaryGroups)
  })

const decodeAuth = (reader: DecoderSession, limits: RpcLimits): Effect.Effect<Credentials, CredentialError> =>
  Effect.gen(function*() {
    const flavor = yield* reader.read(XdrCodec.uint32)
    const body = yield* reader.read(XdrCodec.opaque(ByteSize.min(limits.maxAuthBytes, ByteSize.bytes(400))))
    const auth = yield* make.openReader(body, limits)

    if (flavor === AUTH_NONE) {
      yield* auth.finish

      return Credentials.None()
    }

    // RPCSEC_GSS is recognized but not implemented. Do not fall back to AUTH_SYS or AUTH_NONE.
    if (flavor === RPCSEC_GSS) {
      return yield* new CredentialError("RPCSEC_GSS is not implemented", AUTH_TOOWEAK)
    }

    if (flavor !== AUTH_SYS) return yield* new CredentialError("Unsupported RPC authentication flavor")

    const value = yield* auth.read(AuthSysCodec(limits))
    yield* auth.finish

    return Credentials.Sys(value)
  }).pipe(Effect.catchTag("XdrDecodeError", (error) => Effect.fail(new CredentialError(error.message))))

const decodeVerifier = (reader: DecoderSession, limits: RpcLimits): Effect.Effect<void, VerifierError> =>
  Effect.gen(function*() {
    const flavor = yield* reader.read(XdrCodec.uint32)
    const body = yield* reader.read(XdrCodec.opaque(ByteSize.min(limits.maxAuthBytes, ByteSize.bytes(400))))

    if (flavor !== AUTH_NONE || body.length !== 0) {
      return yield* new VerifierError("Only an empty AUTH_NONE verifier is accepted")
    }
  }).pipe(Effect.catchTag("XdrDecodeError", (error) => Effect.fail(new VerifierError(error.message))))

const AcceptedPrefixCodec = XdrCodec.struct({
  xid: XdrCodec.uint32,
  direction: XdrCodec.uint32,
  replyStatus: XdrCodec.uint32,
  verifierFlavor: XdrCodec.uint32,
  verifierLength: XdrCodec.uint32,
  acceptStatus: XdrCodec.uint32
})

const DeniedPrefixCodec = XdrCodec.struct({
  xid: XdrCodec.uint32,
  direction: XdrCodec.uint32,
  replyStatus: XdrCodec.uint32,
  rejectStatus: XdrCodec.uint32
})

const accepted = (
  xid: number,
  status: number,
  limits: RpcLimits,
  payload?: Uint8Array,
  mismatch?: readonly [number, number]
): Effect.Effect<Uint8Array, XdrEncodeError> =>
  Effect.gen(function*() {
    const writer = yield* make.openWriter(limits, ByteSize.toNumberUnsafe(limits.maxRecordBytes))
    yield* writer.write(AcceptedPrefixCodec, {
      xid,
      direction: REPLY,
      replyStatus: MSG_ACCEPTED,
      verifierFlavor: AUTH_NONE,
      verifierLength: 0,
      acceptStatus: status
    })

    if (mismatch !== undefined) {
      yield* writer.write(XdrCodec.uint32, mismatch[0])
      yield* writer.write(XdrCodec.uint32, mismatch[1])
    }

    if (payload !== undefined) yield* writer.appendEncoded(payload)

    return yield* writer.finish
  })

const denied = (
  xid: number,
  status: number,
  detail: number | readonly [number, number],
  limits: RpcLimits
): Effect.Effect<Uint8Array, XdrEncodeError> =>
  Effect.gen(function*() {
    const writer = yield* make.openWriter(limits, ByteSize.toNumberUnsafe(limits.maxRecordBytes))
    yield* writer.write(DeniedPrefixCodec, {
      xid,
      direction: REPLY,
      replyStatus: MSG_DENIED,
      rejectStatus: status
    })

    if (Predicate.isNumber(detail)) yield* writer.write(XdrCodec.uint32, detail)
    else {
      yield* writer.write(XdrCodec.uint32, detail[0])
      yield* writer.write(XdrCodec.uint32, detail[1])
    }

    return yield* writer.finish
  })

/** @internal */
export const handleCall = (
  connection: Connection,
  message: Uint8Array,
  limits: RpcLimits,
  handlers: RpcHandlers
): Effect.Effect<Uint8Array | undefined, XdrEncodeError> =>
  Effect.suspend(() => {
    if (message.length < 4) return Effect.as(Effect.void, undefined)
    const xid = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(0)

    return Effect.gen(function*() {
      const reader = yield* make.openReader(message, limits)
      yield* reader.read(XdrCodec.uint32)

      if ((yield* reader.read(XdrCodec.uint32)) !== CALL) return yield* accepted(xid, 4, limits)
      const rpcVersion = yield* reader.read(XdrCodec.uint32)

      if (rpcVersion !== RPC_VERSION) return yield* denied(xid, 0, [RPC_VERSION, RPC_VERSION], limits)
      const program = yield* reader.read(XdrCodec.uint32)
      const version = yield* reader.read(XdrCodec.uint32)
      const procedure = yield* reader.read(XdrCodec.uint32)

      const authentication = yield* Effect.result(Effect.gen(function*() {
        const credentials = yield* decodeAuth(reader, limits)
        yield* decodeVerifier(reader, limits)

        return credentials
      }))

      if (Result.isFailure(authentication)) {
        const error = authentication.failure

        if (error instanceof VerifierError) return yield* denied(xid, 1, AUTH_BADVERF, limits)

        return yield* denied(xid, 1, error.status, limits)
      }

      if (program !== NFS_PROGRAM) return yield* accepted(xid, 1, limits)

      if (version !== NFS_VERSION) return yield* accepted(xid, 2, limits, undefined, [NFS_VERSION, NFS_VERSION])

      if (procedure === 0) {
        yield* reader.finish

        return yield* accepted(xid, 0, limits)
      }

      if (procedure !== 1) return yield* accepted(xid, 3, limits)
      const remaining = yield* reader.remaining
      const arguments_ = message.slice(message.length - remaining)

      const result = yield* Effect.result(handlers.compound({
        connection,
        credentials: authentication.success,
        arguments: arguments_,
        requestBytes: message.length
      }))

      if (Result.isFailure(result)) {
        if (result.failure instanceof RpcPolicyDenied) return yield* denied(xid, 1, AUTH_FAILED, limits)

        return yield* result.failure
      }

      return yield* accepted(xid, 0, limits, result.success)
    }).pipe(Effect.catchTag("XdrDecodeError", () => accepted(xid, 4, limits)))
  })
