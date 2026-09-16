import * as ByteSize from "effect/ByteSize"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import { type DecodeLimits, Reader, Writer, XdrDecodeError } from "./xdr.js"

/** @internal */
export interface RpcLimits extends DecodeLimits {
  readonly maxAuthBytes: ByteSize.ByteSize
  readonly maxMachineNameBytes: ByteSize.ByteSize
  readonly maxSupplementaryGroups: number
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
  readonly compound: (call: CompoundCall) => Effect.Effect<Uint8Array>
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

const decodeAuth = (reader: Reader, limits: RpcLimits): Credentials => {
  const flavor = reader.uint32()
  const body = reader.opaque(ByteSize.min(limits.maxAuthBytes, ByteSize.bytes(400)))
  const auth = new Reader(body, limits)

  if (flavor === AUTH_NONE) {
    auth.finish()

    return Credentials.None()
  }

  // RPCSEC_GSS is a flavor this server understands but does not implement, so the reply says
  // "server requires different authentication" (AUTH_TOOWEAK) rather than "credential is
  // malformed". Nothing ever falls back to a broader identity: the compound is never dispatched.
  if (flavor === RPCSEC_GSS) throw new CredentialError("RPCSEC_GSS is not implemented", AUTH_TOOWEAK)

  if (flavor !== AUTH_SYS) throw new CredentialError("Unsupported RPC authentication flavor")

  try {
    const value = Credentials.Sys({
      stamp: auth.uint32(),
      machineName: auth.string(limits.maxMachineNameBytes),
      uid: auth.uint32(),
      gid: auth.uint32(),
      supplementaryGroups: auth.array((item) => item.uint32(), limits.maxSupplementaryGroups)
    })

    auth.finish()

    return value
  } catch (error) {
    if (error instanceof XdrDecodeError) throw new CredentialError(error.message)
    throw error
  }
}

const decodeVerifier = (reader: Reader, limits: RpcLimits): void => {
  try {
    const flavor = reader.uint32()
    const body = reader.opaque(ByteSize.min(limits.maxAuthBytes, ByteSize.bytes(400)))

    if (flavor !== AUTH_NONE || body.length !== 0) {
      throw new VerifierError("Only an empty AUTH_NONE verifier is accepted")
    }
  } catch (error) {
    if (error instanceof XdrDecodeError) throw new VerifierError(error.message)
    throw error
  }
}

const accepted = (
  xid: number,
  status: number,
  payload?: Uint8Array,
  mismatch?: readonly [number, number]
): Uint8Array => {
  const writer = new Writer().uint32(xid).uint32(REPLY).uint32(MSG_ACCEPTED).uint32(0).uint32(0).uint32(status)

  if (mismatch !== undefined) writer.uint32(mismatch[0]).uint32(mismatch[1])
  const prefix = writer.bytes()

  if (payload === undefined) return prefix
  const result = new Uint8Array(prefix.length + payload.length)
  result.set(prefix)
  result.set(payload, prefix.length)

  return result
}

const denied = (xid: number, status: number, detail: number | readonly [number, number]): Uint8Array => {
  const writer = new Writer().uint32(xid).uint32(REPLY).uint32(MSG_DENIED).uint32(status)

  if (Predicate.isNumber(detail)) writer.uint32(detail)
  else writer.uint32(detail[0]).uint32(detail[1])

  return writer.bytes()
}

/** @internal */
export const handleCall = (
  connection: Connection,
  message: Uint8Array,
  limits: RpcLimits,
  handlers: RpcHandlers
): Effect.Effect<Uint8Array | undefined> =>
  Effect.suspend(() => {
    if (message.length < 4) return Effect.as(Effect.void, undefined)
    const xid = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(0)
    const reader = new Reader(message, limits)

    try {
      reader.uint32()

      if (reader.uint32() !== CALL) return Effect.succeed(accepted(xid, 4))
      const rpcVersion = reader.uint32()

      if (rpcVersion !== RPC_VERSION) return Effect.succeed(denied(xid, 0, [RPC_VERSION, RPC_VERSION]))
      const program = reader.uint32()
      const version = reader.uint32()
      const procedure = reader.uint32()
      let credentials: Credentials

      try {
        credentials = decodeAuth(reader, limits)
        decodeVerifier(reader, limits)
      } catch (error) {
        if (error instanceof VerifierError) return Effect.succeed(denied(xid, 1, AUTH_BADVERF))

        if (error instanceof CredentialError) return Effect.succeed(denied(xid, 1, error.status))

        if (error instanceof XdrDecodeError) return Effect.succeed(denied(xid, 1, AUTH_BADCRED))

        throw error
      }

      if (program !== NFS_PROGRAM) return Effect.succeed(accepted(xid, 1))

      if (version !== NFS_VERSION) return Effect.succeed(accepted(xid, 2, undefined, [NFS_VERSION, NFS_VERSION]))

      if (procedure === 0) {
        reader.finish()

        return Effect.succeed(accepted(xid, 0))
      }

      if (procedure !== 1) return Effect.succeed(accepted(xid, 3))
      const arguments_ = message.slice(message.length - reader.remaining)

      return handlers.compound({
        connection,
        credentials,
        arguments: arguments_,
        requestBytes: message.length
      }).pipe(
        Effect.map((payload) => accepted(xid, 0, payload))
      )
    } catch (error) {
      if (error instanceof XdrDecodeError) return Effect.succeed(accepted(xid, 4))
      throw error
    }
  })
