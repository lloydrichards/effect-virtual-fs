import * as ByteSize from "effect/ByteSize"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import { type DecodeLimits, Reader, Writer, XdrDecodeError } from "./xdr.js"

export interface RpcLimits extends DecodeLimits {
  readonly maxAuthBytes: ByteSize.ByteSize
  readonly maxMachineNameBytes: ByteSize.ByteSize
  readonly maxSupplementaryGroups: number
}

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
 */
export interface Connection {
  readonly id: number
}

export interface CompoundCall {
  /** The connection the call arrived on. */
  readonly connection: Connection
  /** Untrusted identity claims. Only the caller configured on `NfsServer` supplies VFS authority. */
  readonly credentials: Credentials
  readonly arguments: Uint8Array
  readonly requestBytes?: number
}

export interface RpcHandlers {
  readonly compound: (call: CompoundCall) => Effect.Effect<Uint8Array>
  /** Called once when a connection ends, however it ended. */
  readonly disconnect: (connection: Connection) => Effect.Effect<void>
}

const CALL = 0

const REPLY = 1

const MSG_ACCEPTED = 0

const MSG_DENIED = 1

const RPC_VERSION = 2

const NFS_PROGRAM = 100003

const NFS_VERSION = 4

class CredentialError extends Data.TaggedError("CredentialError")<{ readonly detail: string }> {
  constructor(message: string) {
    super({ detail: message })
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

  if (flavor === 0) {
    auth.finish()

    return Credentials.None()
  }

  if (flavor !== 1) throw new CredentialError("Unsupported RPC authentication flavor")

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

    if (flavor !== 0 || body.length !== 0) throw new VerifierError("Only an empty AUTH_NONE verifier is accepted")
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
        if (error instanceof VerifierError) return Effect.succeed(denied(xid, 1, 3))

        if (error instanceof CredentialError || error instanceof XdrDecodeError) {
          return Effect.succeed(denied(xid, 1, 1))
        }

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
