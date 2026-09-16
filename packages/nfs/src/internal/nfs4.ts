import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as ByteSize from "effect/ByteSize"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { type InvalidFilehandleError, InvalidNameError, type NfsExport, validateName } from "./export.js"
import type { CompoundCall, Connection } from "./rpc.js"
import { type DecodeLimits, Reader, Writer, XdrDecodeError } from "./xdr.js"

export const Status = {
  OK: 0,
  PERM: 1,
  NOENT: 2,
  ACCESS: 13,
  EXIST: 17,
  NOTDIR: 20,
  ISDIR: 21,
  INVAL: 22,
  FBIG: 27,
  NOSPC: 28,
  ROFS: 30,
  NAMETOOLONG: 63,
  NOTEMPTY: 66,
  STALE: 70,
  BADHANDLE: 10001,
  BAD_COOKIE: 10003,
  NOTSUPP: 10004,
  TOOSMALL: 10005,
  SERVERFAULT: 10006,
  DELAY: 10008,
  SAME: 10009,
  EXPIRED: 10011,
  LOCKED: 10012,
  FHEXPIRED: 10014,
  SHARE_DENIED: 10015,
  CLID_INUSE: 10017,
  NOFILEHANDLE: 10020,
  MINOR_VERS_MISMATCH: 10021,
  STALE_CLIENTID: 10022,
  OLD_STATEID: 10024,
  BAD_STATEID: 10025,
  BAD_SEQID: 10026,
  NOT_SAME: 10027,
  SYMLINK: 10029,
  ATTRNOTSUPP: 10032,
  NO_GRACE: 10033,
  BADXDR: 10036,
  LOCKS_HELD: 10037,
  BADCHAR: 10040,
  BADNAME: 10041,
  OP_ILLEGAL: 10044,
  BADSESSION: 10052,
  BADSLOT: 10053,
  COMPLETE_ALREADY: 10054,
  CONN_NOT_BOUND_TO_SESSION: 10055,
  SEQ_MISORDERED: 10063,
  SEQUENCE_POS: 10064,
  REQ_TOO_BIG: 10065,
  REP_TOO_BIG: 10066,
  REP_TOO_BIG_TO_CACHE: 10067,
  RETRY_UNCACHED_REP: 10068,
  TOO_MANY_OPS: 10070,
  OP_NOT_IN_SESSION: 10071,
  CLIENTID_BUSY: 10074,
  SEQ_FALSE_RETRY: 10076,
  BAD_HIGH_SLOT: 10077,
  ENCR_ALG_UNSUPP: 10079,
  NOT_ONLY_OP: 10081,
  WRONG_TYPE: 10083
} as const

export const Operation = {
  ACCESS: 3,
  CLOSE: 4,
  COMMIT: 5,
  CREATE: 6,
  DELEGPURGE: 7,
  DELEGRETURN: 8,
  GETATTR: 9,
  GETFH: 10,
  LINK: 11,
  LOCK: 12,
  LOCKT: 13,
  LOCKU: 14,
  LOOKUP: 15,
  LOOKUPP: 16,
  NVERIFY: 17,
  OPEN: 18,
  OPENATTR: 19,
  OPEN_CONFIRM: 20,
  OPEN_DOWNGRADE: 21,
  PUTFH: 22,
  PUTPUBFH: 23,
  PUTROOTFH: 24,
  READ: 25,
  READDIR: 26,
  READLINK: 27,
  REMOVE: 28,
  RENAME: 29,
  RENEW: 30,
  RESTOREFH: 31,
  SAVEFH: 32,
  SECINFO: 33,
  SETATTR: 34,
  SETCLIENTID: 35,
  SETCLIENTID_CONFIRM: 36,
  VERIFY: 37,
  WRITE: 38,
  RELEASE_LOCKOWNER: 39,
  BACKCHANNEL_CTL: 40,
  BIND_CONN_TO_SESSION: 41,
  EXCHANGE_ID: 42,
  CREATE_SESSION: 43,
  DESTROY_SESSION: 44,
  FREE_STATEID: 45,
  GET_DIR_DELEGATION: 46,
  GETDEVICEINFO: 47,
  GETDEVICELIST: 48,
  LAYOUTCOMMIT: 49,
  LAYOUTGET: 50,
  LAYOUTRETURN: 51,
  SECINFO_NO_NAME: 52,
  SEQUENCE: 53,
  SET_SSV: 54,
  TEST_STATEID: 55,
  WANT_DELEGATION: 56,
  DESTROY_CLIENTID: 57,
  RECLAIM_COMPLETE: 58,
  ILLEGAL: 10044
} as const

/**
 * NFSv4.0 operations that RFC 8881 Section 8.8 says an NFSv4.1 server MUST NOT
 * implement and MUST answer with NFS4ERR_NOTSUPP.
 */
const mustNotImplementOperations: ReadonlySet<number> = new Set([
  Operation.OPEN_CONFIRM,
  Operation.RENEW,
  Operation.SETCLIENTID,
  Operation.SETCLIENTID_CONFIRM,
  Operation.RELEASE_LOCKOWNER
])

/**
 * OPTIONAL and RECOMMENDED operations this server does not implement. RFC 8881
 * Section 17 requires NFS4ERR_NOTSUPP for them. Their arguments are not decoded
 * because the compound stops at the failing operation.
 */
const unsupportedOptionalOperations: ReadonlySet<number> = new Set([
  Operation.DELEGPURGE,
  Operation.DELEGRETURN,
  Operation.OPENATTR,
  Operation.GET_DIR_DELEGATION,
  Operation.GETDEVICEINFO,
  Operation.GETDEVICELIST,
  Operation.LAYOUTCOMMIT,
  Operation.LAYOUTGET,
  Operation.LAYOUTRETURN,
  Operation.WANT_DELEGATION
])

/** channel_dir_from_server4 (RFC 8881 Section 18.34.2). */
const CDFS4_FORE = 1

const CDFS4_BACK = 2

const CDFS4_BOTH = 3

/** channel_dir_from_client4 (RFC 8881 Section 18.34.1). */
const CDFC4_FORE = 0x1

const CDFC4_BACK = 0x2

const CDFC4_FORE_OR_BOTH = 0x3

const CDFC4_BACK_OR_BOTH = 0x7

/**
 * Directions a connection carries for one session. A connection may carry both, and the same
 * connection may serve several sessions (Section 2.10.3.1).
 */
const CHANNEL_FORE = 0x1

const CHANNEL_BACK = 0x2

/** csa_flags bit asking the server to bind the CREATE_SESSION connection to the backchannel. */
const CREATE_SESSION4_FLAG_CONN_BACK_CHAN = 0x2

/** The callback RPC program's version is 1, per RFC 5661 erratum 2291; the RFC text says 4. */
const CALLBACK_RPC_VERSION = 1

const CB_COMPOUND_PROCEDURE = 1

const OP_CB_SEQUENCE = 11

/** RPCSEC_GSS in callback_sec_parms4; this server never issues the handles it would name. */
const RPCSEC_GSS = 6

const SECINFO_STYLE4_CURRENT_FH = 0

const SECINFO_STYLE4_PARENT = 1

/**
 * Smallest COMPOUND a session can carry: an RPC call header with AUTH_NONE plus a
 * SEQUENCE-only compound. A fore channel that cannot fit it can never be used.
 */
const MIN_FORE_REQUEST_BYTES = 40 + 48

/** Smallest reply a session can carry: an RPC reply header plus a SEQUENCE-only compound. */
const MIN_FORE_RESPONSE_BYTES = 24 + 12 + 8 + 36

/** PERSIST, CONN_BACK_CHAN, and CONN_RDMA are the only defined csa_flags bits. */
const CREATE_SESSION4_KNOWN_FLAGS = 0x7

const ACCESS4_READ = 0x01

const ACCESS4_LOOKUP = 0x02

const ACCESS4_MODIFY = 0x04

const ACCESS4_EXTEND = 0x08

const ACCESS4_DELETE = 0x10

const ACCESS4_EXECUTE = 0x20

const AUTH_NONE = 0

const AUTH_SYS = 1

/** The export accepts and generates only UTF-8 names (RFC 8881 Section 14.4). */
const FSCHARSET_CAP4_ALLOWS_ONLY_UTF8 = 0x2

const SP4_NONE = 0

const SP4_MACH_CRED = 1

const SP4_SSV = 2

const OPEN4_SHARE_ACCESS_READ = 0x0001

const OPEN4_SHARE_ACCESS_WRITE = 0x0002

const OPEN4_SHARE_ACCESS_MASK = 0x0003

const OPEN4_SHARE_DENY_READ = 0x0001

const OPEN4_SHARE_DENY_BOTH = 0x0003

/** open_claim_type4 values that reclaim state after a restart or a delegation. */
const CLAIM_PREVIOUS = 1

const CLAIM_DELEGATE_CUR = 2

const CLAIM_DELEGATE_PREV = 3

const CLAIM_DELEG_CUR_FH = 5

const CLAIM_DELEG_PREV_FH = 6

/**
 * Worst-case encoded GETATTR result: the largest attribute set this server can return for a
 * 25-byte filehandle is about 300 bytes; recheck when `supportedAttributes` grows.
 */
const MAX_GETATTR_REPLY_BYTES = 512

/** WRITE_LT and WRITEW_LT are the lock types that modify a read-only file system's state. */
const WRITE_LOCK_TYPES: ReadonlySet<number> = new Set([2, 4])

const OPEN4_SHARE_ACCESS_WANT_DELEG_MASK = 0xff00

const OPEN4_SHARE_ACCESS_WANT_NO_DELEG = 0x0400

const OPEN4_SHARE_ACCESS_WANT_CANCEL = 0x0500

/** SIGNAL_DELEG_WHEN_RESRC_AVAIL and PUSH_DELEG_WHEN_UNCONTENDED are registration hints. */
const OPEN4_SHARE_ACCESS_WANT_HINT_MASK = 0x0003_0000

const OPEN_DELEGATE_NONE = 0

const OPEN_DELEGATE_NONE_EXT = 3

const WND4_NOT_WANTED = 0

const WND4_NOT_SUPP_FTYPE = 3

const WND4_CANCELLED = 7

const EXCHGID4_FLAG_USE_NON_PNFS = 0x0001_0000

const EXCHGID4_FLAG_CONFIRMED_R = 0x8000_0000

const EXCHGID4_ALLOWED_ARGUMENT_FLAGS = 0x4007_0103

export interface Nfs4Limits extends DecodeLimits {
  readonly maxRecordBytes: ByteSize.ByteSize
  readonly maxCompoundBytes: ByteSize.ByteSize
  readonly maxOperations: number
  readonly maxBitmapWords: number
  readonly maxClients: number
  readonly maxPendingClientReplacements: number
  readonly maxSessions: number
  readonly maxSlotsPerSession: number
  readonly maxReplayBytes: ByteSize.ByteSize
  readonly maxOpens: number
  readonly maxOwnerBytes: ByteSize.ByteSize
  readonly maxReadBytes: ByteSize.ByteSize
  readonly maxWriteBytes: ByteSize.ByteSize
  readonly maxReaddirEntries: number
  readonly maxReaddirReplyBytes: ByteSize.ByteSize
  readonly maxNameBytes: ByteSize.ByteSize
}

export interface Nfs4Options {
  readonly leaseDurationSeconds: number
  /** How long a callback waits for the client's reply before the path is treated as down. */
  readonly callbackTimeout: Duration.Input
  readonly generation: Uint8Array
  readonly now: () => number
  readonly limits: Nfs4Limits
}

export interface Nfs4Handler {
  readonly compound: (call: CompoundCall) => Effect.Effect<Uint8Array>
  readonly disconnect: (connection: Connection) => Effect.Effect<void>
  readonly callbackReply: (connection: Connection, message: Uint8Array) => Effect.Effect<void>
  /**
   * Sends a CB_SEQUENCE-only CB_COMPOUND down a session's backchannel and reports whether the
   * client answered. Answers `false` when the session has no backchannel to probe.
   */
  readonly probeBackChannel: (session: Uint8Array) => Effect.Effect<boolean>
}

export const nextSequenceId = (sequence: number): number => (sequence + 1) >>> 0

type ParsedOperation =
  | { readonly kind: "Access"; readonly code: typeof Operation.ACCESS; readonly value: number }
  | {
    readonly kind: "Close"
    readonly code: typeof Operation.CLOSE
    readonly value: { readonly sequence: number; readonly stateid: Uint8Array }
  }
  | {
    readonly kind: "Create"
    readonly code: typeof Operation.CREATE
    readonly value: {
      readonly kind: number
      readonly name: Uint8Array
      readonly attrs: ReturnType<typeof readAttributes>
    }
  }
  | { readonly kind: "Getattr"; readonly code: typeof Operation.GETATTR; readonly value: ReadonlyArray<number> }
  | { readonly kind: "Getfh"; readonly code: typeof Operation.GETFH; readonly value: undefined }
  | { readonly kind: "Lookupp"; readonly code: typeof Operation.LOOKUPP; readonly value: undefined }
  | { readonly kind: "Putrootfh"; readonly code: typeof Operation.PUTROOTFH; readonly value: undefined }
  | { readonly kind: "Readlink"; readonly code: typeof Operation.READLINK; readonly value: undefined }
  | { readonly kind: "Restorefh"; readonly code: typeof Operation.RESTOREFH; readonly value: undefined }
  | { readonly kind: "Savefh"; readonly code: typeof Operation.SAVEFH; readonly value: undefined }
  | { readonly kind: "Link"; readonly code: typeof Operation.LINK; readonly value: Uint8Array }
  | { readonly kind: "Lookup"; readonly code: typeof Operation.LOOKUP; readonly value: Uint8Array }
  | { readonly kind: "Remove"; readonly code: typeof Operation.REMOVE; readonly value: Uint8Array }
  | {
    readonly kind: "Open"
    readonly code: typeof Operation.OPEN
    readonly value: {
      readonly sequence: number
      readonly access: number
      readonly deny: number
      readonly client: bigint
      readonly owner: Uint8Array
      readonly openHow: number
      readonly claim: number
      readonly name: Uint8Array
    }
  }
  | { readonly kind: "Putfh"; readonly code: typeof Operation.PUTFH; readonly value: Uint8Array }
  | {
    readonly kind: "Read"
    readonly code: typeof Operation.READ
    readonly value: { readonly stateid: Uint8Array; readonly offset: bigint; readonly count: number }
  }
  | {
    readonly kind: "Readdir"
    readonly code: typeof Operation.READDIR
    readonly value: {
      readonly cookie: bigint
      readonly verifier: Uint8Array
      readonly dircount: number
      readonly maxcount: number
      readonly attrs: ReadonlyArray<number>
    }
  }
  | {
    readonly kind: "Rename"
    readonly code: typeof Operation.RENAME
    readonly value: { readonly oldName: Uint8Array; readonly newName: Uint8Array }
  }
  | {
    readonly kind: "Setattr"
    readonly code: typeof Operation.SETATTR
    readonly value: { readonly stateid: Uint8Array; readonly attrs: ReturnType<typeof readAttributes> }
  }
  | {
    readonly kind: "Write"
    readonly code: typeof Operation.WRITE
    readonly value: {
      readonly stateid: Uint8Array
      readonly offset: bigint
      readonly stable: number
      readonly data: Uint8Array
    }
  }
  | {
    readonly kind: "ExchangeId"
    readonly code: typeof Operation.EXCHANGE_ID
    readonly value: {
      readonly verifier: Uint8Array
      readonly owner: Uint8Array
      readonly flags: number
      readonly protection: number
    }
  }
  | {
    readonly kind: "CreateSession"
    readonly code: typeof Operation.CREATE_SESSION
    readonly value: {
      readonly client: bigint
      readonly sequence: number
      readonly flags: number
      readonly fore: ChannelAttrs
      readonly back: ChannelAttrs
      /** csa_cb_program: the RPC program number the client listens for callbacks on. */
      readonly callbackProgram: number
      /** csa_sec_parms: the credentials the client authorized for callbacks. */
      readonly security: ReadonlyArray<CallbackSecurity>
      /** csa_sec_parms named an RPCSEC_GSS handle, which cannot exist here (Section 18.36.3). */
      readonly gssCallback: boolean
    }
  }
  | { readonly kind: "DestroySession"; readonly code: typeof Operation.DESTROY_SESSION; readonly value: Uint8Array }
  | {
    readonly kind: "Sequence"
    readonly code: typeof Operation.SEQUENCE
    readonly value: {
      readonly session: Uint8Array
      readonly sequence: number
      readonly slot: number
      readonly highest: number
      readonly cache: boolean
    }
  }
  | { readonly kind: "DestroyClient"; readonly code: typeof Operation.DESTROY_CLIENTID; readonly value: bigint }
  | { readonly kind: "ReclaimComplete"; readonly code: typeof Operation.RECLAIM_COMPLETE; readonly value: boolean }
  | {
    readonly kind: "Commit"
    readonly code: typeof Operation.COMMIT
    readonly value: { readonly offset: bigint; readonly count: number }
  }
  | { readonly kind: "Lock"; readonly code: typeof Operation.LOCK; readonly value: { readonly lockType: number } }
  | { readonly kind: "Lockt"; readonly code: typeof Operation.LOCKT; readonly value: { readonly lockType: number } }
  | { readonly kind: "Locku"; readonly code: typeof Operation.LOCKU; readonly value: Uint8Array }
  | {
    readonly kind: "Verify"
    readonly code: typeof Operation.VERIFY | typeof Operation.NVERIFY
    readonly value: { readonly bitmap: ReadonlyArray<number>; readonly values: Uint8Array }
  }
  | {
    readonly kind: "OpenDowngrade"
    readonly code: typeof Operation.OPEN_DOWNGRADE
    readonly value: {
      readonly stateid: Uint8Array
      readonly sequence: number
      readonly access: number
      readonly deny: number
    }
  }
  | { readonly kind: "Putpubfh"; readonly code: typeof Operation.PUTPUBFH; readonly value: undefined }
  | { readonly kind: "Secinfo"; readonly code: typeof Operation.SECINFO; readonly value: Uint8Array }
  | { readonly kind: "SecinfoNoName"; readonly code: typeof Operation.SECINFO_NO_NAME; readonly value: number }
  | { readonly kind: "FreeStateid"; readonly code: typeof Operation.FREE_STATEID; readonly value: Uint8Array }
  | { readonly kind: "SetSsv"; readonly code: typeof Operation.SET_SSV; readonly value: undefined }
  | {
    readonly kind: "TestStateid"
    readonly code: typeof Operation.TEST_STATEID
    readonly value: ReadonlyArray<Uint8Array>
  }
  | {
    readonly kind: "BackchannelCtl"
    readonly code: typeof Operation.BACKCHANNEL_CTL
    readonly value: {
      readonly program: number
      readonly security: ReadonlyArray<CallbackSecurity>
      readonly gssCallback: boolean
    }
  }
  | {
    readonly kind: "BindConnToSession"
    readonly code: typeof Operation.BIND_CONN_TO_SESSION
    readonly value: { readonly session: Uint8Array; readonly direction: number }
  }
  | { readonly kind: "NotSupported"; readonly code: number; readonly value: undefined }
  | { readonly kind: "Unknown"; readonly code: number; readonly value: undefined }
  /** A known operation whose arguments did not decode; it answers NFS4ERR_BADXDR in place. */
  | { readonly kind: "Malformed"; readonly code: number; readonly value: undefined }

type ResultPart = { readonly code: number; readonly status: number; readonly body?: Uint8Array }

type CurrentObject = Vfs.ObjectReference

interface ClientState {
  readonly id: bigint
  readonly owner: string
  readonly verifier: string
  /** The RPC principal that established the record (RFC 8881 Section 18.35.4). */
  readonly principal: string
  readonly previous: ClientState | undefined
  sequence: number
  leaseExpiresAt: number
  reclaimed: boolean
  confirmed: boolean
  createSessionReplay: {
    readonly sequence: number
    readonly status: number
    readonly body?: Uint8Array
    readonly retainedBytes: ByteSize.ByteSize
  } | undefined
}

type CreateSessionReplay = NonNullable<ClientState["createSessionReplay"]>

interface ReplaySlot {
  sequence: number
  response?: Uint8Array
  request?: Uint8Array
  credentials?: string
  retainedBytes?: ByteSize.ByteSize
}

interface SessionState {
  readonly id: Uint8Array
  readonly client: ClientState
  readonly slots: Array<ReplaySlot>
  readonly fore: ChannelAttrs
  /**
   * Connections carrying this session's channels, each mapped to a CHANNEL_FORE/CHANNEL_BACK
   * mask. Section 2.10.5 allows a session to be reached over several connections, and Section
   * 2.10.3.1 lets one connection carry either or both directions.
   */
  readonly connections: Map<Connection, number>
  /** Backchannel state, present only once the client has asked for a backchannel. */
  back: BackChannel | undefined
}

/**
 * The server's half of a session's backchannel: what the client agreed to receive, and the slot
 * state Section 2.10.6.1 requires even for callbacks.
 */
interface BackChannel {
  /** csa_cb_program from CREATE_SESSION, updatable by BACKCHANNEL_CTL (Section 18.33). */
  program: number
  /**
   * The credential callbacks carry, chosen from csa_sec_parms. Undefined when the client
   * authorized nothing this server can encode, in which case no callback is ever sent.
   */
  security: CallbackSecurity | undefined
  readonly attrs: ChannelAttrs
  readonly slots: Array<CallbackSlot>
  /** False once a callback goes unanswered, which Section 18.37.3 reports as CB_PATH_DOWN. */
  healthy: boolean
  /** Set once the path has been probed, so the probe runs once per backchannel rather than per request. */
  probed: boolean
}

interface CallbackSlot {
  sequence: number
  busy: boolean
}

interface OpenState {
  id: Uint8Array
  sequence: number
  /** Share reservation held by this open-owner; access is always OPEN4_SHARE_ACCESS_READ. */
  deny: number
  readonly owner: string
  readonly client: ClientState
  readonly reference: Vfs.ObjectReference
  readonly file: Vfs.FileHandle
  readonly close: Effect.Effect<void>
}

/** Adds `direction` to what `connection` already carries for `session` (Section 2.10.3.1). */
const associate = (session: SessionState, connection: Connection, direction: number): void => {
  session.connections.set(connection, (session.connections.get(connection) ?? 0) | direction)
}

const empty = new Uint8Array()

const assertOptions = (options: Nfs4Options): void => {
  if (!Number.isSafeInteger(options.leaseDurationSeconds) || options.leaseDurationSeconds <= 0) {
    throw new RangeError("leaseDurationSeconds must be a positive safe integer")
  }

  if (options.generation.length !== 16) throw new RangeError("generation must contain exactly 16 bytes")

  for (const [name, value] of Object.entries(options.limits)) {
    if (Predicate.isBigInt(value)) {
      if (value <= 0n) throw new RangeError(`${name} must be a positive byte size`)
    } else if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`)
    }
  }
}

const byteLength = (length: number): ByteSize.ByteSize => ByteSize.bytes(length)

const addBytes = (left: ByteSize.ByteSize, right: ByteSize.ByteSize): ByteSize.ByteSize => ByteSize.sum(left, right)

const subtractBytes = (left: ByteSize.ByteSize, right: ByteSize.ByteSize): ByteSize.ByteSize =>
  ByteSize.bytes(left - right)

const bytesKey = (bytes: Uint8Array): string => {
  let result = ""

  for (const byte of bytes) result += byte.toString(16).padStart(2, "0")

  return result
}

const credentialsKey = (credentials: CompoundCall["credentials"]): string =>
  !Predicate.isTagged(credentials, "Sys")
    ? "none"
    : `sys:${credentials.uid}:${credentials.gid}:${credentials.machineName}:${
      credentials.supplementaryGroups.join(",")
    }`

/**
 * The principal of an RPC credential for client-record ownership. AUTH_SYS has no
 * verified identity, so this only serializes EXCHANGE_ID and CREATE_SESSION
 * ownership; it never grants VFS authority.
 */
const principalKey = (credentials: CompoundCall["credentials"]): string =>
  !Predicate.isTagged(credentials, "Sys") ? "none" : `sys:${credentials.uid}`

const sameRequest = (left: Uint8Array | undefined, right: Uint8Array): boolean => {
  if (left === undefined || left.length !== right.length) return false

  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false

  return true
}

const bitmap = (reader: Reader, limit: number): ReadonlyArray<number> => reader.array((item) => item.uint32(), limit)

const writeBitmap = (writer: Writer, words: ReadonlyArray<number>): void => {
  writer.array(words, (target, word) => target.uint32(word))
}

const attributesIn = (words: ReadonlyArray<number>): ReadonlyArray<number> => {
  const result: Array<number> = []

  for (let word = 0; word < words.length; word++) {
    for (let bit = 0; bit < 32; bit++) if (((words[word]! >>> bit) & 1) !== 0) result.push(word * 32 + bit)
  }

  return result
}

const validateWritableAttributes = (words: ReadonlyArray<number>, bytes: Uint8Array, limits: Nfs4Limits): void => {
  const attributes = attributesIn(words)

  if (attributes.some((attribute) => ![4, 33, 36, 37, 48, 54].includes(attribute))) return
  const values = new Reader(bytes, limits)

  for (const attribute of attributes) {
    if (attribute === 4) values.uint64()
    else if (attribute === 33) values.uint32()
    else if (attribute === 36 || attribute === 37) values.string(limits.maxStringBytes)
    else if (attribute === 48 || attribute === 54) {
      const how = values.uint32()

      if (how === 1) {
        values.uint64()

        if (values.uint32() >= 1_000_000_000) throw new XdrDecodeError("Invalid attribute nanoseconds")
      } else if (how !== 0) throw new XdrDecodeError("Invalid set-time discriminant")
    }
  }

  values.finish()
}

const readAttributes = (reader: Reader, limits: Nfs4Limits) => {
  const words = bitmap(reader, limits.maxBitmapWords)
  const values = reader.opaque(limits.maxOpaqueBytes)
  validateWritableAttributes(words, values, limits)

  return { bitmap: words, values }
}

const readStateOwner = (reader: Reader, limits: Nfs4Limits): void => {
  reader.uint64()
  reader.opaque(limits.maxOwnerBytes)
}

interface ChannelAttrs {
  readonly headerPadding: number
  readonly maxRequest: number
  readonly maxResponse: number
  readonly maxCachedResponse: number
  readonly maxOperations: number
  readonly maxRequests: number
  readonly rdmaIrd: ReadonlyArray<number>
}

const readChannelAttrs = (reader: Reader): ChannelAttrs => ({
  headerPadding: reader.uint32(),
  maxRequest: reader.uint32(),
  maxResponse: reader.uint32(),
  maxCachedResponse: reader.uint32(),
  maxOperations: reader.uint32(),
  maxRequests: reader.uint32(),
  rdmaIrd: reader.array((item) => item.uint32(), 1)
})

/**
 * One entry of csa_sec_parms. Section 18.36.3 calls these "acceptable security credentials the
 * server can use on the session's backchannel": an authorization list, so the credential a
 * callback carries has to be one the client actually offered. AUTH_SYS entries keep their
 * cbsp_sys_cred, which is the credential the client authorized the server to present.
 */
interface CallbackSecurity {
  readonly flavor: number
  /** The encoded AUTH_SYS credential body, ready to place in an outbound RPC header. */
  readonly credential?: Uint8Array
}

const readCallbackSecurity = (reader: Reader, limits: Nfs4Limits): CallbackSecurity => {
  const flavor = reader.uint32()

  if (flavor === 0) return { flavor }

  if (flavor === 1) {
    const stamp = reader.uint32()
    const machineName = reader.string(limits.maxStringBytes)
    const uid = reader.uint32()
    const gid = reader.uint32()
    const groups = reader.array((item) => item.uint32(), limits.maxArrayElements)

    return {
      flavor,
      credential: new Writer().uint32(stamp).string(machineName).uint32(uid).uint32(gid)
        .array(groups, (item, group) => item.uint32(group))
        .bytes()
    }
  }

  if (flavor === 6) {
    reader.uint32()
    reader.opaque(limits.maxOpaqueBytes)
    reader.opaque(limits.maxOpaqueBytes)

    return { flavor }
  }

  throw new XdrDecodeError("Unsupported callback security flavor")
}

/**
 * Picks the credential a callback will carry. AUTH_NONE is preferred when the client offered it,
 * since it needs no identity; otherwise the client's own AUTH_SYS credential is used. A client
 * that offered neither has authorized nothing this server can encode, and gets no callbacks.
 */
const chooseCallbackSecurity = (
  offered: ReadonlyArray<CallbackSecurity>
): CallbackSecurity | undefined =>
  offered.find((entry) => entry.flavor === AUTH_NONE) ??
    offered.find((entry) => entry.flavor === AUTH_SYS)

const writeChannelAttrs = (
  writer: Writer,
  attrs: ChannelAttrs
): void => {
  writer.uint32(attrs.headerPadding).uint32(attrs.maxRequest).uint32(attrs.maxResponse)
    .uint32(attrs.maxCachedResponse).uint32(attrs.maxOperations).uint32(attrs.maxRequests)
    .array(attrs.rdmaIrd, (item, value) => item.uint32(value))
}

/** state_protect_ops4: the operations a client wants enforced and allowed under the protection. */
const readStateProtectOps = (reader: Reader, limits: Nfs4Limits): void => {
  bitmap(reader, limits.maxBitmapWords)
  bitmap(reader, limits.maxBitmapWords)
}

const readStateProtection = (reader: Reader, limits: Nfs4Limits): number => {
  const how = reader.uint32()

  if (how === SP4_MACH_CRED) {
    readStateProtectOps(reader, limits)
  } else if (how === SP4_SSV) {
    // ssv_sp_parms4: ops, hash and encryption algorithm lists, window, and GSS handle count.
    readStateProtectOps(reader, limits)
    reader.array((item) => item.opaque(limits.maxOpaqueBytes), limits.maxArrayElements)
    reader.array((item) => item.opaque(limits.maxOpaqueBytes), limits.maxArrayElements)
    reader.uint32()
    reader.uint32()
  } else if (how !== SP4_NONE) {
    throw new XdrDecodeError("Invalid state protection discriminant")
  }

  return how
}

const readLockType = (reader: Reader): number => {
  const lockType = reader.uint32()

  if (lockType < 1 || lockType > 4) throw new XdrDecodeError("Invalid lock type")

  return lockType
}

const decodeOperation = (code: number, reader: Reader, limits: Nfs4Limits): ParsedOperation => {
  switch (code) {
    case Operation.ACCESS:
      return { kind: "Access", code, value: reader.uint32() }
    case Operation.CLOSE:
      return { kind: "Close", code, value: { sequence: reader.uint32(), stateid: reader.fixedOpaque(16) } }
    case Operation.CREATE: {
      const kind = reader.uint32()

      if (kind === 5) reader.string(limits.maxStringBytes)
      else if (kind === 3 || kind === 4) {
        reader.uint32()
        reader.uint32()
      }

      const name = reader.opaque(limits.maxOpaqueBytes)
      const attrs = readAttributes(reader, limits)

      return { kind: "Create", code, value: { kind, name, attrs } }
    }

    case Operation.GETATTR:
      return { kind: "Getattr", code, value: bitmap(reader, limits.maxBitmapWords) }
    case Operation.GETFH:
      return { kind: "Getfh", code, value: undefined }
    case Operation.LOOKUPP:
      return { kind: "Lookupp", code, value: undefined }
    case Operation.PUTROOTFH:
      return { kind: "Putrootfh", code, value: undefined }
    case Operation.READLINK:
      return { kind: "Readlink", code, value: undefined }
    case Operation.RESTOREFH:
      return { kind: "Restorefh", code, value: undefined }
    case Operation.SAVEFH:
      return { kind: "Savefh", code, value: undefined }
    case Operation.LINK:
      return { kind: "Link", code, value: reader.opaque(limits.maxOpaqueBytes) }
    case Operation.LOOKUP:
      return { kind: "Lookup", code, value: reader.opaque(limits.maxOpaqueBytes) }
    case Operation.REMOVE:
      return { kind: "Remove", code, value: reader.opaque(limits.maxOpaqueBytes) }
    case Operation.OPEN: {
      const sequence = reader.uint32()
      const access = reader.uint32()
      const deny = reader.uint32()
      const client = reader.uint64()
      const owner = reader.opaque(limits.maxOwnerBytes)
      const openHow = reader.uint32()

      if (openHow === 1) {
        const createMode = reader.uint32()

        if (createMode === 0 || createMode === 1) {
          readAttributes(reader, limits)
        } else if (createMode === 2) {
          reader.fixedOpaque(8)
        } else if (createMode === 3) {
          reader.fixedOpaque(8)
          readAttributes(reader, limits)
        } else {
          throw new XdrDecodeError("Invalid OPEN create mode")
        }
      } else if (openHow !== 0) {
        throw new XdrDecodeError("Invalid OPEN how discriminant")
      }

      const claim = reader.uint32()
      let name: Uint8Array = empty

      if (claim === 0 || claim === 3) name = reader.opaque(limits.maxOpaqueBytes)
      else if (claim === 1) reader.uint32()
      else if (claim === 2) {
        reader.fixedOpaque(16)
        name = reader.opaque(limits.maxOpaqueBytes)
      } else if (claim === 5) reader.fixedOpaque(16)
      else if (claim !== 4 && claim !== 6) throw new XdrDecodeError("Invalid OPEN claim")

      return { kind: "Open", code, value: { sequence, access, deny, client, owner, openHow, claim, name } }
    }

    case Operation.PUTFH:
      return { kind: "Putfh", code, value: reader.opaque(limits.maxOpaqueBytes) }
    case Operation.READ:
      return {
        code,
        kind: "Read",
        value: { stateid: reader.fixedOpaque(16), offset: reader.uint64(), count: reader.uint32() }
      }
    case Operation.READDIR:
      return {
        code,
        kind: "Readdir",
        value: {
          cookie: reader.uint64(),
          verifier: reader.fixedOpaque(8),
          dircount: reader.uint32(),
          maxcount: reader.uint32(),
          attrs: bitmap(reader, limits.maxBitmapWords)
        }
      }
    case Operation.RENAME:
      return {
        code,
        kind: "Rename",
        value: { oldName: reader.opaque(limits.maxOpaqueBytes), newName: reader.opaque(limits.maxOpaqueBytes) }
      }
    case Operation.SETATTR:
      return {
        code,
        kind: "Setattr",
        value: {
          stateid: reader.fixedOpaque(16),
          attrs: readAttributes(reader, limits)
        }
      }
    case Operation.WRITE:
      return {
        code,
        kind: "Write",
        value: {
          stateid: reader.fixedOpaque(16),
          offset: reader.uint64(),
          stable: reader.uint32(),
          data: reader.opaque(limits.maxWriteBytes)
        }
      }
    case Operation.EXCHANGE_ID: {
      const verifier = reader.fixedOpaque(8)
      const owner = reader.opaque(limits.maxOwnerBytes)
      const flags = reader.uint32()
      const protection = readStateProtection(reader, limits)

      // eia_client_impl_id<1>: at most one implementation record (RFC 5662).
      reader.array((item) => {
        item.string(limits.maxStringBytes)
        item.string(limits.maxStringBytes)
        item.uint64()
        item.uint32()
      }, 1)

      return { kind: "ExchangeId", code, value: { verifier, owner, flags, protection } }
    }

    case Operation.CREATE_SESSION: {
      const client = reader.uint64()
      const sequence = reader.uint32()
      const flags = reader.uint32()
      const fore = readChannelAttrs(reader)
      const back = readChannelAttrs(reader)
      const callbackProgram = reader.uint32()
      const flavors = reader.array((item) => readCallbackSecurity(item, limits), limits.maxArrayElements)

      return {
        kind: "CreateSession",
        code,
        value: {
          client,
          sequence,
          flags,
          fore,
          back,
          callbackProgram,
          security: flavors,
          gssCallback: flavors.some((entry) => entry.flavor === RPCSEC_GSS)
        }
      }
    }

    case Operation.DESTROY_SESSION:
      return { kind: "DestroySession", code, value: reader.fixedOpaque(16) }
    case Operation.SEQUENCE:
      return {
        code,
        kind: "Sequence",
        value: {
          session: reader.fixedOpaque(16),
          sequence: reader.uint32(),
          slot: reader.uint32(),
          highest: reader.uint32(),
          cache: reader.boolean()
        }
      }
    case Operation.DESTROY_CLIENTID:
      return { kind: "DestroyClient", code, value: reader.uint64() }
    case Operation.RECLAIM_COMPLETE:
      return { kind: "ReclaimComplete", code, value: reader.boolean() }
    case Operation.COMMIT:
      return { kind: "Commit", code, value: { offset: reader.uint64(), count: reader.uint32() } }
    case Operation.LOCK: {
      const lockType = readLockType(reader)
      reader.boolean()
      reader.uint64()
      reader.uint64()

      if (reader.boolean()) {
        reader.uint32()
        reader.fixedOpaque(16)
        reader.uint32()
        readStateOwner(reader, limits)
      } else {
        reader.fixedOpaque(16)
        reader.uint32()
      }

      return { kind: "Lock", code, value: { lockType } }
    }

    case Operation.LOCKT: {
      const lockType = readLockType(reader)
      reader.uint64()
      reader.uint64()
      readStateOwner(reader, limits)

      return { kind: "Lockt", code, value: { lockType } }
    }

    case Operation.LOCKU: {
      readLockType(reader)
      reader.uint32()
      const stateid = reader.fixedOpaque(16)
      reader.uint64()
      reader.uint64()

      return { kind: "Locku", code, value: stateid }
    }

    case Operation.NVERIFY:
    case Operation.VERIFY:
      return {
        kind: "Verify",
        code,
        value: { bitmap: bitmap(reader, limits.maxBitmapWords), values: reader.opaque(limits.maxOpaqueBytes) }
      }
    case Operation.OPEN_DOWNGRADE:
      return {
        kind: "OpenDowngrade",
        code,
        value: {
          stateid: reader.fixedOpaque(16),
          sequence: reader.uint32(),
          access: reader.uint32(),
          deny: reader.uint32()
        }
      }
    case Operation.PUTPUBFH:
      return { kind: "Putpubfh", code, value: undefined }
    case Operation.SECINFO:
      return { kind: "Secinfo", code, value: reader.opaque(limits.maxOpaqueBytes) }
    case Operation.SECINFO_NO_NAME: {
      const style = reader.uint32()

      if (style !== SECINFO_STYLE4_CURRENT_FH && style !== SECINFO_STYLE4_PARENT) {
        throw new XdrDecodeError("Invalid SECINFO_NO_NAME style")
      }

      return { kind: "SecinfoNoName", code, value: style }
    }

    case Operation.FREE_STATEID:
      return { kind: "FreeStateid", code, value: reader.fixedOpaque(16) }
    case Operation.BACKCHANNEL_CTL: {
      const program = reader.uint32()
      const flavors = reader.array((item) => readCallbackSecurity(item, limits), limits.maxArrayElements)

      return {
        kind: "BackchannelCtl",
        code,
        value: { program, security: flavors, gssCallback: flavors.some((entry) => entry.flavor === RPCSEC_GSS) }
      }
    }

    case Operation.BIND_CONN_TO_SESSION: {
      const session = reader.fixedOpaque(16)
      const direction = reader.uint32()

      // channel_dir_from_client4: FORE (1), BACK (2), FORE_OR_BOTH (3), or BACK_OR_BOTH (7).
      if (direction < CDFC4_FORE || (direction > CDFC4_FORE_OR_BOTH && direction !== CDFC4_BACK_OR_BOTH)) {
        throw new XdrDecodeError("Invalid channel direction")
      }

      reader.boolean()

      return { kind: "BindConnToSession", code, value: { session, direction } }
    }

    case Operation.SET_SSV:
      reader.opaque(limits.maxOpaqueBytes)
      reader.opaque(limits.maxOpaqueBytes)

      return { kind: "SetSsv", code, value: undefined }
    case Operation.TEST_STATEID:
      return {
        kind: "TestStateid",
        code,
        value: reader.array((item) => item.fixedOpaque(16), limits.maxArrayElements)
      }
    default:
      if (mustNotImplementOperations.has(code) || unsupportedOptionalOperations.has(code)) {
        return { kind: "NotSupported", code, value: undefined }
      }

      return { kind: "Unknown", code, value: undefined }
  }
}

const parseCompound = (bytes: Uint8Array, limits: Nfs4Limits) => {
  if (byteLength(bytes.length) > limits.maxCompoundBytes) throw new XdrDecodeError("COMPOUND exceeds byte limit")
  const reader = new Reader(bytes, limits)
  const tag = reader.opaque(limits.maxStringBytes)
  const minor = reader.uint32()
  const count = reader.uint32()

  if (count > limits.maxOperations || count > limits.maxArrayElements) {
    throw new XdrDecodeError("COMPOUND operation count exceeds its limit")
  }

  const operations: Array<ParsedOperation> = []
  let stopped = false

  for (let index = 0; index < count; index++) {
    const code = reader.uint32()
    const operation = decodeOperation_(code)
    operations.push(operation)

    // The compound fails at an undecoded operation, so later bytes are never interpreted.
    if (operation.kind === "Unknown" || operation.kind === "NotSupported" || operation.kind === "Malformed") {
      stopped = true
      break
    }
  }

  if (!stopped) reader.finish()

  return { tag, minor, count, operations }

  /**
   * Section 15.1.1.1 defines NFS4ERR_BADXDR per operation: the operations before a
   * malformed one are still processed and reported.
   */
  function decodeOperation_(code: number): ParsedOperation {
    try {
      return decodeOperation(code, reader, limits)
    } catch (error) {
      if (!(error instanceof XdrDecodeError)) throw error

      return { kind: "Malformed", code, value: undefined }
    }
  }
}

const encodeCompound = (
  tag: Uint8Array,
  parts: ReadonlyArray<ResultPart>,
  overallStatus = parts.find((part) => part.status !== Status.OK)?.status ?? Status.OK
): Uint8Array => {
  const status = overallStatus
  const writer = new Writer().uint32(status).opaque(tag).uint32(parts.length)

  for (const part of parts) {
    writer.uint32(part.code).uint32(part.status)

    if (part.body !== undefined) writer.fixedOpaque(part.body)
  }

  return writer.bytes()
}

const failureForFs = (error: Vfs.FsError): number => {
  switch (error.code) {
    case "NotFound":
      return Status.NOENT
    case "NotDirectory":
      return Status.NOTDIR
    case "IsDirectory":
      return Status.ISDIR
    case "AccessDenied":
      return Status.ACCESS
    case "InvalidArgument":
      return Status.INVAL
    case "PathTooLong":
      return Status.NAMETOOLONG
    case "NoSpace":
      return Status.NOSPC
    case "FileTooLarge":
      return Status.FBIG
    case "StaleReference":
      return Status.STALE
    default:
      return Status.SERVERFAULT
  }
}

const encodeStatusBody = (build: (writer: Writer) => void): Uint8Array => {
  const writer = new Writer()
  build(writer)

  return writer.bytes()
}

const supportedAttributes = [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  16,
  17,
  19,
  20,
  26,
  29,
  30,
  31,
  33,
  34,
  35,
  36,
  37,
  45,
  47,
  51,
  52,
  53,
  55,
  75,
  76
]

/** Attributes that VERIFY and NVERIFY may not compare (RFC 8881 Section 18.31.3). */
const nonComparableAttributes: ReadonlySet<number> = new Set([11, 48, 54])

const wordsFor = (attributes: ReadonlyArray<number>): ReadonlyArray<number> => {
  if (attributes.length === 0) return []
  const words = Array.from<number>({ length: Math.floor(Math.max(...attributes) / 32) + 1 }).fill(0)

  for (const attribute of attributes) {
    const index = Math.floor(attribute / 32)
    words[index] = (words[index]! | (1 << (attribute % 32))) >>> 0
  }

  return words
}

const requestedAttributes = (words: ReadonlyArray<number>): ReadonlyArray<number> => {
  const result: Array<number> = []

  for (let word = 0; word < words.length; word++) {
    for (let bit = 0; bit < 32; bit++) if (((words[word]! >>> bit) & 1) !== 0) result.push(word * 32 + bit)
  }

  return result
}

const isValidName = (name: Uint8Array, maxNameBytes: ByteSize.ByteSize): boolean => {
  try {
    validateName(name, maxNameBytes)

    return true
  } catch {
    return false
  }
}

const encodeTime = (writer: Writer, nanoseconds: bigint): boolean => {
  let seconds = nanoseconds / 1_000_000_000n
  let nanos = nanoseconds % 1_000_000_000n

  if (nanos < 0) {
    seconds -= 1n
    nanos += 1_000_000_000n
  }

  if (seconds < -0x8000_0000_0000_0000n || seconds > 0x7fff_ffff_ffff_ffffn) return false
  writer.uint64(BigInt.asUintN(64, seconds)).uint32(Number(nanos))

  return true
}

const encodeAttributeValues = (
  requested: ReadonlyArray<number>,
  observation: Vfs.ObjectObservation<Vfs.Metadata>,
  filehandle: Uint8Array,
  export_: NfsExport,
  options: Nfs4Options
): Uint8Array | undefined => {
  if (requested.some((attribute) => !supportedAttributes.includes(attribute))) return undefined
  const values = new Writer()
  const metadata = observation.value

  for (const attribute of requested) {
    switch (attribute) {
      case 0:
        writeBitmap(values, wordsFor(supportedAttributes))
        break
      case 1:
        values.uint32(metadata.kind === "file" ? 1 : metadata.kind === "directory" ? 2 : 5)
        break
      case 2:
        values.uint32(0x3)
        break
      case 3:
        values.uint64(BigInt.asUintN(64, observation.revision))
        break
      case 4:
        values.uint64(metadata.size)
        break
      case 5:
      case 6:
      case 9:
      case 17:
      case 26:
      case 34:
        values.boolean(true)
        break
      case 7:
      case 16:
        values.boolean(false)
        break
      case 51:
        values.uint64(0n).uint32(1)
        break
      case 76:
        values.uint32(FSCHARSET_CAP4_ALLOWS_ONLY_UTF8)
        break
      case 8:
        values.uint64(export_.fsid[0]).uint64(export_.fsid[1])
        break
      case 10:
        values.uint32(options.leaseDurationSeconds)
        break
      case 11:
        values.uint32(Status.OK)
        break
      case 19:
        values.opaque(filehandle)
        break
      case 20:
      case 55:
        values.uint64(BigInt.asUintN(64, metadata.ino))
        break
      case 29:
        values.uint32(ByteSize.toNumberUnsafe(options.limits.maxNameBytes))
        break
      case 30:
        values.uint64(options.limits.maxReadBytes)
        break
      case 31:
        values.uint64(options.limits.maxWriteBytes)
        break
      case 33:
        values.uint32(metadata.mode)
        break
      case 35:
        values.uint32(metadata.nlink)
        break
      case 36:
        values.string(String(metadata.uid))
        break
      case 37:
        values.string(String(metadata.gid))
        break
      case 45:
        values.uint64(metadata.size)
        break
      case 47:
        if (!encodeTime(values, metadata.atimeNs)) return undefined
        break
      case 52:
        if (!encodeTime(values, metadata.ctimeNs)) return undefined
        break
      case 53:
        if (!encodeTime(values, metadata.mtimeNs)) return undefined
        break
      case 75:
        writeBitmap(values, [])
        break
    }
  }

  return values.bytes()
}

const encodeAttributes = (
  requested: ReadonlyArray<number>,
  observation: Vfs.ObjectObservation<Vfs.Metadata>,
  filehandle: Uint8Array,
  export_: NfsExport,
  options: Nfs4Options
): Uint8Array | undefined => {
  const values = encodeAttributeValues(requested, observation, filehandle, export_, options)

  if (values === undefined) return undefined

  return encodeStatusBody((writer) => {
    writeBitmap(writer, wordsFor(requested))
    writer.opaque(values)
  })
}

/** Encodes a READDIR entry's attributes as only `rdattr_error` (RFC 8881 Section 18.23.3). */
const encodeReaddirError = (status: number): Uint8Array =>
  encodeStatusBody((writer) => {
    writeBitmap(writer, wordsFor([11]))
    writer.opaque(new Writer().uint32(status).bytes())
  })

const supportedAccessMask = (kind: Vfs.Metadata["kind"]): number => {
  switch (kind) {
    case "directory":
      return ACCESS4_READ | ACCESS4_LOOKUP | ACCESS4_MODIFY | ACCESS4_EXTEND | ACCESS4_DELETE
    case "file":
      return ACCESS4_READ | ACCESS4_MODIFY | ACCESS4_EXTEND | ACCESS4_EXECUTE
    default:
      return ACCESS4_READ | ACCESS4_MODIFY | ACCESS4_EXTEND
  }
}

/**
 * Evaluates mode bits against the decoded RPC identity for reporting only. The
 * identity never selects VFS authority; a read-only export grants no write-class
 * bit regardless of mode.
 */
const grantedAccess = (
  supported: number,
  metadata: Vfs.Metadata,
  credentials: CompoundCall["credentials"]
): number => {
  const mode = metadata.mode
  const anyExecute = (mode & 0o111) !== 0
  let read: boolean
  let execute: boolean

  if (Predicate.isTagged(credentials, "Sys") && credentials.uid === 0) {
    read = true
    execute = metadata.kind === "directory" || anyExecute
  } else {
    const shift = Predicate.isTagged(credentials, "Sys") && credentials.uid === metadata.uid
      ? 6
      : Predicate.isTagged(credentials, "Sys") &&
          (credentials.gid === metadata.gid || credentials.supplementaryGroups.includes(metadata.gid))
      ? 3
      : 0

    read = ((mode >>> shift) & 0o4) !== 0
    execute = ((mode >>> shift) & 0o1) !== 0
  }

  let granted = 0

  if (read) granted |= ACCESS4_READ

  if (execute) granted |= metadata.kind === "directory" ? ACCESS4_LOOKUP : ACCESS4_EXECUTE

  return granted & supported
}

/**
 * Encodes an outbound RPC CALL for the callback program. The version is 1 per RFC 5661 erratum
 * 2291; the RFC text still prints 4, and a client listening on version 1 ignores anything else.
 * The credential is the one the client authorized in csa_sec_parms (Section 18.36.3), never a
 * flavor it did not offer.
 */
const encodeCallbackCall = (
  xid: number,
  program: number,
  procedure: number,
  security: CallbackSecurity,
  body: Uint8Array
): Uint8Array => {
  const header = new Writer()
    .uint32(xid).uint32(0).uint32(2)
    .uint32(program).uint32(CALLBACK_RPC_VERSION).uint32(procedure)
    .uint32(security.flavor).opaque(security.credential ?? empty)
    .uint32(0).opaque(empty)
    .bytes()

  const message = new Uint8Array(header.length + body.length)
  message.set(header)
  message.set(body, header.length)

  return message
}

/**
 * A CB_COMPOUND carrying CB_SEQUENCE alone. Section 20.9.3 requires CB_SEQUENCE to appear once and
 * first in every CB_COMPOUND, and erratum 6015 makes it REQUIRED rather than the OPTIONAL that
 * Table 17 prints. With no delegations or layouts to recall, this is the whole callback: it
 * exercises the backchannel and renews nothing else.
 */
const encodeCallbackSequence = (
  session: Uint8Array,
  sequence: number,
  slot: number,
  highestSlot: number
): Uint8Array =>
  new Writer()
    .string("probe").uint32(1).uint32(0).uint32(1)
    .uint32(OP_CB_SEQUENCE)
    .fixedOpaque(session).uint32(sequence).uint32(slot).uint32(highestSlot).boolean(false)
    .array([], () => undefined)
    .bytes()

const makeOpaqueId = (generation: Uint8Array, serial: bigint): Uint8Array => {
  const result = new Uint8Array(16)
  result.set(generation.subarray(0, 8), 0)
  new DataView(result.buffer).setBigUint64(8, serial)

  return result
}

const makeStateId = (generation: Uint8Array, serial: bigint, sequence: number): Uint8Array => {
  const id = new Uint8Array(16)
  new DataView(id.buffer).setUint32(0, sequence)
  id.set(generation.subarray(0, 4), 4)
  new DataView(id.buffer).setBigUint64(8, serial)

  return id
}

const stateIdKey = (stateid: Uint8Array): string => bytesKey(stateid.subarray(4))

const stateIdSequence = (stateid: Uint8Array): number =>
  new DataView(stateid.buffer, stateid.byteOffset, stateid.byteLength).getUint32(0)

const isAllZero = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0)

const isAllOnes = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0xff)

const isCurrentStateId = (stateid: Uint8Array): boolean =>
  stateIdSequence(stateid) === 1 && isAllZero(stateid.subarray(4))

const makeCookieVerifier = (generation: Uint8Array, revision: bigint): Uint8Array => {
  const result = generation.slice(0, 8)
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength)
  view.setBigUint64(0, view.getBigUint64(0) ^ BigInt.asUintN(64, revision))

  return result
}

/**
 * Operations that change server state before the reply size is known. READ belongs here
 * because reading updates the file's access time, which a slot rollback cannot undo.
 */
const stateChangingKinds: ReadonlySet<ParsedOperation["kind"]> = new Set([
  "Read",
  "Open",
  "Close",
  "OpenDowngrade",
  "ExchangeId",
  "CreateSession",
  "DestroySession",
  "DestroyClient",
  "ReclaimComplete"
])

/**
 * Lower bound on the encoded reply so SEQUENCE can reject a request that could never fit.
 * Variable-size results are bounded optimistically so small actual replies still fit a small
 * channel, and the slot is rolled back if the encoded reply proves too large. When the compound
 * also changes state, every variable result uses its worst case instead, because a rollback
 * cannot undo the state change.
 */
const replayReplyBound = (
  operations: ReadonlyArray<ParsedOperation>,
  tagBytes: number,
  limits: Nfs4Limits
): number => {
  let bytes = 12 + tagBytes + (4 - tagBytes % 4) % 4
  const worstCase = operations.some((operation) => stateChangingKinds.has(operation.kind))
  const maxReadBytes = ByteSize.toNumberUnsafe(limits.maxReadBytes)
  const maxReaddirReplyBytes = ByteSize.toNumberUnsafe(limits.maxReaddirReplyBytes)
  const maxStringBytes = ByteSize.toNumberUnsafe(limits.maxStringBytes)

  // Each bound covers the 8-byte operation header plus the result body.
  for (const operation of operations) {
    switch (operation.kind) {
      case "Read":
        bytes += worstCase ? 16 + Math.min(operation.value.count, maxReadBytes) + 4 : 32
        break
      case "Readdir":
        bytes += worstCase ? 16 + Math.min(operation.value.maxcount, maxReaddirReplyBytes) + 8 : 32
        break
      case "Getattr":
        bytes += worstCase ? MAX_GETATTR_REPLY_BYTES : 32
        break
      case "Readlink":
        bytes += worstCase ? 12 + maxStringBytes + 4 : 32
        break
      case "Getfh":
        bytes += 64
        break
      case "Sequence":
        bytes += 44
        break
      case "ExchangeId":
        bytes += 8 + 8 + 4 + 4 + 4 + 8 + 20 + 20 + 4
        break
      case "CreateSession":
        bytes += 8 + 16 + 4 + 4 + 28 + 32
        break
      case "Open":
        bytes += 8 + 16 + 4 + 16 + 4 + 8 + 8
        break
      case "Close":
      case "OpenDowngrade":
        bytes += 8 + 16
        break
      case "TestStateid":
        bytes += 12 + 4 * operation.value.length
        break
      case "Secinfo":
      case "SecinfoNoName":
      case "BindConnToSession":
        bytes += 32
        break
      default:
        bytes += 16
    }

    if (bytes > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
  }

  return bytes
}

export const makeNfs4Handler = (
  export_: NfsExport,
  options: Nfs4Options
): Effect.Effect<Nfs4Handler, never, Scope.Scope> => {
  assertOptions(options)

  return Effect.gen(function*() {
    const handlerScope = yield* Effect.scope
    const clients = new Map<bigint, ClientState>()
    const clientsByOwner = new Map<string, ClientState>()
    const sessions = new Map<string, SessionState>()
    const opens = new Map<string, OpenState>()
    let clientSerial = 1n
    let sessionSerial = 1n
    let openSerial = 1n
    let replayBytes = ByteSize.bytes(0)
    const maxRpcRequestBytes = ByteSize.min(options.limits.maxRecordBytes, options.limits.maxCompoundBytes)
    const maxRpcResponseBytes = ByteSize.min(options.limits.maxRecordBytes, options.limits.maxCompoundBytes)
    const rpcReplyOverheadBytes = ByteSize.bytes(24)
    const stateGate = Semaphore.makeUnsafe(1)

    /**
     * Callbacks awaiting a reply, keyed by RPC xid. Deliberately outside `stateGate`: a reply
     * arrives on the same connection that is running the read loop, so making the reply path take
     * the gate would deadlock against a compound that is holding it.
     */
    const pendingCallbacks = new Map<number, Deferred.Deferred<Uint8Array | undefined>>()
    let callbackXid = 1

    /**
     * Sends one callback down a session's backchannel and waits for the client's reply. Answers
     * `undefined` when no connection carries the backchannel, the write fails, or the client
     * never answers, which the caller records as the callback path being down.
     */
    const callback = (
      session: SessionState,
      procedure: number,
      body: Uint8Array
    ): Effect.Effect<Uint8Array | undefined> =>
      Effect.gen(function*() {
        const back = session.back

        if (back === undefined || back.security === undefined) return undefined

        const carrier = [...session.connections]
          .find(([, direction]) => (direction & CHANNEL_BACK) !== 0)?.[0]

        if (carrier === undefined) return undefined

        const xid = callbackXid++
        const reply = yield* Deferred.make<Uint8Array | undefined>()
        pendingCallbacks.set(xid, reply)

        const answered = yield* Effect.ensuring(
          Effect.gen(function*() {
            const sent = yield* carrier.send(
              encodeCallbackCall(xid, back.program, procedure, back.security!, body)
            )

            if (!sent) return undefined

            return yield* Deferred.await(reply).pipe(
              Effect.timeoutOption(options.callbackTimeout),
              Effect.map(Option.getOrUndefined)
            )
          }),
          Effect.sync(() => pendingCallbacks.delete(xid))
        )

        return answered
      })

    const revokeClient = (client: ClientState): Effect.Effect<void> =>
      Effect.gen(function*() {
        for (const [key, session] of sessions) {
          if (session.client !== client) continue

          for (const slot of session.slots) {
            replayBytes = subtractBytes(replayBytes, slot.retainedBytes ?? ByteSize.bytes(0))
          }

          sessions.delete(key)
        }

        for (const [key, open] of opens) {
          if (open.client !== client) continue
          yield* open.close
          opens.delete(key)
        }
      })

    const releaseCreateSessionReplay = (client: ClientState): void => {
      replayBytes = subtractBytes(replayBytes, client.createSessionReplay?.retainedBytes ?? ByteSize.bytes(0))
      client.createSessionReplay = undefined
    }

    const removeClientRecord = (client: ClientState): void => {
      releaseCreateSessionReplay(client)
      clients.delete(client.id)

      if (clientsByOwner.get(client.owner) !== client) return

      if (client.previous !== undefined && clients.has(client.previous.id)) {
        clientsByOwner.set(client.owner, client.previous)
      } else {
        clientsByOwner.delete(client.owner)
      }
    }

    const sweepExpired = Effect.gen(function*() {
      const now = options.now()

      for (const client of clients.values()) {
        if (now <= client.leaseExpiresAt) continue
        yield* revokeClient(client)
        removeClientRecord(client)
      }
    })

    yield* Effect.addFinalizer(() => Effect.forEach(opens.values(), (open) => open.close, { discard: true }))

    /** Reads only the leading SEQUENCE of a compound to find its session, tolerating later decode errors. */
    const sequenceSessionOf = (
      bytes: Uint8Array
    ): { readonly session: SessionState; readonly operationCount: number } | undefined => {
      try {
        const reader = new Reader(bytes, options.limits)
        reader.opaque(options.limits.maxStringBytes)
        const minor = reader.uint32()
        const operationCount = reader.uint32()

        if (minor !== 1 || reader.uint32() !== Operation.SEQUENCE) return undefined

        const session = sessions.get(bytesKey(reader.fixedOpaque(16)))

        return session === undefined ? undefined : { session, operationCount }
      } catch (error) {
        if (error instanceof XdrDecodeError) return undefined
        throw error
      }
    }

    const executeCompound = (call: CompoundCall): Effect.Effect<Uint8Array> =>
      Effect.suspend(() => {
        let parsed: ReturnType<typeof parseCompound>

        try {
          parsed = parseCompound(call.arguments, options.limits)
        } catch (error) {
          if (!(error instanceof XdrDecodeError)) throw error

          const tag = (() => {
            try {
              return new Reader(call.arguments, options.limits).opaque(options.limits.maxStringBytes)
            } catch (tagError) {
              if (!(tagError instanceof XdrDecodeError)) throw tagError

              return empty
            }
          })()

          // Section 2.10.6.4: an oversized request is reported as such even when later
          // operations fail to decode.
          const oversized = sequenceSessionOf(call.arguments)

          if (
            oversized !== undefined &&
            (call.requestBytes ?? call.arguments.length) > oversized.session.fore.maxRequest
          ) {
            return Effect.succeed(encodeCompound(tag, [{ code: Operation.SEQUENCE, status: Status.REQ_TOO_BIG }]))
          }

          if (oversized !== undefined && oversized.operationCount > oversized.session.fore.maxOperations) {
            return Effect.succeed(encodeCompound(tag, [{ code: Operation.SEQUENCE, status: Status.TOO_MANY_OPS }]))
          }

          return Effect.succeed(encodeCompound(tag, [], Status.BADXDR))
        }

        if (parsed.minor !== 1) {
          return Effect.succeed(encodeCompound(parsed.tag, [], Status.MINOR_VERS_MISMATCH))
        }

        const first = parsed.operations[0]
        const firstCode = first?.code

        // Section 18.46.3: the operations that may start a compound without SEQUENCE.
        const isBootstrap = firstCode === Operation.EXCHANGE_ID || firstCode === Operation.CREATE_SESSION ||
          firstCode === Operation.DESTROY_SESSION || firstCode === Operation.DESTROY_CLIENTID ||
          firstCode === Operation.BIND_CONN_TO_SESSION

        const isSoleBootstrap = parsed.operations.length === 1 && isBootstrap

        if (first !== undefined && firstCode !== Operation.SEQUENCE && !isSoleBootstrap) {
          // Sections 15.2 and 18.52: an illegal opcode answers as OP_ILLEGAL whether or not a
          // session exists, and arguments are decoded before any session check.
          if (first.kind === "Unknown") {
            return Effect.succeed(
              encodeCompound(parsed.tag, [{ code: Operation.ILLEGAL, status: Status.OP_ILLEGAL }])
            )
          }

          if (first.kind === "Malformed") {
            return Effect.succeed(encodeCompound(parsed.tag, [{ code: first.code, status: Status.BADXDR }]))
          }

          // Sections 18.34.3, 18.35.3, 18.36.3, 18.37.3, and 18.50.3: these MUST be the only operation.
          if (isBootstrap) {
            return Effect.succeed(
              encodeCompound(parsed.tag, [{ code: firstCode, status: Status.NOT_ONLY_OP }])
            )
          }

          // Section 15.2 allows only NFS4ERR_NOTSUPP for the NFSv4.0 operations.
          if (mustNotImplementOperations.has(firstCode!)) {
            return Effect.succeed(
              encodeCompound(parsed.tag, [{ code: firstCode!, status: Status.NOTSUPP }])
            )
          }

          return Effect.succeed(
            encodeCompound(parsed.tag, [{ code: firstCode!, status: Status.OP_NOT_IN_SESSION }])
          )
        }

        if (first?.kind === "Sequence") {
          const value = first.value
          const session = sessions.get(bytesKey(value.session))
          const slot = session?.slots[value.slot]

          if (
            session !== undefined && slot !== undefined && value.sequence === slot.sequence &&
            slot.response !== undefined
          ) {
            if (!sameRequest(slot.request, call.arguments) || slot.credentials !== credentialsKey(call.credentials)) {
              return Effect.succeed(
                encodeCompound(parsed.tag, [{ code: Operation.SEQUENCE, status: Status.SEQ_FALSE_RETRY }])
              )
            }

            // Section 2.10.3.1 ties association to SEQUENCE being transmitted, and a retry is
            // transmitted like any other request. A client that reconnects after a reset and
            // retransmits must end up associated, or its next DESTROY_SESSION would be refused.
            associate(session, call.connection, CHANNEL_FORE)

            return Effect.succeed(new Uint8Array(slot.response))
          }
        }

        let rollbackSequence: (() => void) | undefined

        return Effect.gen(function*() {
          const parts: Array<ResultPart> = []
          let current: CurrentObject | undefined
          let saved: CurrentObject | undefined
          // Section 16.2.3.1.2: the current and saved stateids travel with their filehandles.
          // `undefined` is the all-zeros special stateid.
          let currentStateid: Uint8Array | undefined
          let savedStateid: Uint8Array | undefined
          let activeSession: SessionState | undefined
          let activeSlot: ReplaySlot | undefined
          let shouldCache = false

          for (let index = 0; index < parsed.operations.length; index++) {
            const operation = parsed.operations[index]!
            let result: ResultPart

            result = yield* execute(operation)
            parts.push(result)

            if (result.status !== Status.OK) break
          }

          const response = encodeCompound(parsed.tag, parts)
          const responseBytes = addBytes(byteLength(response.length), rpcReplyOverheadBytes)

          if (responseBytes > byteLength(activeSession?.fore.maxResponse ?? Number.MAX_SAFE_INTEGER)) {
            rollbackSequence?.()
            rollbackSequence = undefined

            return encodeCompound(parsed.tag, [{ code: Operation.SEQUENCE, status: Status.REP_TOO_BIG }])
          }

          if (
            shouldCache &&
            responseBytes > byteLength(activeSession?.fore.maxCachedResponse ?? Number.MAX_SAFE_INTEGER)
          ) {
            rollbackSequence?.()
            rollbackSequence = undefined

            return encodeCompound(parsed.tag, [{ code: Operation.SEQUENCE, status: Status.REP_TOO_BIG_TO_CACHE }])
          }

          if (activeSlot !== undefined && shouldCache) {
            const retainedBytes = addBytes(byteLength(call.arguments.length), byteLength(response.length))

            if (
              retainedBytes > options.limits.maxReplayBytes ||
              addBytes(replayBytes, retainedBytes) > options.limits.maxReplayBytes
            ) {
              rollbackSequence?.()
              rollbackSequence = undefined

              return encodeCompound(parsed.tag, [{ code: Operation.SEQUENCE, status: Status.REP_TOO_BIG_TO_CACHE }])
            }

            replayBytes = subtractBytes(replayBytes, activeSlot.retainedBytes ?? ByteSize.bytes(0))
            activeSlot.response = new Uint8Array(response)
            activeSlot.request = new Uint8Array(call.arguments)
            activeSlot.credentials = credentialsKey(call.credentials)
            activeSlot.retainedBytes = retainedBytes
            replayBytes = addBytes(replayBytes, retainedBytes)
          } else if (activeSlot !== undefined) {
            const sequencePart = parts[0]!
            const second = parsed.operations[1]

            const replay = second === undefined
              ? encodeCompound(parsed.tag, [sequencePart])
              : encodeCompound(parsed.tag, [
                sequencePart,
                { code: second.code, status: Status.RETRY_UNCACHED_REP }
              ])

            const retainedBytes = addBytes(byteLength(call.arguments.length), byteLength(replay.length))

            if (addBytes(replayBytes, retainedBytes) > options.limits.maxReplayBytes) {
              rollbackSequence?.()
              rollbackSequence = undefined

              return encodeCompound(parsed.tag, [{ code: Operation.SEQUENCE, status: Status.DELAY }])
            }

            activeSlot.response = replay
            activeSlot.request = new Uint8Array(call.arguments)
            activeSlot.credentials = credentialsKey(call.credentials)
            activeSlot.retainedBytes = retainedBytes
            replayBytes = addBytes(replayBytes, retainedBytes)
          }

          rollbackSequence = undefined

          return response

          function execute(operation: ParsedOperation): Effect.Effect<ResultPart> {
            const noCurrent = (): ResultPart => ({ code: operation.code, status: Status.NOFILEHANDLE })

            const mapFs = <A>(effect: Effect.Effect<A, Vfs.FsError>): Effect.Effect<A, number> =>
              effect.pipe(Effect.mapError(failureForFs))

            const withCurrent = <A>(
              f: (reference: Vfs.ObjectReference) => Effect.Effect<A, number>
            ): Effect.Effect<A, number> => current === undefined ? Effect.fail(Status.NOFILEHANDLE) : f(current)

            const statusResult = <A>(
              effect: Effect.Effect<A, number>,
              success: (value: A) => Uint8Array | undefined = () => undefined
            ) =>
              effect.pipe(
                Effect.map((value): ResultPart => {
                  const body = success(value)

                  return body === undefined
                    ? { code: operation.code, status: Status.OK }
                    : { code: operation.code, status: Status.OK, body }
                }),
                Effect.catch((status): Effect.Effect<ResultPart> => Effect.succeed({ code: operation.code, status }))
              )

            const requireAttributes = (attributes: Uint8Array | undefined): Effect.Effect<Uint8Array, number> =>
              attributes === undefined ? Effect.fail(Status.SERVERFAULT) : Effect.succeed(attributes)

            /** Registers a filehandle only when the `filehandle` attribute (19) is requested. */
            const filehandleFor = (
              reference: Vfs.ObjectReference,
              requested: ReadonlyArray<number>
            ): Effect.Effect<Uint8Array, number> =>
              requested.includes(19)
                ? export_.handleFor(reference).pipe(Effect.mapError(() => Status.SERVERFAULT))
                : Effect.succeed(empty)

            /**
             * Requires a directory. Only operations whose Section 15.2 error list includes
             * NFS4ERR_SYMLINK may report a symbolic link as such; the others say NOTDIR.
             */
            const requireDirectory = (
              reference: Vfs.ObjectReference,
              symlinkStatus: number
            ): Effect.Effect<void, number> =>
              mapFs(export_.observeMetadata(reference)).pipe(
                Effect.flatMap((observation) =>
                  observation.value.kind === "directory"
                    ? Effect.void
                    : Effect.fail(observation.value.kind === "symlink" ? symlinkStatus : Status.NOTDIR)
                )
              )

            const parentOfDirectory = (
              reference: Vfs.ObjectReference,
              symlinkStatus: number
            ): Effect.Effect<Vfs.ObjectReference, number> =>
              requireDirectory(reference, symlinkStatus).pipe(Effect.flatMap(() => parentOf(reference)))

            /** Requires a regular file, naming the offending type as Sections 18.16.4 and 18.22.3 do. */
            const requireRegularFile = (reference: Vfs.ObjectReference): Effect.Effect<void, number> =>
              mapFs(export_.observeMetadata(reference)).pipe(
                Effect.flatMap((observation) => {
                  switch (observation.value.kind) {
                    case "file":
                      return Effect.void
                    case "directory":
                      return Effect.fail(Status.ISDIR)
                    case "symlink":
                      return Effect.fail(Status.SYMLINK)
                    default:
                      // The core has no other object kinds today; this keeps the switch exhaustive.
                      return Effect.fail(Status.WRONG_TYPE)
                  }
                })
              )

            /**
             * Validates a mutating operation's filehandles and names before the read-only
             * rejection, so structural errors keep their RFC 8881 precedence over NFS4ERR_ROFS.
             */
            const rejectMutation = (
              names: ReadonlyArray<Uint8Array>,
              savedRequirement: "none" | "object" | "directory",
              symlinkStatus: number
            ): Effect.Effect<ResultPart> => {
              if (current === undefined) return Effect.succeed(noCurrent())

              if (savedRequirement !== "none" && saved === undefined) return Effect.succeed(noCurrent())
              const savedDirectory = saved

              const checks = requireDirectory(current, symlinkStatus).pipe(
                Effect.flatMap(() =>
                  savedRequirement === "directory" && savedDirectory !== undefined
                    ? requireDirectory(savedDirectory, symlinkStatus)
                    : Effect.void
                ),
                Effect.flatMap(() =>
                  Effect.suspend(() => {
                    for (const name of names) {
                      try {
                        validateName(name, options.limits.maxNameBytes)
                      } catch (error) {
                        if (error instanceof InvalidNameError) return Effect.fail(nameStatus(error))
                        throw error
                      }
                    }

                    return Effect.fail(Status.ROFS)
                  })
                )
              )

              return statusResult(checks)
            }

            switch (operation.kind) {
              case "ExchangeId": {
                const value = operation.value

                if ((value.flags & ~EXCHGID4_ALLOWED_ARGUMENT_FLAGS) !== 0) {
                  return Effect.succeed({ code: operation.code, status: Status.INVAL })
                }

                // Section 18.35.3: SP4_MACH_CRED requires an RPCSEC_GSS integrity-protected
                // EXCHANGE_ID, which AUTH_SYS cannot provide, and no SSV algorithm is offered.
                // These are the answers Linux nfsd gives in the same situation.
                if (value.protection === SP4_MACH_CRED) {
                  return Effect.succeed({ code: operation.code, status: Status.INVAL })
                }

                if (value.protection === SP4_SSV) {
                  return Effect.succeed({ code: operation.code, status: Status.ENCR_ALG_UNSUPP })
                }

                const owner = bytesKey(value.owner)
                const verifier = bytesKey(value.verifier)
                const principal = principalKey(call.credentials)
                const updateConfirmed = (value.flags & 0x4000_0000) !== 0

                const confirmedRecord = [...clients.values()].find((candidate) =>
                  candidate.owner === owner && candidate.confirmed
                )

                let client: ClientState | undefined

                if (updateConfirmed) {
                  // Section 18.35.4 cases 6 to 9.
                  if (confirmedRecord === undefined) {
                    return Effect.succeed({ code: operation.code, status: Status.NOENT })
                  }

                  if (confirmedRecord.verifier !== verifier) {
                    return Effect.succeed({ code: operation.code, status: Status.NOT_SAME })
                  }

                  // Case 9 prescribes NFS4ERR_PERM even though the Section 15.2 list for
                  // EXCHANGE_ID omits it; the normative case description wins.
                  if (confirmedRecord.principal !== principal) {
                    return Effect.succeed({ code: operation.code, status: Status.PERM })
                  }

                  client = confirmedRecord
                } else if (
                  confirmedRecord !== undefined && confirmedRecord.verifier === verifier &&
                  confirmedRecord.principal === principal
                ) {
                  // Case 2: a retry or trunking probe against the confirmed record.
                  client = confirmedRecord
                }

                if (client === undefined) {
                  return Effect.gen(function*() {
                    const currentClient = clientsByOwner.get(owner)

                    if (currentClient === undefined && clientsByOwner.size >= options.limits.maxClients) {
                      return { code: operation.code, status: Status.DELAY } satisfies ResultPart
                    }

                    let previous: ClientState | undefined

                    if (confirmedRecord !== undefined && confirmedRecord.principal !== principal) {
                      // Case 3: owner collision with another principal. Live state protects the
                      // confirmed record; otherwise it is replaced outright.
                      const hasState = [...sessions.values()].some((session) => session.client === confirmedRecord) ||
                        [...opens.values()].some((open) => open.client === confirmedRecord)

                      if (hasState && options.now() <= confirmedRecord.leaseExpiresAt) {
                        return { code: operation.code, status: Status.CLID_INUSE } satisfies ResultPart
                      }

                      yield* revokeClient(confirmedRecord)
                      removeClientRecord(confirmedRecord)
                    } else if (confirmedRecord !== undefined) {
                      // Case 5: client restart. The confirmed record survives until CREATE_SESSION.
                      if (
                        [...clients.values()].filter((candidate) =>
                            !candidate.confirmed && candidate.previous !== undefined
                          )
                            .length >= options.limits.maxPendingClientReplacements &&
                        !(currentClient !== undefined && !currentClient.confirmed)
                      ) {
                        return { code: operation.code, status: Status.DELAY } satisfies ResultPart
                      }

                      previous = confirmedRecord
                    }

                    // Case 4: any unconfirmed record for this owner is replaced by a new client ID.
                    const unconfirmed = clientsByOwner.get(owner)

                    if (unconfirmed !== undefined && !unconfirmed.confirmed) {
                      releaseCreateSessionReplay(unconfirmed)
                      clients.delete(unconfirmed.id)
                    }

                    const created: ClientState = {
                      id: clientSerial++,
                      owner,
                      verifier,
                      principal,
                      previous,
                      sequence: 1,
                      leaseExpiresAt: options.now() + options.leaseDurationSeconds * 1000,
                      reclaimed: false,
                      confirmed: false,
                      createSessionReplay: undefined
                    }

                    clients.set(created.id, created)
                    clientsByOwner.set(owner, created)

                    return exchangeIdResult(created)
                  })
                }

                return Effect.succeed(exchangeIdResult(client))

                function exchangeIdResult(client: ClientState): ResultPart {
                  const body = encodeStatusBody((writer) => {
                    const flags = EXCHGID4_FLAG_USE_NON_PNFS |
                      (client.confirmed ? EXCHGID4_FLAG_CONFIRMED_R : 0)

                    writer.uint64(client.id).uint32(client.sequence).uint32(flags >>> 0).uint32(0)
                    writer.uint64(export_.fsid[0]).opaque(options.generation).opaque(options.generation)
                    writer.array([], () => undefined)
                  })

                  return { code: operation.code, status: Status.OK, body }
                }
              }

              case "CreateSession": {
                const value = operation.value
                const client = clients.get(value.client)

                if (client === undefined) return Effect.succeed({ code: operation.code, status: Status.STALE_CLIENTID })
                const replay = client.createSessionReplay

                if (replay?.sequence === value.sequence) {
                  // Section 18.36.4 phase 2: an equal csa_sequence identifies a retry, which may
                  // arrive with or without a preceding SEQUENCE; the cached result is returned
                  // before any argument validation.
                  const result: ResultPart = replay.body === undefined
                    ? { code: operation.code, status: replay.status }
                    : { code: operation.code, status: replay.status, body: new Uint8Array(replay.body) }

                  return Effect.succeed(result)
                }

                if (value.sequence !== client.sequence) {
                  return Effect.succeed({ code: operation.code, status: Status.SEQ_MISORDERED })
                }

                // Section 18.36.4 phase 2: a request with the expected csa_sequence consumes the
                // slot and its result is cached, whether or not a session is created. Two outcomes
                // leave the slot alone: NFS4ERR_DELAY asks for the same request again later, and
                // NFS4ERR_CLID_INUSE comes from a principal that does not own the record.
                const complete = (status: number, body?: Uint8Array): ResultPart => {
                  const previousRetainedBytes = client.createSessionReplay?.retainedBytes ?? ByteSize.bytes(0)
                  const retainedBytes = byteLength(body?.length ?? 0)
                  replayBytes = subtractBytes(replayBytes, previousRetainedBytes)
                  replayBytes = addBytes(replayBytes, retainedBytes)
                  client.sequence = nextSequenceId(client.sequence)

                  const nextReplay: CreateSessionReplay = {
                    sequence: value.sequence,
                    status,
                    retainedBytes
                  }

                  client.createSessionReplay = body === undefined
                    ? nextReplay
                    : { ...nextReplay, body: new Uint8Array(body) }

                  return body === undefined
                    ? { code: operation.code, status }
                    : { code: operation.code, status, body }
                }

                return Effect.gen(function*() {
                  const previousRetainedBytes = client.createSessionReplay?.retainedBytes ?? ByteSize.bytes(0)

                  // Section 18.36.4 phase 3: an unconfirmed record belongs to the principal that
                  // created it. A confirmed client may create sessions from any principal.
                  if (!client.confirmed && client.principal !== principalKey(call.credentials)) {
                    return { code: operation.code, status: Status.CLID_INUSE }
                  }

                  if ((value.flags & ~CREATE_SESSION4_KNOWN_FLAGS) !== 0) return complete(Status.INVAL)

                  // Section 18.36.3: a callback security entry naming an RPCSEC_GSS handle the
                  // server did not issue is NFS4ERR_NOENT.
                  if (value.gssCallback) return complete(Status.NOENT)

                  const requestedSlots = Math.max(1, value.fore.maxRequests)
                  const slotCount = Math.min(requestedSlots, options.limits.maxSlotsPerSession)

                  const fore: ChannelAttrs = {
                    headerPadding: 0,
                    maxRequest: Math.min(value.fore.maxRequest, ByteSize.toNumberUnsafe(maxRpcRequestBytes)),
                    maxResponse: Math.min(value.fore.maxResponse, ByteSize.toNumberUnsafe(maxRpcResponseBytes)),
                    maxCachedResponse: Math.min(
                      value.fore.maxCachedResponse,
                      ByteSize.toNumberUnsafe(options.limits.maxReplayBytes)
                    ),
                    maxOperations: Math.min(value.fore.maxOperations, options.limits.maxOperations),
                    maxRequests: slotCount,
                    rdmaIrd: []
                  }

                  const id = makeOpaqueId(options.generation, sessionSerial++)

                  // Section 18.36.3: the backchannel exists only if the client asked for one. The
                  // agreed flag must be echoed in csr_flags, because the client binds the
                  // connection to the backchannel on the strength of that echo.
                  const wantsBackChannel = (value.flags & CREATE_SESSION4_FLAG_CONN_BACK_CHAN) !== 0

                  const backSlots = Math.min(
                    Math.max(1, value.back.maxRequests),
                    options.limits.maxSlotsPerSession
                  )

                  const back: ChannelAttrs = {
                    ...value.back,
                    headerPadding: 0,
                    maxRequests: backSlots,
                    rdmaIrd: []
                  }

                  const agreedFlags = wantsBackChannel ? CREATE_SESSION4_FLAG_CONN_BACK_CHAN : 0

                  const body = encodeStatusBody((writer) => {
                    writer.fixedOpaque(id).uint32(value.sequence).uint32(agreedFlags)
                    writeChannelAttrs(writer, fore)
                    writeChannelAttrs(writer, back)
                  })

                  // Section 18.36.3: a channel that can never carry a SEQUENCE compound in either
                  // direction, or fewer than two operations, is too small to be used.
                  if (
                    fore.maxRequest < MIN_FORE_REQUEST_BYTES || fore.maxResponse < MIN_FORE_RESPONSE_BYTES ||
                    value.back.maxRequest < MIN_FORE_REQUEST_BYTES ||
                    value.back.maxResponse < MIN_FORE_RESPONSE_BYTES ||
                    fore.maxOperations < 2
                  ) {
                    return complete(Status.TOOSMALL)
                  }

                  // The cached reply is charged against the replay budget; reserve it from the encoded body.
                  if (
                    byteLength(body.length) >
                      subtractBytes(options.limits.maxReplayBytes, subtractBytes(replayBytes, previousRetainedBytes))
                  ) {
                    return { code: operation.code, status: Status.DELAY }
                  }

                  if (client.previous !== undefined) {
                    const previousSessions = [...sessions.values()].filter((session) =>
                      session.client === client.previous
                    ).length

                    if (sessions.size - previousSessions >= options.limits.maxSessions) {
                      return { code: operation.code, status: Status.DELAY }
                    }

                    yield* revokeClient(client.previous)
                    removeClientRecord(client.previous)
                  } else if (sessions.size >= options.limits.maxSessions) {
                    return { code: operation.code, status: Status.DELAY }
                  }

                  // Section 18.36.3: the connection CREATE_SESSION arrived on is associated with
                  // the session's fore channel without a further BIND_CONN_TO_SESSION.
                  sessions.set(bytesKey(id), {
                    id,
                    client,
                    fore,
                    slots: Array.from({ length: slotCount }, () => ({ sequence: 0 })),
                    // Section 2.10.3.1: the CREATE_SESSION connection is associated with the fore
                    // channel, and with the backchannel too when one was agreed.
                    connections: new Map([[
                      call.connection,
                      CHANNEL_FORE | (wantsBackChannel ? CHANNEL_BACK : 0)
                    ]]),
                    back: wantsBackChannel
                      ? {
                        program: value.callbackProgram,
                        security: chooseCallbackSecurity(value.security),
                        attrs: back,
                        slots: Array.from({ length: backSlots }, () => ({ sequence: 0, busy: false })),
                        // A client that authorized no encodable credential gets no callbacks, so
                        // the path starts down rather than being probed with a flavor it never
                        // offered.
                        healthy: chooseCallbackSecurity(value.security) !== undefined,
                        probed: false
                      }
                      : undefined
                  })
                  client.confirmed = true
                  client.leaseExpiresAt = options.now() + options.leaseDurationSeconds * 1000

                  return complete(Status.OK, body)
                })
              }

              case "Sequence": {
                if (parts.length !== 0) return Effect.succeed({ code: operation.code, status: Status.SEQUENCE_POS })
                const value = operation.value
                const session = sessions.get(bytesKey(value.session))

                if (session === undefined) return Effect.succeed({ code: operation.code, status: Status.BADSESSION })

                if (options.now() > session.client.leaseExpiresAt) {
                  return revokeClient(session.client).pipe(
                    Effect.as({ code: operation.code, status: Status.BADSESSION })
                  )
                }

                // Section 2.10.3.1: under SP4_NONE the connection a SEQUENCE is transmitted on is
                // associated with the session's fore channel. Association follows transmission, so
                // it happens before the slot and size checks that may still reject this request.
                associate(session, call.connection, CHANNEL_FORE)

                if (value.slot >= session.slots.length) {
                  return Effect.succeed({ code: operation.code, status: Status.BADSLOT })
                }

                if (value.highest >= session.slots.length) {
                  return Effect.succeed({ code: operation.code, status: Status.BAD_HIGH_SLOT })
                }

                const slot = session.slots[value.slot]!

                if ((call.requestBytes ?? call.arguments.length) > session.fore.maxRequest) {
                  return Effect.succeed({ code: operation.code, status: Status.REQ_TOO_BIG })
                }

                // The header count is checked, so a malformed later operation cannot hide an
                // oversized compound.
                if (parsed.count > session.fore.maxOperations) {
                  return Effect.succeed({ code: operation.code, status: Status.TOO_MANY_OPS })
                }

                const replyBound = replayReplyBound(parsed.operations, parsed.tag.length, options.limits)
                const rpcReplyBound = addBytes(byteLength(replyBound), rpcReplyOverheadBytes)

                if (rpcReplyBound > byteLength(session.fore.maxResponse)) {
                  return Effect.succeed({ code: operation.code, status: Status.REP_TOO_BIG })
                }

                if (value.cache && rpcReplyBound > byteLength(session.fore.maxCachedResponse)) {
                  return Effect.succeed({ code: operation.code, status: Status.REP_TOO_BIG_TO_CACHE })
                }

                if (value.sequence !== nextSequenceId(slot.sequence)) {
                  return Effect.succeed({ code: operation.code, status: Status.SEQ_MISORDERED })
                }

                const uncachedReplayBound = 96 + parsed.tag.length + (4 - parsed.tag.length % 4) % 4

                const retainedBound = addBytes(
                  byteLength(call.arguments.length),
                  byteLength(value.cache ? replyBound : uncachedReplayBound)
                )

                if (
                  retainedBound > subtractBytes(
                    options.limits.maxReplayBytes,
                    subtractBytes(replayBytes, slot.retainedBytes ?? ByteSize.bytes(0))
                  )
                ) {
                  // Replay memory is a server policy limit: a cached reply is "too big to cache",
                  // and an uncached request can only be retried later.
                  return Effect.succeed({
                    code: operation.code,
                    status: value.cache ? Status.REP_TOO_BIG_TO_CACHE : Status.DELAY
                  })
                }

                const previousSlot = {
                  sequence: slot.sequence,
                  response: slot.response,
                  request: slot.request,
                  credentials: slot.credentials,
                  retainedBytes: slot.retainedBytes
                }

                rollbackSequence = () => {
                  // Restore only this slot's accounting; other operations in the compound may have
                  // changed the shared counter legitimately.
                  replayBytes = addBytes(replayBytes, previousSlot.retainedBytes ?? ByteSize.bytes(0))
                  slot.sequence = previousSlot.sequence

                  if (previousSlot.response === undefined) delete slot.response
                  else slot.response = previousSlot.response

                  if (previousSlot.request === undefined) delete slot.request
                  else slot.request = previousSlot.request

                  if (previousSlot.credentials === undefined) delete slot.credentials
                  else slot.credentials = previousSlot.credentials

                  if (previousSlot.retainedBytes === undefined) delete slot.retainedBytes
                  else slot.retainedBytes = previousSlot.retainedBytes
                }

                replayBytes = subtractBytes(replayBytes, slot.retainedBytes ?? ByteSize.bytes(0))
                slot.sequence = value.sequence
                delete slot.response
                delete slot.request
                delete slot.credentials
                delete slot.retainedBytes
                session.client.leaseExpiresAt = options.now() + options.leaseDurationSeconds * 1000
                activeSession = session
                activeSlot = slot
                shouldCache = value.cache

                const body = encodeStatusBody((writer) => {
                  writer.fixedOpaque(session.id).uint32(value.sequence).uint32(value.slot)
                    .uint32(session.slots.length - 1).uint32(session.slots.length - 1).uint32(0)
                })

                // The callback path is probed once, on the first SEQUENCE rather than during
                // CREATE_SESSION, because only then is the client known to hold the session id
                // that CB_SEQUENCE carries. It is forked because the probe's own reply arrives on
                // this connection, whose read loop is busy with this compound until it returns.
                const back = session.back

                if (back === undefined || back.probed) {
                  return Effect.succeed({ code: operation.code, status: Status.OK, body })
                }

                back.probed = true

                return Effect.forkIn(probe(session), handlerScope).pipe(
                  Effect.as({ code: operation.code, status: Status.OK, body })
                )
              }

              case "ReclaimComplete": {
                if (activeSession === undefined) {
                  return Effect.succeed({ code: operation.code, status: Status.BADSESSION })
                }

                if (operation.value) {
                  // rca_one_fs applies to the current filehandle's file system only and does not
                  // complete the global reclaim (RFC 8881 Section 18.51.3).
                  return Effect.succeed(
                    current === undefined ? noCurrent() : { code: operation.code, status: Status.OK }
                  )
                }

                if (activeSession.client.reclaimed) {
                  return Effect.succeed({ code: operation.code, status: Status.COMPLETE_ALREADY })
                }

                activeSession.client.reclaimed = true

                return Effect.succeed({ code: operation.code, status: Status.OK })
              }

              case "BindConnToSession": {
                // Section 18.34.3: MUST be the only operation.
                if (parsed.operations.length !== 1) {
                  return Effect.succeed({ code: operation.code, status: Status.NOT_ONLY_OP })
                }

                const session = sessions.get(bytesKey(operation.value.session))

                if (session === undefined) return Effect.succeed({ code: operation.code, status: Status.BADSESSION })

                const requested = operation.value.direction

                // Section 18.34.3 fixes what each request may be answered with: CDFC4_FORE MUST
                // get CDFS4_FORE, CDFC4_BACK MUST get CDFS4_BACK, CDFC4_FORE_OR_BOTH MUST get
                // FORE or BOTH, and CDFC4_BACK_OR_BOTH MUST get BACK or BOTH. A request that
                // cannot be answered that way demands a change the server cannot make, which is
                // NFS4ERR_INVAL. Only a session that negotiated a backchannel in CREATE_SESSION
                // has one to bind, so both back-channel requests fail without it.
                const backAvailable = session.back !== undefined

                if (!backAvailable && (requested === CDFC4_BACK || requested === CDFC4_BACK_OR_BOTH)) {
                  return Effect.succeed({ code: operation.code, status: Status.INVAL })
                }

                const bound = requested === CDFC4_BACK
                  ? CHANNEL_BACK
                  : requested === CDFC4_FORE
                  ? CHANNEL_FORE
                  : CHANNEL_FORE | (backAvailable ? CHANNEL_BACK : 0)

                associate(session, call.connection, bound)

                const answered = bound === CHANNEL_BACK
                  ? CDFS4_BACK
                  : bound === CHANNEL_FORE
                  ? CDFS4_FORE
                  : CDFS4_BOTH

                return Effect.succeed({
                  code: operation.code,
                  status: Status.OK,
                  body: new Writer().fixedOpaque(session.id).uint32(answered).boolean(false).bytes()
                })
              }

              case "BackchannelCtl": {
                // Section 18.33.3: an RPCSEC_GSS handle the server never issued is NFS4ERR_NOENT.
                // AUTH_NONE and AUTH_SYS parameters are accepted as Linux nfsd does.
                if (operation.value.gssCallback) {
                  return Effect.succeed({ code: operation.code, status: Status.NOENT })
                }

                if (activeSession === undefined) {
                  return Effect.succeed({ code: operation.code, status: Status.BADSESSION })
                }

                // Section 18.33.3 changes the backchannel of the session the COMPOUND is running
                // on. Without a negotiated backchannel there is nothing to reconfigure.
                if (activeSession.back === undefined) {
                  return Effect.succeed({ code: operation.code, status: Status.INVAL })
                }

                activeSession.back.program = operation.value.program

                // Section 18.33.3 adds credentials rather than replacing them, but a re-offer is
                // the client's current authorization, so a newly offered flavor is adopted.
                const reoffered = chooseCallbackSecurity(operation.value.security)

                if (reoffered !== undefined) activeSession.back.security = reoffered
                // A re-advertised program is the client repairing its callback service, so give
                // the path another chance rather than leaving it marked down.
                activeSession.back.healthy = true

                return Effect.succeed({ code: operation.code, status: Status.OK })
              }

              case "DestroySession": {
                const key = bytesKey(operation.value)
                const session = sessions.get(key)

                if (session === undefined) {
                  return Effect.succeed({ code: operation.code, status: Status.BADSESSION })
                }

                // Section 18.37.3: only the active session's own DESTROY_SESSION must be final;
                // another session's may appear in any position after SEQUENCE.
                if (
                  session === activeSession &&
                  parsed.operations[parsed.operations.length - 1] !== operation
                ) {
                  return Effect.succeed({ code: operation.code, status: Status.NOT_ONLY_OP })
                }

                // Section 18.37.3: "DESTROY_SESSION MUST be invoked on a connection that is
                // associated with the session being destroyed." Without this a second connection
                // could destroy a session it never carried, using only an observed session id.
                if (!session.connections.has(call.connection)) {
                  return Effect.succeed({ code: operation.code, status: Status.CONN_NOT_BOUND_TO_SESSION })
                }

                for (const slot of session.slots) {
                  replayBytes = subtractBytes(replayBytes, slot.retainedBytes ?? ByteSize.bytes(0))
                }

                session.connections.clear()
                sessions.delete(key)

                if (session === activeSession) {
                  activeSlot = undefined
                  shouldCache = false
                  rollbackSequence = undefined
                }

                return Effect.succeed({ code: operation.code, status: Status.OK })
              }

              case "DestroyClient": {
                const client = clients.get(operation.value)

                if (client === undefined) {
                  return Effect.succeed({ code: operation.code, status: Status.STALE_CLIENTID })
                }

                const hasSession = [...sessions.values()].some((session) => session.client === client)
                const hasOpen = [...opens.values()].some((open) => open.client === client)

                if (hasSession || hasOpen) {
                  return Effect.succeed({ code: operation.code, status: Status.CLIENTID_BUSY })
                }

                removeClientRecord(client)

                return Effect.succeed({ code: operation.code, status: Status.OK })
              }

              case "Putrootfh":
              case "Putpubfh":
                // The public filehandle is the root filehandle (RFC 8881 Section 18.20.3).
                return statusResult(mapFs(export_.root), (reference) => {
                  setCurrent(reference)

                  return undefined
                })
              case "Putfh":
                return export_.resolve(operation.value).pipe(
                  Effect.map((reference): ResultPart => {
                    setCurrent(reference)

                    return { code: operation.code, status: Status.OK }
                  }),
                  Effect.catch((error: InvalidFilehandleError) =>
                    Effect.succeed({
                      code: operation.code,
                      status: error.reason === "WrongGeneration"
                        ? Status.FHEXPIRED
                        : error.reason === "Stale"
                        ? Status.STALE
                        : Status.BADHANDLE
                    })
                  )
                )
              case "Getfh":
                if (current === undefined) return Effect.succeed(noCurrent())

                return export_.handleFor(current).pipe(
                  Effect.map((handle): ResultPart => ({
                    code: operation.code,
                    status: Status.OK,
                    body: new Writer().opaque(handle).bytes()
                  })),
                  Effect.orElseSucceed(() => ({ code: operation.code, status: Status.SERVERFAULT }))
                )
              case "Savefh":
                if (current === undefined) return Effect.succeed(noCurrent())
                saved = current
                savedStateid = currentStateid

                return Effect.succeed({ code: operation.code, status: Status.OK })
              case "Restorefh":
                if (saved === undefined) return Effect.succeed(noCurrent())
                current = saved
                currentStateid = savedStateid

                return Effect.succeed({ code: operation.code, status: Status.OK })
              case "Lookup":
                // Section 15.1.2.8: a symbolic link as the current filehandle is NFS4ERR_SYMLINK.
                return statusResult(
                  withCurrent((reference) =>
                    requireDirectory(reference, Status.SYMLINK).pipe(
                      Effect.andThen(export_.lookup(reference, operation.value).pipe(Effect.mapError(nameStatus)))
                    )
                  ),
                  (reference) => {
                    setCurrent(reference)

                    return undefined
                  }
                )
              case "Secinfo":
                // SECINFO consumes the current filehandle (RFC 8881 Section 18.29.3).
                return statusResult(
                  withCurrent((reference) =>
                    export_.lookup(reference, operation.value).pipe(Effect.mapError(nameStatus))
                  ),
                  () => {
                    setCurrent(undefined)

                    return new Writer().array([AUTH_SYS, AUTH_NONE], (writer, flavor) => writer.uint32(flavor)).bytes()
                  }
                )
              case "Lookupp":
                return statusResult(
                  withCurrent((reference) => parentOfDirectory(reference, Status.SYMLINK)),
                  (reference) => {
                    setCurrent(reference)

                    return undefined
                  }
                )
              case "SecinfoNoName":
                // Like SECINFO, this consumes the current filehandle (RFC 8881 Section 18.45.3).
                // Its error list has NOTDIR but not SYMLINK.
                return statusResult(
                  withCurrent((reference) =>
                    operation.value === SECINFO_STYLE4_PARENT
                      ? parentOfDirectory(reference, Status.NOTDIR)
                      : Effect.succeed(reference)
                  ),
                  () => {
                    setCurrent(undefined)

                    return new Writer().array([AUTH_SYS, AUTH_NONE], (writer, flavor) => writer.uint32(flavor)).bytes()
                  }
                )
              case "Getattr": {
                if (current === undefined) return Effect.succeed(noCurrent())
                const reference = current
                const requested = requestedAttributes(operation.value)
                const supportedRequested = requested.filter((attribute) => supportedAttributes.includes(attribute))

                const attributes = filehandleFor(reference, supportedRequested).pipe(
                  Effect.flatMap((filehandle) =>
                    mapFs(export_.observeMetadata(reference)).pipe(
                      Effect.flatMap((observation) =>
                        requireAttributes(
                          encodeAttributes(supportedRequested, observation, filehandle, export_, options)
                        )
                      )
                    )
                  )
                )

                return statusResult(attributes, (value) => value)
              }

              case "Verify": {
                if (current === undefined) return Effect.succeed(noCurrent())
                const reference = current
                const requested = requestedAttributes(operation.value.bitmap)

                // Write-only attributes are INVAL before the supported-set check (Section 18.31.3).
                if (requested.some((attribute) => nonComparableAttributes.has(attribute))) {
                  return Effect.succeed({ code: operation.code, status: Status.INVAL })
                }

                if (requested.some((attribute) => !supportedAttributes.includes(attribute))) {
                  return Effect.succeed({ code: operation.code, status: Status.ATTRNOTSUPP })
                }

                const comparison = filehandleFor(reference, requested).pipe(
                  Effect.flatMap((filehandle) =>
                    mapFs(export_.observeMetadata(reference)).pipe(
                      Effect.flatMap((observation) =>
                        requireAttributes(
                          encodeAttributeValues(requested, observation, filehandle, export_, options)
                        )
                      )
                    )
                  ),
                  Effect.flatMap((actual) => {
                    const same = sameRequest(actual, operation.value.values)

                    if (operation.code === Operation.VERIFY) {
                      return same ? Effect.void : Effect.fail(Status.NOT_SAME)
                    }

                    return same ? Effect.fail(Status.SAME) : Effect.void
                  })
                )

                return statusResult(comparison)
              }

              case "Access": {
                if (current === undefined) return Effect.succeed(noCurrent())
                const requested = operation.value

                return statusResult(
                  mapFs(export_.observeMetadata(current)),
                  (observation) => {
                    const supported = requested & supportedAccessMask(observation.value.kind)
                    const granted = grantedAccess(supported, observation.value, call.credentials)

                    return new Writer().uint32(supported).uint32(granted).bytes()
                  }
                )
              }

              case "Commit": {
                if (current === undefined) return Effect.succeed(noCurrent())

                // A read-only export never holds unstable data, so COMMIT succeeds with the
                // server's write verifier once the target is confirmed to be a regular file.
                return statusResult(
                  requireRegularFile(current),
                  () => new Writer().fixedOpaque(options.generation.subarray(0, 8)).bytes()
                )
              }

              case "Readlink":
                // Section 18.24.4: an object that is not a symbolic link is NFS4ERR_WRONG_TYPE.
                return statusResult(
                  withCurrent((reference) =>
                    mapFs(export_.observeMetadata(reference)).pipe(
                      Effect.filterOrFail(
                        (observation) => observation.value.kind === "symlink",
                        () => Status.WRONG_TYPE
                      ),
                      Effect.andThen(mapFs(export_.readLink(reference))),
                      Effect.filterOrFail(
                        (target) => byteLength(target.length) <= options.limits.maxStringBytes,
                        () => Status.SERVERFAULT
                      )
                    )
                  ),
                  (target) => new Writer().opaque(target).bytes()
                )
              case "Readdir": {
                if (current === undefined) return Effect.succeed(noCurrent())
                const directory = current
                const value = operation.value

                return mapFs(export_.observeDirectory(directory)).pipe(
                  Effect.flatMap((observation) =>
                    Effect.gen(function*() {
                      const requested = requestedAttributes(value.attrs)

                      const supportedRequested = requested.filter((attribute) =>
                        supportedAttributes.includes(attribute)
                      )

                      const verifier = makeCookieVerifier(options.generation, observation.revision)

                      if (value.cookie !== 0n && bytesKey(value.verifier) !== bytesKey(verifier)) {
                        return { code: operation.code, status: Status.NOT_SAME } satisfies ResultPart
                      }

                      if (value.cookie === 1n || value.cookie === 2n) {
                        return { code: operation.code, status: Status.BAD_COOKIE } satisfies ResultPart
                      }

                      const start = value.cookie === 0n ? 0 : Number(value.cookie - 2n)

                      if (!Number.isSafeInteger(start) || start < 0 || start > observation.value.length) {
                        return { code: operation.code, status: Status.BAD_COOKIE } satisfies ResultPart
                      }

                      const writer = new Writer().fixedOpaque(verifier)
                      let count = 0
                      let directoryBytes = 0

                      const responseLimit = Math.min(
                        value.maxcount,
                        ByteSize.toNumberUnsafe(options.limits.maxReaddirReplyBytes)
                      )

                      if (responseLimit < 16) {
                        return { code: operation.code, status: Status.TOOSMALL } satisfies ResultPart
                      }

                      for (
                        let item = start;
                        item < observation.value.length && count < options.limits.maxReaddirEntries;
                        item++
                      ) {
                        const entry = observation.value[item]!

                        if (!isValidName(entry.name, options.limits.maxNameBytes)) {
                          return { code: operation.code, status: Status.INVAL } satisfies ResultPart
                        }

                        const attrs = supportedRequested.length === 0
                          ? new Writer().uint32(0).uint32(0).bytes()
                          : yield* filehandleFor(entry.reference, supportedRequested).pipe(
                            Effect.flatMap((handle) =>
                              mapFs(export_.observeMetadata(entry.reference)).pipe(
                                Effect.flatMap((metadata) =>
                                  requireAttributes(
                                    encodeAttributes(supportedRequested, metadata, handle, export_, options)
                                  )
                                )
                              )
                            ),
                            // With rdattr_error requested, a failing entry reports its own error
                            // instead of failing the whole READDIR (RFC 8881 Section 18.23.3).
                            Effect.catch((status) =>
                              supportedRequested.includes(11)
                                ? Effect.succeed(encodeReaddirError(status))
                                : Effect.fail(status)
                            )
                          )

                        const encoded = new Writer().boolean(true).uint64(BigInt(item + 3)).opaque(entry.name)
                          .fixedOpaque(attrs).bytes()

                        const entryDirectoryBytes = 12 + entry.name.length + (4 - entry.name.length % 4) % 4

                        if (
                          (value.dircount !== 0 && directoryBytes + entryDirectoryBytes > value.dircount) ||
                          writer.length + encoded.length + 8 > responseLimit
                        ) {
                          if (count === 0) {
                            return { code: operation.code, status: Status.TOOSMALL } satisfies ResultPart
                          }

                          break
                        }

                        writer.fixedOpaque(encoded)
                        directoryBytes += entryDirectoryBytes
                        count += 1
                      }

                      writer.boolean(false).boolean(start + count >= observation.value.length)

                      return { code: operation.code, status: Status.OK, body: writer.bytes() } satisfies ResultPart
                    })
                  ),
                  Effect.catch((status) => Effect.succeed({ code: operation.code, status }))
                )
              }

              case "Open": {
                if (activeSession === undefined) {
                  return Effect.succeed({ code: operation.code, status: Status.BADSESSION })
                }

                if (current === undefined) return Effect.succeed(noCurrent())
                const directory = current
                const value = operation.value

                // The owner's clientid MAY hold any value; the client ID comes from the session
                // (RFC 8881 Section 18.16.3), so it is never checked.

                // No state survives a restart and no delegation is ever granted, so a reclaim finds
                // no grace period and a delegation stateid can never be valid (Section 15.1.9.3).
                if (
                  value.claim === CLAIM_PREVIOUS || value.claim === CLAIM_DELEGATE_PREV ||
                  value.claim === CLAIM_DELEG_PREV_FH
                ) {
                  return Effect.succeed({ code: operation.code, status: Status.NO_GRACE })
                }

                if (value.claim === CLAIM_DELEGATE_CUR || value.claim === CLAIM_DELEG_CUR_FH) {
                  return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                }

                // share_access carries the access mode in its low bits and optional delegation
                // "want" hints above them (RFC 8881 Section 18.16.3). Hints are honored with an
                // extended no-delegation answer because this server grants no delegations.
                const accessMode = value.access & OPEN4_SHARE_ACCESS_MASK
                const delegationWant = value.access & OPEN4_SHARE_ACCESS_WANT_DELEG_MASK

                const unknownBits = value.access &
                  ~(OPEN4_SHARE_ACCESS_MASK | OPEN4_SHARE_ACCESS_WANT_DELEG_MASK | OPEN4_SHARE_ACCESS_WANT_HINT_MASK)

                if (
                  accessMode === 0 || unknownBits !== 0 || delegationWant > OPEN4_SHARE_ACCESS_WANT_CANCEL ||
                  value.deny > OPEN4_SHARE_DENY_BOTH
                ) {
                  return Effect.succeed({ code: operation.code, status: Status.INVAL })
                }

                const wantsWrite = (accessMode & OPEN4_SHARE_ACCESS_WRITE) !== 0

                if (value.openHow !== 0) {
                  // Section 18.16.3: OPEN4_CREATE needs CLAIM_NULL here (the delegation claims
                  // were answered above). Structural errors keep their precedence over ROFS.
                  if (value.claim !== 0) return Effect.succeed({ code: operation.code, status: Status.INVAL })

                  return rejectMutation([value.name], "none", Status.SYMLINK)
                }

                const target = value.claim === 4
                  ? Effect.succeed({ revision: 0n, reference: directory })
                  : requireDirectory(directory, Status.SYMLINK).pipe(
                    Effect.andThen(mapFs(export_.observeDirectory(directory))),
                    Effect.flatMap((directoryObservation) =>
                      export_.lookup(directory, value.name).pipe(
                        Effect.mapError(nameStatus),
                        Effect.map((reference) => ({ revision: directoryObservation.revision, reference }))
                      )
                    )
                  )

                return target.pipe(
                  Effect.tap(({ reference }) => requireRegularFile(reference)),
                  // Write access is refused only once the target is known to be a regular file.
                  Effect.tap(() => wantsWrite ? Effect.fail(Status.ROFS) : Effect.void),
                  Effect.flatMap(({ revision, reference }) =>
                    Effect.uninterruptibleMask((restore) =>
                      Effect.suspend(() => {
                        const owner = bytesKey(value.owner)

                        const existing = [...opens.values()].find((open) =>
                          open.client === activeSession!.client && open.owner === owner && open.reference === reference
                        )

                        // Section 18.16.3: a share reservation of another open-owner denies this
                        // access, or this deny mode collides with an access already granted.
                        const denied = [...opens.values()].some((open) =>
                          open !== existing && open.reference === reference &&
                          ((open.deny & accessMode) !== 0 || (value.deny & OPEN4_SHARE_DENY_READ) !== 0)
                        )

                        if (denied) {
                          return Effect.succeed(
                            { code: operation.code, status: Status.SHARE_DENIED } satisfies ResultPart
                          )
                        }

                        if (existing !== undefined) {
                          // The same open-owner upgrades its reservation (Section 9.7).
                          existing.deny |= value.deny
                          advanceStateId(existing)
                          current = reference

                          return Effect.succeed(openResult(existing.id, revision, value.claim === 4))
                        }

                        if (opens.size >= options.limits.maxOpens) {
                          return Effect.succeed({ code: operation.code, status: Status.DELAY } satisfies ResultPart)
                        }

                        const serial = openSerial++

                        return restore(mapFs(export_.open(reference))).pipe(
                          Effect.map((opened): ResultPart => {
                            const id = makeStateId(options.generation, serial, 1)
                            opens.set(stateIdKey(id), {
                              id,
                              sequence: 1,
                              deny: value.deny,
                              owner,
                              client: activeSession!.client,
                              reference,
                              file: opened.handle,
                              close: opened.close
                            })
                            current = reference

                            return openResult(id, revision, value.claim === 4)
                          })
                        )
                      })
                    )
                  ),
                  Effect.catch((status) => Effect.succeed({ code: operation.code, status }))
                )

                function openResult(id: Uint8Array, revision: bigint, atomic: boolean): ResultPart {
                  currentStateid = id

                  const body = encodeStatusBody((writer) => {
                    writer.fixedOpaque(id).boolean(atomic)
                      .uint64(BigInt.asUintN(64, revision))
                      .uint64(BigInt.asUintN(64, revision)).uint32(0)
                    writeBitmap(writer, [])

                    if (delegationWant === 0) {
                      writer.uint32(OPEN_DELEGATE_NONE)
                    } else {
                      // Section 18.16.3: a want that is not satisfied MUST be answered with
                      // OPEN_DELEGATE_NONE_EXT and a reason. NOT_WANTED and CANCELLED carry no body,
                      // and NOT_SUPP_FTYPE is the honest reason for a server without delegations.
                      const why = delegationWant === OPEN4_SHARE_ACCESS_WANT_NO_DELEG
                        ? WND4_NOT_WANTED
                        : delegationWant === OPEN4_SHARE_ACCESS_WANT_CANCEL
                        ? WND4_CANCELLED
                        : WND4_NOT_SUPP_FTYPE

                      writer.uint32(OPEN_DELEGATE_NONE_EXT).uint32(why)
                    }
                  })

                  return { code: operation.code, status: Status.OK, body }
                }
              }

              case "Read": {
                // RFC 8881 Section 18.22.3 lets the server return fewer bytes than requested.
                const value = {
                  ...operation.value,
                  count: Math.min(operation.value.count, ByteSize.toNumberUnsafe(options.limits.maxReadBytes))
                }

                if (current === undefined) return Effect.succeed(noCurrent())

                if (isAllZero(value.stateid) || isAllOnes(value.stateid)) {
                  const reference = current

                  // Section 9.1.2: the anonymous stateid must still respect a deny-read share
                  // reservation; the READ-bypass stateid (all ones) may ignore it.
                  const denied = isAllZero(value.stateid) &&
                    [...opens.values()].some((open) =>
                      open.reference === reference && (open.deny & OPEN4_SHARE_DENY_READ) !== 0
                    )

                  return requireRegularFile(reference).pipe(
                    Effect.andThen(denied ? Effect.fail(Status.LOCKED) : Effect.void),
                    Effect.andThen(
                      Effect.acquireUseRelease(
                        mapFs(export_.open(reference)),
                        (opened) => readFrom(opened.handle),
                        (opened) => opened.close
                      )
                    ),
                    Effect.catch((status) => Effect.succeed({ code: operation.code, status }))
                  )
                }

                const effectiveStateid = isCurrentStateId(value.stateid) ? currentStateid : value.stateid

                if (effectiveStateid === undefined) {
                  return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                }

                const open = opens.get(stateIdKey(effectiveStateid))

                if (open === undefined) return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                const suppliedSequence = stateIdSequence(effectiveStateid)

                if (suppliedSequence !== 0 && suppliedSequence < open.sequence) {
                  return Effect.succeed({ code: operation.code, status: Status.OLD_STATEID })
                }

                if (suppliedSequence > open.sequence) {
                  return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                }

                if (
                  activeSession === undefined || current === undefined || open.client !== activeSession.client ||
                  open.reference !== current
                ) {
                  return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                }

                return readFrom(open.file)

                function readFrom(file: Vfs.FileHandle): Effect.Effect<ResultPart> {
                  return file.pread(value.count, value.offset).pipe(
                    Effect.flatMap((data) => file.stat.pipe(Effect.map((metadata) => ({ data, metadata })))),
                    Effect.map(({ data, metadata }): ResultPart => ({
                      code: operation.code,
                      status: Status.OK,
                      body: new Writer().boolean(value.offset + BigInt(data.length) >= metadata.size).opaque(data)
                        .bytes()
                    })),
                    Effect.catch((error) => Effect.succeed({ code: operation.code, status: failureForFs(error) }))
                  )
                }
              }

              case "OpenDowngrade": {
                if (current === undefined) return Effect.succeed(noCurrent())
                const value = operation.value
                // Section 16.2.3: the special current stateid refers to a preceding OPEN.
                const stateid = isCurrentStateId(value.stateid) ? currentStateid : value.stateid

                if (stateid === undefined) return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                const open = opens.get(stateIdKey(stateid))

                if (open === undefined) return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                const stateidStatus = checkOpenStateId(stateid, open)

                if (stateidStatus !== Status.OK) return Effect.succeed({ code: operation.code, status: stateidStatus })

                // Section 18.18.3: delegation want bits are masked off, and the new modes must be
                // non-empty subsets of what is held. Only read access is ever held here.
                const access = value.access & ~OPEN4_SHARE_ACCESS_WANT_DELEG_MASK

                if (access !== OPEN4_SHARE_ACCESS_READ || (value.deny & ~open.deny) !== 0) {
                  return Effect.succeed({ code: operation.code, status: Status.INVAL })
                }

                open.deny = value.deny
                advanceStateId(open)
                currentStateid = open.id

                return Effect.succeed({
                  code: operation.code,
                  status: Status.OK,
                  body: new Writer().fixedOpaque(open.id).bytes()
                })
              }

              case "FreeStateid": {
                if (activeSession === undefined) {
                  return Effect.succeed({ code: operation.code, status: Status.BADSESSION })
                }

                const open = isSpecialStateId(operation.value) ? undefined : opens.get(stateIdKey(operation.value))

                // An open stateid still backs a live open, so it cannot be freed (Section 18.38.3).
                return Effect.succeed({
                  code: operation.code,
                  status: open === undefined || open.client !== activeSession.client
                    ? Status.BAD_STATEID
                    : Status.LOCKS_HELD
                })
              }

              case "TestStateid": {
                if (activeSession === undefined) {
                  return Effect.succeed({ code: operation.code, status: Status.BADSESSION })
                }

                const session = activeSession

                // TEST_STATEID checks stateids alone; it does not involve the current filehandle.
                const results = operation.value.map((stateid) => {
                  if (isSpecialStateId(stateid)) return Status.BAD_STATEID
                  const open = opens.get(stateIdKey(stateid))

                  if (open === undefined || open.client !== session.client) return Status.BAD_STATEID

                  return checkStateIdSequence(stateid, open)
                })

                return Effect.succeed({
                  code: operation.code,
                  status: Status.OK,
                  body: new Writer().array(results, (writer, status) => writer.uint32(status)).bytes()
                })
              }

              case "SetSsv":
                // State protection is always SP4_NONE (RFC 8881 Section 18.47.3).
                return Effect.succeed({ code: operation.code, status: Status.INVAL })
              case "Lock":
                // Byte-range lock state arrives with the stateful profile. A write lock on a
                // read-only file system is NFS4ERR_ROFS; a read lock cannot be recorded either, and
                // ROFS is the only listed error that says so without inventing a conflict.
                return statusResult(
                  withCurrent(requireRegularFile).pipe(Effect.andThen(Effect.fail(Status.ROFS)))
                )
              case "Lockt":
                // No lock exists, so a read-lock test finds no conflict; a write-lock test
                // reports the read-only file system.
                return statusResult(
                  withCurrent(requireRegularFile).pipe(
                    Effect.andThen(
                      WRITE_LOCK_TYPES.has(operation.value.lockType) ? Effect.fail(Status.ROFS) : Effect.void
                    )
                  )
                )
              case "Locku":
                // No lock stateid can exist, so any supplied one is invalid. LOCKU's error list
                // has no object-type errors, so only the filehandle is checked first.
                return statusResult(withCurrent(() => Effect.fail(Status.BAD_STATEID)))
              case "Close": {
                if (current === undefined) return Effect.succeed(noCurrent())
                const value = operation.value
                // Section 16.2.3: the special current stateid refers to a preceding OPEN.
                const stateid = isCurrentStateId(value.stateid) ? currentStateid : value.stateid

                if (stateid === undefined) return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                const key = stateIdKey(stateid)
                const open = opens.get(key)

                if (open === undefined) return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                const stateidStatus = checkOpenStateId(stateid, open)

                if (stateidStatus !== Status.OK) return Effect.succeed({ code: operation.code, status: stateidStatus })
                const closedStateid = new Uint8Array(open.id)
                new DataView(closedStateid.buffer).setUint32(0, open.sequence + 1)

                return Effect.uninterruptible(open.close).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      opens.delete(key)
                      currentStateid = closedStateid
                    })
                  ),
                  Effect.as({
                    code: operation.code,
                    status: Status.OK,
                    body: new Writer().fixedOpaque(closedStateid).bytes()
                  })
                )
              }

              case "Setattr":
              case "Write":
                return Effect.succeed(
                  current === undefined ? noCurrent() : { code: operation.code, status: Status.ROFS }
                )
              // Section 15.2 lists NFS4ERR_SYMLINK for LINK but not for CREATE, REMOVE, or RENAME.
              case "Create":
                return rejectMutation([operation.value.name], "none", Status.NOTDIR)
              case "Remove":
                return rejectMutation([operation.value], "none", Status.NOTDIR)
              case "Rename":
                return rejectMutation([operation.value.oldName, operation.value.newName], "directory", Status.NOTDIR)
              case "Link":
                return rejectMutation([operation.value], "object", Status.SYMLINK)
              case "NotSupported":
                return Effect.succeed({ code: operation.code, status: Status.NOTSUPP })
              case "Unknown":
                return Effect.succeed({ code: Operation.ILLEGAL, status: Status.OP_ILLEGAL })
              case "Malformed":
                return Effect.succeed({ code: operation.code, status: Status.BADXDR })
            }
          }

          /** Sets the current filehandle without a returned stateid (RFC 8881 Section 16.2.3.1.2). */
          function setCurrent(reference: CurrentObject | undefined): void {
            current = reference
            currentStateid = undefined
          }

          function parentOf(reference: Vfs.ObjectReference): Effect.Effect<Vfs.ObjectReference, number> {
            // The root has no parent in this export (RFC 8881 Section 18.14.3).
            return export_.parent(reference).pipe(
              Effect.mapError(failureForFs),
              Effect.filterOrFail((parent) => parent !== reference, () => Status.NOENT)
            )
          }

          function nameStatus(error: Vfs.FsError | InvalidNameError): number {
            if (error instanceof InvalidNameError) {
              // RFC 8881 Section 14.5: reserved components are BADNAME, over-long names NAMETOOLONG,
              // valid UTF-8 the file system cannot store (a slash or NUL) BADCHAR, and other
              // invalid names INVAL.
              switch (error.reason) {
                case "Reserved":
                  return Status.BADNAME
                case "TooLong":
                  return Status.NAMETOOLONG
                case "ForbiddenByte":
                  return Status.BADCHAR
                default:
                  return Status.INVAL
              }
            }

            return failureForFs(error)
          }

          function isSpecialStateId(stateid: Uint8Array): boolean {
            return isAllZero(stateid) || isAllOnes(stateid) || isCurrentStateId(stateid)
          }

          function checkStateIdSequence(stateid: Uint8Array, open: OpenState): number {
            const suppliedSequence = stateIdSequence(stateid)

            if (suppliedSequence !== 0 && suppliedSequence < open.sequence) return Status.OLD_STATEID

            if (suppliedSequence > open.sequence) return Status.BAD_STATEID

            return Status.OK
          }

          function checkOpenStateId(stateid: Uint8Array, open: OpenState): number {
            const sequenceStatus = checkStateIdSequence(stateid, open)

            if (sequenceStatus !== Status.OK) return sequenceStatus

            if (
              activeSession === undefined || current === undefined || open.client !== activeSession.client ||
              open.reference !== current
            ) {
              return Status.BAD_STATEID
            }

            return Status.OK
          }

          function advanceStateId(open: OpenState): void {
            open.sequence += 1
            open.id = makeStateId(
              options.generation,
              new DataView(open.id.buffer, open.id.byteOffset + 8, 8).getBigUint64(0),
              open.sequence
            )
          }
        }).pipe(
          Effect.onInterrupt(() => Effect.sync(() => rollbackSequence?.()))
        )
      }).pipe(Effect.orDie)

    /**
     * Takes the next free backchannel slot. Section 2.10.6.1 requires slot state even for
     * callbacks, so a slot in flight is never reused for a second concurrent callback.
     */
    const takeCallbackSlot = (back: BackChannel): number | undefined => {
      const index = back.slots.findIndex((slot) => !slot.busy)

      if (index < 0) return undefined
      back.slots[index]!.busy = true
      back.slots[index]!.sequence = nextSequenceId(back.slots[index]!.sequence)

      return index
    }

    const probe = (session: SessionState): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        const back = session.back

        if (back === undefined) return false

        const slot = takeCallbackSlot(back)

        if (slot === undefined) return false

        const answered = yield* Effect.ensuring(
          callback(
            session,
            CB_COMPOUND_PROCEDURE,
            encodeCallbackSequence(session.id, back.slots[slot]!.sequence, slot, back.slots.length - 1)
          ),
          Effect.sync(() => {
            back.slots[slot]!.busy = false
          })
        )

        // Section 18.37.3 lets the server report an unusable callback path; tracking it here is
        // what makes that report honest rather than a guess.
        back.healthy = answered !== undefined

        return back.healthy
      })

    return {
      compound: (call) =>
        stateGate.withPermit(
          Effect.uninterruptible(sweepExpired.pipe(Effect.andThen(executeCompound(call))))
        ),
      callbackReply: (_connection, message) =>
        Effect.sync(() => {
          if (message.length < 4) return
          const xid = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(0)
          const waiting = pendingCallbacks.get(xid)

          if (waiting === undefined) return
          pendingCallbacks.delete(xid)
          Deferred.doneUnsafe(waiting, Effect.succeed(message))
        }),
      probeBackChannel: (id) =>
        Effect.suspend(() => {
          const session = sessions.get(bytesKey(id))

          return session === undefined ? Effect.succeed(false) : probe(session)
        }),
      disconnect: (connection) =>
        stateGate.withPermit(
          Effect.sync(() => {
            // Section 2.10.5: losing one connection does not end a session that others still
            // reach, and never ends the lease, which expires on its own schedule.
            // FIX(#69): nothing reclaims a client whose last connection went away — the lease
            // correctly survives, but opens and replay budget stay pinned until the scope closes.
            // https://github.com/lloydrichards/effect-virtual-fs/issues/69
            for (const session of sessions.values()) session.connections.delete(connection)
          })
        )
    }
  })
}
