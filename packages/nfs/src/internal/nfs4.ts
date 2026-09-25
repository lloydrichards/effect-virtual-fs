import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as ByteSize from "effect/ByteSize"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import type * as Types from "effect/Types"
import {
  ExportCapacityError,
  type InvalidFilehandleError,
  InvalidNameError,
  type NfsExport,
  validateName
} from "./export.js"
import { type LockRange, lockRange, MAX_OFFSET, overlaps } from "./lockRanges.js"
import { type CompoundCall, type Connection, RpcPolicyDenied } from "./rpc.js"
import {
  type DecodeLimits,
  type DecoderSession,
  type EncoderSession,
  make as xdr,
  XdrCodec,
  XdrDecodeError,
  XdrEncodeError
} from "./xdr.js"

/** @internal */
export const Status = {
  OK: 0,
  PERM: 1,
  NOENT: 2,
  IO: 5,
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
  BADTYPE: 10007,
  DELAY: 10008,
  SAME: 10009,
  EXPIRED: 10011,
  LOCKED: 10012,
  DENIED: 10010,
  OPENMODE: 10038,
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
  LOCK_RANGE: 10028,
  SYMLINK: 10029,
  ATTRNOTSUPP: 10032,
  BADOWNER: 10039,
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

/** @internal */
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

/**
 * sr_status_flags bits for a backchannel the server cannot use (RFC 8881 Section 18.46.3).
 * CB_PATH_DOWN_SESSION is the session-scoped form, which is what this server tracks: health is
 * recorded per session backchannel, not per client ID.
 */
const SEQ4_STATUS_CB_PATH_DOWN_SESSION = 0x0000_0200

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

// The mode bits knfsd's nfsd_sanitize_attrs strips from a SETATTR that also changes the owner.
const SET_UID = 0o4000

const SET_GID = 0o2000

const GROUP_EXECUTE = 0o010

const ACCESS4_READ = 0x01

const ACCESS4_LOOKUP = 0x02

const ACCESS4_MODIFY = 0x04

const ACCESS4_EXTEND = 0x08

const ACCESS4_DELETE = 0x10

const ACCESS4_EXECUTE = 0x20

const AUTH_NONE = 0

const AUTH_SYS = 1

/** RFC 5531 caps an `opaque_auth` body at 400 bytes, which bounds any credential a callback carries. */
const MAX_OPAQUE_AUTH_BYTES = 400

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
 * 25-byte filehandle and bounded capacity is about 360 bytes; recheck when attributes grow.
 */
const MAX_GETATTR_REPLY_BYTES = 512

/** WRITE_LT and WRITEW_LT request exclusive ranges. */
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

/** @internal */
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
  readonly maxLockOwners: number
  readonly maxLocks: number
  readonly maxOwnerBytes: ByteSize.ByteSize
  readonly maxReadBytes: ByteSize.ByteSize
  readonly maxWriteBytes: ByteSize.ByteSize
  readonly maxReaddirEntries: number
  readonly maxReaddirReplyBytes: ByteSize.ByteSize
  readonly maxNameBytes: ByteSize.ByteSize
}

/** @internal */
export interface Nfs4Options {
  /** Enables writable operation handling after the public server qualifies the volume and identity policy. */
  readonly writable?: boolean
  readonly leaseDurationSeconds: number
  /** How long a callback waits for the client's reply before the path is treated as down. */
  readonly callbackTimeout: Duration.Input
  /** NFS server lifetime used for sessions, state IDs, and server-owner fields. */
  readonly generation: Uint8Array
  /** Volume storage lifetime used for filehandles, write, and directory-cookie verifiers. */
  readonly storageGeneration?: Uint8Array
  readonly now: () => number
  readonly limits: Nfs4Limits
  /** Resolves a networked request to its VFS caller; null rejects the RPC before dispatch. */
  readonly callerFor?: (call: CompoundCall) => Effect.Effect<Vfs.Caller | null>
  readonly securityFlavors?: ReadonlyArray<number>
}

/** @internal */
export interface Nfs4Handler {
  readonly compound: (call: CompoundCall) => Effect.Effect<Uint8Array, RpcPolicyDenied | XdrEncodeError>
  readonly disconnect: (connection: Connection) => Effect.Effect<void>
  readonly callbackReply: (connection: Connection, message: Uint8Array) => Effect.Effect<void>
  /**
   * Sends a CB_SEQUENCE-only CB_COMPOUND down a session's backchannel and reports whether the
   * client answered. Answers `false` when the session has no backchannel to probe.
   */
  readonly probeBackChannel: (session: Uint8Array) => Effect.Effect<boolean>
}

/** @internal */
export const nextSequenceId = (sequence: number): number => (sequence + 1) >>> 0

type LockOwnerArgument =
  | { readonly kind: "new"; readonly stateid: Uint8Array; readonly owner: Uint8Array }
  | { readonly kind: "existing"; readonly stateid: Uint8Array }

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
      readonly attrs: ParsedAttributes
      readonly target: string | undefined
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
      readonly create: {
        readonly mode: number
        readonly verifier: Uint8Array
        readonly attrs: ParsedAttributes
      } | undefined
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
    readonly value: { readonly stateid: Uint8Array; readonly attrs: ParsedAttributes }
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
  | {
    readonly kind: "Lock"
    readonly code: typeof Operation.LOCK
    readonly value: {
      readonly lockType: number
      readonly reclaim: boolean
      readonly offset: bigint
      readonly length: bigint
      readonly locker: LockOwnerArgument
    }
  }
  | {
    readonly kind: "Lockt"
    readonly code: typeof Operation.LOCKT
    readonly value: {
      readonly lockType: number
      readonly offset: bigint
      readonly length: bigint
      readonly owner: Uint8Array
    }
  }
  | {
    readonly kind: "Locku"
    readonly code: typeof Operation.LOCKU
    readonly value: { readonly stateid: Uint8Array; readonly offset: bigint; readonly length: bigint }
  }
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
    /** The session the cached reply created, so a retry can bind its own connection to it. */
    readonly session?: Uint8Array
    /** The channel directions that reply agreed to. */
    readonly directions?: number
  } | undefined
}

type CreateSessionReplay = NonNullable<ClientState["createSessionReplay"]>

interface ReplaySlot {
  sequence: number
  response?: Uint8Array
  request?: Uint8Array
  credentials?: string
  caller?: Vfs.Caller
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
  /** False once a callback goes unanswered; Section 18.46.3 reports this in sr_status_flags. */
  healthy: boolean
  /** Set once the path has been probed, so the probe runs once per arming rather than per request. */
  probed: boolean
  /**
   * Bumped whenever the path is re-armed. A probe carries the value it started with and publishes
   * its verdict only if that is still current, so a slow probe cannot overwrite a newer one.
   */
  arming: number
}

interface CallbackSlot {
  sequence: number
  busy: boolean
}

interface OpenState {
  id: Uint8Array
  sequence: number
  /** Aggregate access and deny modes held by this open-owner on this file. */
  access: number
  deny: number
  readonly owner: string
  readonly client: ClientState
  readonly reference: Vfs.ObjectReference
  readFile: Vfs.FileHandle | undefined
  writeFile: Vfs.FileHandle | undefined
  close: Effect.Effect<void>
}

interface LockState {
  id: Uint8Array
  sequence: number
  readonly client: ClientState
  readonly owner: Uint8Array
  readonly ownerKey: string
  readonly open: OpenState
  readonly ranges: Array<{ readonly range: LockRange; readonly type: number }>
}

type HeldRange = LockState["ranges"][number]

/** Replace an owner's byte state on a range, retaining sorted, disjoint intervals. */
const replaceLockRange = (held: ReadonlyArray<HeldRange>, range: LockRange, type?: number): Array<HeldRange> => {
  const next: Array<HeldRange> = []

  for (const entry of held) {
    if (!overlaps(entry.range, range)) {
      next.push(entry)
      continue
    }

    if (entry.range.offset < range.offset) {
      next.push({ range: lockRange(entry.range.offset, range.offset - entry.range.offset)!, type: entry.type })
    }

    if (entry.range.end > range.end) {
      next.push({
        range: lockRange(range.end, entry.range.end === MAX_OFFSET + 1n ? MAX_OFFSET : entry.range.end - range.end)!,
        type: entry.type
      })
    }
  }

  if (type !== undefined) next.push({ range, type })
  next.sort((a, b) => a.range.offset < b.range.offset ? -1 : a.range.offset > b.range.offset ? 1 : 0)

  const merged: Array<HeldRange> = []

  for (const entry of next) {
    const last = merged.at(-1)

    if (last !== undefined && last.type === entry.type && last.range.end === entry.range.offset) {
      merged[merged.length - 1] = {
        range: lockRange(
          last.range.offset,
          entry.range.end === MAX_OFFSET + 1n ? MAX_OFFSET : entry.range.end - last.range.offset
        )!,
        type: last.type
      }
    } else merged.push(entry)
  }

  return merged
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

  if ((options.storageGeneration ?? options.generation).length !== 16) {
    throw new RangeError("storageGeneration must contain exactly 16 bytes")
  }

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

const bitmap = (reader: DecoderSession, limit: number) => reader.read(XdrCodec.array(XdrCodec.uint32, limit))

const writeBitmap = (writer: EncoderSession, words: ReadonlyArray<number>) =>
  writer.write(XdrCodec.array(XdrCodec.uint32), words)

const attributesIn = (words: ReadonlyArray<number>): ReadonlyArray<number> => {
  const result: Array<number> = []

  for (let word = 0; word < words.length; word++) {
    for (let bit = 0; bit < 32; bit++) if (((words[word]! >>> bit) & 1) !== 0) result.push(word * 32 + bit)
  }

  return result
}

const validateWritableAttributes = Effect.fnUntraced(function*(
  words: ReadonlyArray<number>,
  bytes: Uint8Array,
  limits: Nfs4Limits
) {
  const attributes = attributesIn(words)

  if (attributes.some((attribute) => ![4, 33, 36, 37, 48, 54].includes(attribute))) return
  const values = yield* xdr.openReader(bytes, limits)

  for (const attribute of attributes) {
    if (attribute === 4) yield* values.read(XdrCodec.uint64)
    else if (attribute === 33) yield* values.read(XdrCodec.uint32)
    else if (attribute === 36 || attribute === 37) yield* values.read(XdrCodec.string(limits.maxStringBytes))
    else if (attribute === 48 || attribute === 54) {
      const how = yield* values.read(XdrCodec.uint32)

      if (how === 1) {
        yield* values.read(XdrCodec.uint64)

        if ((yield* values.read(XdrCodec.uint32)) >= 1_000_000_000) {
          return yield* new XdrDecodeError({
            reason: "range",
            offset: yield* values.position,
            path: ["attributes", attribute],
            detail: "Invalid attribute nanoseconds"
          })
        }
      } else if (how !== 0) {
        return yield* new XdrDecodeError({
          reason: "discriminant",
          offset: yield* values.position,
          path: ["attributes", attribute],
          detail: "Invalid set-time discriminant"
        })
      }
    }
  }

  yield* values.finish
})

interface ParsedAttributes {
  readonly bitmap: ReadonlyArray<number>
  readonly values: Uint8Array
}

const readAttributes = Effect.fnUntraced(function*(reader: DecoderSession, limits: Nfs4Limits) {
  const words = yield* bitmap(reader, limits.maxBitmapWords)
  const values = yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))
  yield* validateWritableAttributes(words, values, limits)

  return { bitmap: words, values }
})

const isNumericOwner = Schema.is(Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/)))

const creationAttributes = Effect.fnUntraced(function*(
  create: NonNullable<Extract<ParsedOperation, { kind: "Open" }>["value"]["create"]>,
  limits: Nfs4Limits,
  existing: boolean
) {
  const attributes = attributesIn(create.attrs.bitmap)
  const supported = create.mode === 3 ? [4, 33, 36, 37] : [4, 33, 36, 37, 48, 54]
  const supportedAttrs = attributes.every((attribute) => supported.includes(attribute))

  if (!supportedAttrs && !(existing && create.mode === 0)) {
    return yield* Effect.fail(create.mode === 3 ? Status.INVAL : Status.ATTRNOTSUPP)
  }

  const reader = yield* xdr.openReader(create.attrs.values, limits)
  let mode = create.mode === 2 ? 0o600 : undefined
  let size: bigint | undefined
  const owner: Types.Mutable<Vfs.OwnerUpdate> = {}

  const times: Types.Mutable<Vfs.Times> = {
    access: { kind: "omit" },
    modification: { kind: "omit" }
  }

  for (const attribute of attributes) {
    // Unknown ignored attributes have no decoded width. Size can still be read
    // when it precedes them, matching ordinary creation's existing-file behavior.
    if (!supported.includes(attribute)) break

    if (attribute === 4) size = yield* reader.read(XdrCodec.uint64)
    else if (attribute === 33) {
      const value = yield* reader.read(XdrCodec.uint32)

      if (!existing) {
        if (value > 0o7777) return yield* Effect.fail(Status.INVAL)
        mode = value
      }
    } else if (attribute === 36 || attribute === 37) {
      const value = yield* reader.read(XdrCodec.string(limits.maxStringBytes))

      if (existing) continue

      if (!isNumericOwner(value) || Number(value) > 0xffff_ffff) return yield* Effect.fail(Status.BADOWNER)

      if (attribute === 36) owner.uid = Number(value)
      else owner.gid = Number(value)
    } else {
      const how = yield* reader.read(XdrCodec.uint32)

      const time: Vfs.Times["access"] = how === 0 ? { kind: "now" } : {
        kind: "value",
        nanoseconds: BigInt.asIntN(64, yield* reader.read(XdrCodec.uint64)) * 1_000_000_000n +
          BigInt(yield* reader.read(XdrCodec.uint32))
      }

      if (attribute === 48) times.access = time
      else times.modification = time
    }
  }

  if (supportedAttrs) yield* reader.finish

  if (create.mode >= 2) {
    // RFC 8881 18.16.4 permits timestamp storage. Both verifier halves enter
    // the creation candidate so a crash cannot separate the file from its verifier.
    const verifier = yield* xdr.openReader(create.verifier, limits)
    times.access = { kind: "value", nanoseconds: BigInt(yield* verifier.read(XdrCodec.uint32)) * 1_000_000_000n }
    times.modification = {
      kind: "value",
      nanoseconds: BigInt(yield* verifier.read(XdrCodec.uint32)) * 1_000_000_000n
    }
  }

  const settings:
    & Types.Mutable<Pick<Vfs.OpenEntryOptions, "mode" | "initialSize" | "owner" | "exactMode">>
    & {
      readonly times: Vfs.Times
    } = { times }

  if (mode !== undefined) {
    settings.mode = mode
    settings.exactMode = true
  }

  if (size !== undefined) settings.initialSize = size

  if (Object.keys(owner).length !== 0) settings.owner = owner

  return { attributes, settings }
})

type SetAttribute =
  | { readonly kind: "size"; readonly attribute: 4; readonly value: bigint }
  | { readonly kind: "mode"; readonly attribute: 33; readonly value: number }
  | { readonly kind: "owner"; readonly attribute: 36 | 37; readonly value: number }
  | { readonly kind: "time"; readonly attribute: 48 | 54; readonly value: Vfs.Times["access"] }

const setattrAttributes = Effect.fnUntraced(function*(
  attrs: ParsedAttributes,
  limits: Nfs4Limits,
  supportedAttributes: ReadonlyArray<number>
) {
  const attributes = attributesIn(attrs.bitmap)

  const invalid = attributes.find((attribute) => ![4, 33, 36, 37, 48, 54].includes(attribute))

  if (invalid !== undefined) {
    return yield* Effect.fail(supportedAttributes.includes(invalid) ? Status.INVAL : Status.ATTRNOTSUPP)
  }

  const reader = yield* xdr.openReader(attrs.values, limits)
  const changes: Array<SetAttribute> = []

  for (const attribute of attributes) {
    if (attribute === 4) changes.push({ kind: "size", attribute, value: yield* reader.read(XdrCodec.uint64) })
    else if (attribute === 33) {
      const value = yield* reader.read(XdrCodec.uint32)

      if (value > 0o7777) return yield* Effect.fail(Status.INVAL)
      changes.push({ kind: "mode", attribute, value })
    } else if (attribute === 36 || attribute === 37) {
      const value = yield* reader.read(XdrCodec.string(limits.maxStringBytes))

      if (!isNumericOwner(value) || Number(value) > 0xffff_ffff) return yield* Effect.fail(Status.BADOWNER)
      changes.push({ kind: "owner", attribute, value: Number(value) })
    } else if (attribute === 48 || attribute === 54) {
      const how = yield* reader.read(XdrCodec.uint32)

      const value: Vfs.Times["access"] = how === 0 ? { kind: "now" } : {
        kind: "value",
        nanoseconds: BigInt.asIntN(64, yield* reader.read(XdrCodec.uint64)) * 1_000_000_000n +
          BigInt(yield* reader.read(XdrCodec.uint32))
      }

      changes.push({ kind: "time", attribute, value })
    }
  }

  yield* reader.finish

  return changes
})

// The one core change a SETATTR's decoded attributes make: owner and group join one owner update, and the two
// times one times update that omits the one not given.
const setattrOptions = (changes: ReadonlyArray<SetAttribute>): Vfs.SetattrOptions => {
  const options: Types.Mutable<Vfs.SetattrOptions> = {}
  const owner: Types.Mutable<Vfs.OwnerUpdate> = {}

  let access: Vfs.Times["access"] | undefined
  let modification: Vfs.Times["modification"] | undefined

  for (const change of changes) {
    if (change.kind === "size") options.size = change.value
    else if (change.kind === "mode") options.mode = change.value
    else if (change.kind === "owner" && change.attribute === 36) owner.uid = change.value
    else if (change.kind === "owner") owner.gid = change.value
    else if (change.attribute === 48) access = change.value
    else modification = change.value
  }

  if (Object.keys(owner).length !== 0) options.owner = owner

  if (access !== undefined || modification !== undefined) {
    options.times = { access: access ?? { kind: "omit" }, modification: modification ?? { kind: "omit" } }
  }

  return options
}

// Linux knfsd's SETATTR (fs/nfsd/vfs.c) treats an owner or group equal to the object's current one as no change:
// notify_change's chown_ok and chgrp_ok (fs/attr.c) let the owner re-send its own uid, and its own gid without
// membership, and nfsd_sanitize_attrs revokes set-ID bits only when the uid or gid actually differs. Core's chown
// is POSIX and refuses a gid outside the caller's groups even when it is the current one, so the unchanged ids
// are dropped here. The owner update itself stays, possibly empty, so core still checks ownership as chown_ok does.
// For a real change of the owner or group of a non-directory that sets its mode too, nfsd_sanitize_attrs clears
// setuid from the requested mode, and setgid when the mode grants group execute (without it, setgid marks
// mandatory locking, not privilege). Core applies a requested mode after the owner, as POSIX chown then chmod
// does, so the sanitising happens here. An owner change without a mode needs nothing: core's chown already
// clears both bits on a regular file. The result pins the revision it observed, so core refuses it if another
// change lands before it applies.
const sanitizeSetattr = (
  export_: NfsExport,
  reference: Vfs.ObjectReference,
  options: Vfs.SetattrOptions
): Effect.Effect<Vfs.SetattrOptions, Vfs.VfsError> => {
  const { mode, owner } = options

  if (owner === undefined) return Effect.succeed(options)

  return Effect.map(
    export_.observeMetadata(reference),
    ({ value, revision }) => {
      const changed: Types.Mutable<Vfs.OwnerUpdate> = {}

      if (owner.uid !== undefined && owner.uid !== value.uid) changed.uid = owner.uid

      if (owner.gid !== undefined && owner.gid !== value.gid) changed.gid = owner.gid
      const chowned = changed.uid !== undefined || changed.gid !== undefined

      return mode === undefined || !chowned || value.kind === "directory"
        ? { ...options, owner: changed, expected: { revision } }
        : {
          ...options,
          owner: changed,
          mode: mode & ~(SET_UID | ((mode & GROUP_EXECUTE) === 0 ? 0 : SET_GID)),
          expected: { revision }
        }
    }
  )
}

// Re-observations a SETATTR makes when another change overtook the metadata its owner handling read, before
// answering DELAY so the client retries later.
const SETATTR_RETRIES = 3

// Whether core refused a setattr because the target moved past the revision it was decided from.
const isStaleObservation = (error: Vfs.VfsError) => error.code === "StaleReference" && error.field === "expected"

// Sanitises and applies a SETATTR's attributes as one core change, re-observing when another change lands
// between the observation and the change, and failing with DELAY once the retries run out.
const applySetattr = (
  export_: NfsExport,
  reference: Vfs.ObjectReference,
  options: Vfs.SetattrOptions
): Effect.Effect<void, Vfs.VfsError | typeof Status.DELAY> => {
  const attempt = (retries: number): Effect.Effect<void, Vfs.VfsError | typeof Status.DELAY> =>
    sanitizeSetattr(export_, reference, options).pipe(
      Effect.flatMap((attributes) => export_.setattr(reference, attributes)),
      Effect.catchIf(isStaleObservation, () => retries === 0 ? Effect.fail(Status.DELAY) : attempt(retries - 1))
    )

  return attempt(SETATTR_RETRIES)
}

const readStateOwner = Effect.fnUntraced(function*(reader: DecoderSession, limits: Nfs4Limits) {
  yield* reader.read(XdrCodec.uint64)

  return yield* reader.read(XdrCodec.opaque(limits.maxOwnerBytes))
})

interface ChannelAttrs {
  readonly headerPadding: number
  readonly maxRequest: number
  readonly maxResponse: number
  readonly maxCachedResponse: number
  readonly maxOperations: number
  readonly maxRequests: number
  readonly rdmaIrd: ReadonlyArray<number>
}

const ChannelAttrsCodec = XdrCodec.struct({
  headerPadding: XdrCodec.uint32,
  maxRequest: XdrCodec.uint32,
  maxResponse: XdrCodec.uint32,
  maxCachedResponse: XdrCodec.uint32,
  maxOperations: XdrCodec.uint32,
  maxRequests: XdrCodec.uint32,
  rdmaIrd: XdrCodec.array(XdrCodec.uint32, 1)
})

const readChannelAttrs = (reader: DecoderSession) => reader.read(ChannelAttrsCodec)

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

const readCallbackSecurity = Effect.fnUntraced(function*(reader: DecoderSession, limits: Nfs4Limits) {
  const flavor = yield* reader.read(XdrCodec.uint32)

  if (flavor === 0) return { flavor }

  if (flavor === 1) {
    const stamp = yield* reader.read(XdrCodec.uint32)
    const machineName = yield* reader.read(XdrCodec.string(limits.maxStringBytes))
    const uid = yield* reader.read(XdrCodec.uint32)
    const gid = yield* reader.read(XdrCodec.uint32)
    const groups = yield* reader.read(XdrCodec.array(XdrCodec.uint32, limits.maxArrayElements))

    const credential = yield* xdr.encode(
      { stamp, machineName, uid, gid, groups },
      XdrCodec.struct({
        stamp: XdrCodec.uint32,
        machineName: XdrCodec.string(),
        uid: XdrCodec.uint32,
        gid: XdrCodec.uint32,
        groups: XdrCodec.array(XdrCodec.uint32)
      }),
      limits,
      ByteSize.toNumberUnsafe(limits.maxRecordBytes)
    )

    return { flavor, credential }
  }

  if (flavor === 6) {
    yield* reader.read(XdrCodec.uint32)
    yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))
    yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))

    return { flavor }
  }

  return yield* new XdrDecodeError({
    reason: "discriminant",
    offset: yield* reader.position,
    path: [],
    detail: "Unsupported callback security flavor"
  })
})

const readCallbackSecurityArray = Effect.fnUntraced(function*(reader: DecoderSession, limits: Nfs4Limits) {
  const count = yield* reader.read(XdrCodec.uint32)

  if (count > limits.maxArrayElements) {
    return yield* new XdrDecodeError({
      reason: "length-limit",
      offset: yield* reader.position,
      path: [],
      detail: "XDR array exceeds its element limit"
    })
  }

  return yield* Effect.forEach(Array.from({ length: count }), () => readCallbackSecurity(reader, limits))
})

/**
 * Picks the credential a callback will carry. AUTH_NONE is preferred when the client offered it,
 * since it needs no identity; otherwise the client's own AUTH_SYS credential is used. A client
 * that offered neither has authorized nothing this server can encode, and gets no callbacks.
 *
 * An AUTH_SYS credential is only usable if it fits RFC 5531's 400-byte `opaque_auth` limit. The
 * callback parameters are decoded with the compound's own XDR limits, which are far looser, so an
 * offered credential can be well-formed here and still be unsendable; that entry is skipped
 * rather than emitted as a malformed callback.
 */
const chooseCallbackSecurity = (
  offered: ReadonlyArray<CallbackSecurity>
): CallbackSecurity | undefined =>
  offered.find((entry) => entry.flavor === AUTH_NONE) ??
    offered.find((entry) => entry.flavor === AUTH_SYS && (entry.credential?.length ?? 0) <= MAX_OPAQUE_AUTH_BYTES)

const writeChannelAttrs = (writer: EncoderSession, attrs: ChannelAttrs) => writer.write(ChannelAttrsCodec, attrs)

/** state_protect_ops4: the operations a client wants enforced and allowed under the protection. */
const readStateProtectOps = Effect.fnUntraced(function*(reader: DecoderSession, limits: Nfs4Limits) {
  yield* bitmap(reader, limits.maxBitmapWords)
  yield* bitmap(reader, limits.maxBitmapWords)
})

const readStateProtection = Effect.fnUntraced(function*(reader: DecoderSession, limits: Nfs4Limits) {
  const how = yield* reader.read(XdrCodec.uint32)

  if (how === SP4_MACH_CRED) {
    yield* readStateProtectOps(reader, limits)
  } else if (how === SP4_SSV) {
    // ssv_sp_parms4: ops, hash and encryption algorithm lists, window, and GSS handle count.
    yield* readStateProtectOps(reader, limits)
    yield* reader.read(XdrCodec.array(XdrCodec.opaque(limits.maxOpaqueBytes), limits.maxArrayElements))
    yield* reader.read(XdrCodec.array(XdrCodec.opaque(limits.maxOpaqueBytes), limits.maxArrayElements))
    yield* reader.read(XdrCodec.uint32)
    yield* reader.read(XdrCodec.uint32)
  } else if (how !== SP4_NONE) {
    return yield* new XdrDecodeError({
      reason: "discriminant",
      offset: yield* reader.position,
      path: [],
      detail: "Invalid state protection discriminant"
    })
  }

  return how
})

const readLockType = Effect.fnUntraced(function*(reader: DecoderSession) {
  const lockType = yield* reader.read(XdrCodec.uint32)

  if (lockType < 1 || lockType > 4) {
    return yield* new XdrDecodeError({
      reason: "range",
      offset: yield* reader.position,
      path: [],
      detail: "Invalid lock type"
    })
  }

  return lockType
})

const decodeOperation = Effect.fnUntraced(function*(code: number, reader: DecoderSession, limits: Nfs4Limits) {
  switch (code) {
    case Operation.ACCESS:
      return { kind: "Access", code, value: (yield* reader.read(XdrCodec.uint32)) }
    case Operation.CLOSE:
      return {
        kind: "Close",
        code,
        value: {
          sequence: (yield* reader.read(XdrCodec.uint32)),
          stateid: (yield* reader.read(XdrCodec.fixedOpaque(16)))
        }
      }
    case Operation.CREATE: {
      const kind = yield* reader.read(XdrCodec.uint32)

      const target = kind === 5 ? (yield* reader.read(XdrCodec.string(limits.maxStringBytes))) : undefined

      if (kind === 3 || kind === 4) {
        yield* reader.read(XdrCodec.uint32)
        yield* reader.read(XdrCodec.uint32)
      }

      const name = yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))
      const attrs = yield* readAttributes(reader, limits)

      return { kind: "Create", code, value: { kind, name, attrs, target } }
    }

    case Operation.GETATTR:
      return { kind: "Getattr", code, value: (yield* bitmap(reader, limits.maxBitmapWords)) }
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
      return { kind: "Link", code, value: (yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))) }
    case Operation.LOOKUP:
      return { kind: "Lookup", code, value: (yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))) }
    case Operation.REMOVE:
      return { kind: "Remove", code, value: (yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))) }
    case Operation.OPEN: {
      const sequence = yield* reader.read(XdrCodec.uint32)
      const access = yield* reader.read(XdrCodec.uint32)
      const deny = yield* reader.read(XdrCodec.uint32)
      const client = yield* reader.read(XdrCodec.uint64)
      const owner = yield* reader.read(XdrCodec.opaque(limits.maxOwnerBytes))
      const openHow = yield* reader.read(XdrCodec.uint32)
      let create: Extract<ParsedOperation, { kind: "Open" }>["value"]["create"]

      if (openHow === 1) {
        const createMode = yield* reader.read(XdrCodec.uint32)
        let verifier: Uint8Array = empty
        let attrs: ParsedAttributes = { bitmap: [], values: empty }

        if (createMode === 0 || createMode === 1) {
          attrs = yield* readAttributes(reader, limits)
        } else if (createMode === 2) {
          verifier = yield* reader.read(XdrCodec.fixedOpaque(8))
        } else if (createMode === 3) {
          verifier = yield* reader.read(XdrCodec.fixedOpaque(8))
          attrs = yield* readAttributes(reader, limits)
        } else {
          return yield* new XdrDecodeError({
            reason: "discriminant",
            offset: yield* reader.position,
            path: [],
            detail: "Invalid OPEN create mode"
          })
        }

        create = { mode: createMode, verifier, attrs }
      } else if (openHow !== 0) {
        return yield* new XdrDecodeError({
          reason: "discriminant",
          offset: yield* reader.position,
          path: [],
          detail: "Invalid OPEN how discriminant"
        })
      }

      const claim = yield* reader.read(XdrCodec.uint32)
      let name: Uint8Array = empty

      if (claim === 0 || claim === 3) name = yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))
      else if (claim === 1) yield* reader.read(XdrCodec.uint32)
      else if (claim === 2) {
        yield* reader.read(XdrCodec.fixedOpaque(16))
        name = yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))
      } else if (claim === 5) yield* reader.read(XdrCodec.fixedOpaque(16))
      else if (claim !== 4 && claim !== 6) {
        return yield* new XdrDecodeError({
          reason: "discriminant",
          offset: yield* reader.position,
          path: [],
          detail: "Invalid OPEN claim"
        })
      }

      return { kind: "Open", code, value: { sequence, access, deny, client, owner, openHow, create, claim, name } }
    }

    case Operation.PUTFH:
      return { kind: "Putfh", code, value: (yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))) }
    case Operation.READ:
      return {
        code,
        kind: "Read",
        value: {
          stateid: (yield* reader.read(XdrCodec.fixedOpaque(16))),
          offset: (yield* reader.read(XdrCodec.uint64)),
          count: (yield* reader.read(XdrCodec.uint32))
        }
      }
    case Operation.READDIR:
      return {
        code,
        kind: "Readdir",
        value: {
          cookie: (yield* reader.read(XdrCodec.uint64)),
          verifier: (yield* reader.read(XdrCodec.fixedOpaque(8))),
          dircount: (yield* reader.read(XdrCodec.uint32)),
          maxcount: (yield* reader.read(XdrCodec.uint32)),
          attrs: (yield* bitmap(reader, limits.maxBitmapWords))
        }
      }
    case Operation.RENAME:
      return {
        code,
        kind: "Rename",
        value: {
          oldName: (yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))),
          newName: (yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes)))
        }
      }
    case Operation.SETATTR:
      return {
        code,
        kind: "Setattr",
        value: {
          stateid: (yield* reader.read(XdrCodec.fixedOpaque(16))),
          attrs: (yield* readAttributes(reader, limits))
        }
      }
    case Operation.WRITE:
      return {
        code,
        kind: "Write",
        value: {
          stateid: (yield* reader.read(XdrCodec.fixedOpaque(16))),
          offset: (yield* reader.read(XdrCodec.uint64)),
          stable: (yield* reader.read(XdrCodec.uint32)),
          data: (yield* reader.read(XdrCodec.opaque(limits.maxWriteBytes)))
        }
      }
    case Operation.EXCHANGE_ID: {
      const verifier = yield* reader.read(XdrCodec.fixedOpaque(8))
      const owner = yield* reader.read(XdrCodec.opaque(limits.maxOwnerBytes))
      const flags = yield* reader.read(XdrCodec.uint32)
      const protection = yield* readStateProtection(reader, limits)

      // eia_client_impl_id<1>: at most one implementation record (RFC 5662).
      yield* reader.read(XdrCodec.array(
        XdrCodec.struct({
          domain: XdrCodec.string(limits.maxStringBytes),
          name: XdrCodec.string(limits.maxStringBytes),
          seconds: XdrCodec.uint64,
          nanoseconds: XdrCodec.uint32
        }),
        1
      ))

      return { kind: "ExchangeId", code, value: { verifier, owner, flags, protection } }
    }

    case Operation.CREATE_SESSION: {
      const client = yield* reader.read(XdrCodec.uint64)
      const sequence = yield* reader.read(XdrCodec.uint32)
      const flags = yield* reader.read(XdrCodec.uint32)
      const fore = yield* readChannelAttrs(reader)
      const back = yield* readChannelAttrs(reader)
      const callbackProgram = yield* reader.read(XdrCodec.uint32)
      const flavors = yield* readCallbackSecurityArray(reader, limits)

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
      return { kind: "DestroySession", code, value: (yield* reader.read(XdrCodec.fixedOpaque(16))) }
    case Operation.SEQUENCE:
      return {
        code,
        kind: "Sequence",
        value: {
          session: (yield* reader.read(XdrCodec.fixedOpaque(16))),
          sequence: (yield* reader.read(XdrCodec.uint32)),
          slot: (yield* reader.read(XdrCodec.uint32)),
          highest: (yield* reader.read(XdrCodec.uint32)),
          cache: (yield* reader.read(XdrCodec.boolean))
        }
      }
    case Operation.DESTROY_CLIENTID:
      return { kind: "DestroyClient", code, value: (yield* reader.read(XdrCodec.uint64)) }
    case Operation.RECLAIM_COMPLETE:
      return { kind: "ReclaimComplete", code, value: (yield* reader.read(XdrCodec.boolean)) }
    case Operation.COMMIT:
      return {
        kind: "Commit",
        code,
        value: { offset: (yield* reader.read(XdrCodec.uint64)), count: (yield* reader.read(XdrCodec.uint32)) }
      }
    case Operation.LOCK: {
      const lockType = yield* readLockType(reader)
      const reclaim = yield* reader.read(XdrCodec.boolean)
      const offset = yield* reader.read(XdrCodec.uint64)
      const length = yield* reader.read(XdrCodec.uint64)
      let locker: LockOwnerArgument

      if ((yield* reader.read(XdrCodec.boolean))) {
        yield* reader.read(XdrCodec.uint32)
        const stateid = yield* reader.read(XdrCodec.fixedOpaque(16))
        yield* reader.read(XdrCodec.uint32)
        locker = { kind: "new", stateid, owner: (yield* readStateOwner(reader, limits)) }
      } else {
        const stateid = yield* reader.read(XdrCodec.fixedOpaque(16))
        yield* reader.read(XdrCodec.uint32)
        locker = { kind: "existing", stateid }
      }

      return { kind: "Lock", code, value: { lockType, reclaim, offset, length, locker } }
    }

    case Operation.LOCKT: {
      const lockType = yield* readLockType(reader)
      const offset = yield* reader.read(XdrCodec.uint64)
      const length = yield* reader.read(XdrCodec.uint64)
      const owner = yield* readStateOwner(reader, limits)

      return { kind: "Lockt", code, value: { lockType, offset, length, owner } }
    }

    case Operation.LOCKU: {
      yield* readLockType(reader)
      yield* reader.read(XdrCodec.uint32)
      const stateid = yield* reader.read(XdrCodec.fixedOpaque(16))
      const offset = yield* reader.read(XdrCodec.uint64)
      const length = yield* reader.read(XdrCodec.uint64)

      return { kind: "Locku", code, value: { stateid, offset, length } }
    }

    case Operation.NVERIFY:
    case Operation.VERIFY:
      return {
        kind: "Verify",
        code,
        value: {
          bitmap: (yield* bitmap(reader, limits.maxBitmapWords)),
          values: (yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes)))
        }
      }
    case Operation.OPEN_DOWNGRADE:
      return {
        kind: "OpenDowngrade",
        code,
        value: {
          stateid: (yield* reader.read(XdrCodec.fixedOpaque(16))),
          sequence: (yield* reader.read(XdrCodec.uint32)),
          access: (yield* reader.read(XdrCodec.uint32)),
          deny: (yield* reader.read(XdrCodec.uint32))
        }
      }
    case Operation.PUTPUBFH:
      return { kind: "Putpubfh", code, value: undefined }
    case Operation.SECINFO:
      return { kind: "Secinfo", code, value: (yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))) }
    case Operation.SECINFO_NO_NAME: {
      const style = yield* reader.read(XdrCodec.uint32)

      if (style !== SECINFO_STYLE4_CURRENT_FH && style !== SECINFO_STYLE4_PARENT) {
        return yield* new XdrDecodeError({
          reason: "discriminant",
          offset: yield* reader.position,
          path: [],
          detail: "Invalid SECINFO_NO_NAME style"
        })
      }

      return { kind: "SecinfoNoName", code, value: style }
    }

    case Operation.FREE_STATEID:
      return { kind: "FreeStateid", code, value: (yield* reader.read(XdrCodec.fixedOpaque(16))) }
    case Operation.BACKCHANNEL_CTL: {
      const program = yield* reader.read(XdrCodec.uint32)
      const flavors = yield* readCallbackSecurityArray(reader, limits)

      return {
        kind: "BackchannelCtl",
        code,
        value: { program, security: flavors, gssCallback: flavors.some((entry) => entry.flavor === RPCSEC_GSS) }
      }
    }

    case Operation.BIND_CONN_TO_SESSION: {
      const session = yield* reader.read(XdrCodec.fixedOpaque(16))
      const direction = yield* reader.read(XdrCodec.uint32)

      // channel_dir_from_client4: FORE (1), BACK (2), FORE_OR_BOTH (3), or BACK_OR_BOTH (7).
      if (direction < CDFC4_FORE || (direction > CDFC4_FORE_OR_BOTH && direction !== CDFC4_BACK_OR_BOTH)) {
        return yield* new XdrDecodeError({
          reason: "discriminant",
          offset: yield* reader.position,
          path: [],
          detail: "Invalid channel direction"
        })
      }

      yield* reader.read(XdrCodec.boolean)

      return { kind: "BindConnToSession", code, value: { session, direction } }
    }

    case Operation.SET_SSV:
      yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))
      yield* reader.read(XdrCodec.opaque(limits.maxOpaqueBytes))

      return { kind: "SetSsv", code, value: undefined }
    case Operation.TEST_STATEID:
      return {
        kind: "TestStateid",
        code,
        value: yield* reader.read(XdrCodec.array(XdrCodec.fixedOpaque(16), limits.maxArrayElements))
      }
    default:
      if (mustNotImplementOperations.has(code) || unsupportedOptionalOperations.has(code)) {
        return { kind: "NotSupported", code, value: undefined }
      }

      return { kind: "Unknown", code, value: undefined }
  }
})

const parseCompound = Effect.fnUntraced(function*(bytes: Uint8Array, limits: Nfs4Limits) {
  if (byteLength(bytes.length) > limits.maxCompoundBytes) {
    return yield* new XdrDecodeError({
      reason: "length-limit",
      offset: 0,
      path: [],
      detail: "COMPOUND exceeds byte limit"
    })
  }

  const reader = yield* xdr.openReader(bytes, limits)
  const tag = yield* reader.read(XdrCodec.opaque(limits.maxStringBytes))
  const minor = yield* reader.read(XdrCodec.uint32)
  const count = yield* reader.read(XdrCodec.uint32)

  if (count > limits.maxOperations || count > limits.maxArrayElements) {
    return yield* new XdrDecodeError({
      reason: "length-limit",
      offset: yield* reader.position,
      path: [],
      detail: "COMPOUND operation count exceeds its limit"
    })
  }

  const operations: Array<ParsedOperation> = []
  let stopped = false

  for (let index = 0; index < count; index++) {
    const code = yield* reader.read(XdrCodec.uint32)
    const decoded = yield* Effect.result(decodeOperation(code, reader, limits))

    // SAFETY: decodeOperation returns a ParsedOperation on every successful branch.
    const operation: ParsedOperation = Result.isFailure(decoded)
      ? { kind: "Malformed", code, value: undefined }
      : decoded.success as ParsedOperation

    operations.push(operation)

    // The compound fails at an undecoded operation, so later bytes are never interpreted.
    if (operation.kind === "Unknown" || operation.kind === "NotSupported" || operation.kind === "Malformed") {
      stopped = true
      break
    }
  }

  if (!stopped) yield* reader.finish

  return { tag, minor, count, operations }
})

const encodeCompound = (
  limits: Nfs4Limits,
  tag: Uint8Array,
  parts: ReadonlyArray<ResultPart>,
  overallStatus = parts.find((part) => part.status !== Status.OK)?.status ?? Status.OK
): Effect.Effect<Uint8Array, XdrEncodeError> =>
  Effect.gen(function*() {
    const writer = yield* xdr.openWriter(limits, ByteSize.toNumberUnsafe(limits.maxRecordBytes))
    yield* writer.write(XdrCodec.uint32, overallStatus)
    yield* writer.write(XdrCodec.opaque(limits.maxStringBytes), tag)
    yield* writer.write(XdrCodec.uint32, parts.length)

    for (const part of parts) {
      yield* writer.write(XdrCodec.uint32, part.code)
      yield* writer.write(XdrCodec.uint32, part.status)

      if (part.body !== undefined) yield* writer.appendEncoded(part.body)
    }

    return yield* writer.finish
  })

const fsStatuses: Readonly<Record<Vfs.VfsCode, number>> = {
  NotFound: Status.NOENT,
  AlreadyExists: Status.EXIST,
  NotEmpty: Status.NOTEMPTY,
  NotDirectory: Status.NOTDIR,
  AccessDenied: Status.ACCESS,
  NotPermitted: Status.PERM,
  InvalidHandle: Status.SERVERFAULT,
  ForeignHandle: Status.SERVERFAULT,
  InvalidReference: Status.SERVERFAULT,
  ForeignReference: Status.SERVERFAULT,
  StaleReference: Status.STALE,
  ClosedCaller: Status.SERVERFAULT,
  InvalidArgument: Status.INVAL,
  InvalidPathEncoding: Status.INVAL,
  PathTooLong: Status.NAMETOOLONG,
  NoSpace: Status.NOSPC,
  IsDirectory: Status.ISDIR,
  FileTooLarge: Status.FBIG,
  NoData: Status.SERVERFAULT,
  StorageRejected: Status.IO,
  OutcomeUnknown: Status.IO,
  VolumeUnavailable: Status.IO,
  VolumeBusy: Status.DELAY,
  // NFSv4.1 has no LOOP status. The reference-based NFS read path never follows symbolic links.
  SymlinkLoop: Status.INVAL,
  UnrepresentableName: Status.INVAL,
  // Codec and store failures never reach an NFS operation; a server fault says so if one does.
  InvalidEncoding: Status.SERVERFAULT,
  UnsupportedVersion: Status.SERVERFAULT,
  InvalidStructure: Status.SERVERFAULT,
  LimitExceeded: Status.SERVERFAULT,
  BaseMismatch: Status.SERVERFAULT,
  Storage: Status.IO,
  Ownership: Status.IO,
  IncompatibleStore: Status.IO,
  CorruptStore: Status.IO
}

// RFC 8881 Section 15.2 lists NFS4ERR_PERM for CREATE, OPEN and SETATTR only. Core's NotPermitted (EPERM) from
// any other operation, such as a sticky-directory REMOVE or RENAME, answers ACCESS, which their Section 15.2 lists
// include.
const PERM_OPERATIONS: ReadonlySet<number> = new Set([Operation.CREATE, Operation.OPEN, Operation.SETATTR])

// The table is total over the codes this build knows. The guard is for a core release newer than this server,
// whose errors can carry a code added since, which a client should see as a server fault.
/** @internal */
export const failureForFs = (error: Vfs.VfsError, operation: number): number => {
  if (!Object.hasOwn(fsStatuses, error.code)) return Status.SERVERFAULT
  const status = fsStatuses[error.code]

  return status === Status.PERM && !PERM_OPERATIONS.has(operation) ? Status.ACCESS : status
}

type WriteField = (writer: EncoderSession) => Effect.Effect<void, XdrEncodeError>

const field = <A>(codec: XdrCodec<A>, value: A): WriteField => (writer) => writer.write(codec, value)

const encodeStatusBody = (
  limits: Nfs4Limits,
  fields: ReadonlyArray<WriteField>
): Effect.Effect<Uint8Array, XdrEncodeError> =>
  Effect.gen(function*() {
    const writer = yield* xdr.openWriter(limits, ByteSize.toNumberUnsafe(limits.maxRecordBytes))
    yield* Effect.forEach(fields, (write) => write(writer), { discard: true })

    return yield* writer.finish
  })

const baseSupportedAttributes = [
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

const maxUint64 = 0xffff_ffff_ffff_ffffn

const supportedAttributesFor = (export_: NfsExport): ReadonlyArray<number> => {
  const capacity = export_.capacity

  if (capacity === undefined) return baseSupportedAttributes

  const { maxBytes, maxEntries } = capacity.limits
  const additional = [27]

  if (maxEntries !== undefined) additional.push(21, 22, 23)

  if (maxBytes !== undefined && ByteSize.toBigInt(maxBytes) <= maxUint64) additional.push(42, 43, 44)

  return [...baseSupportedAttributes, ...additional].sort((left, right) => left - right)
}

const capacityAttributes: ReadonlySet<number> = new Set([21, 22, 23, 42, 43, 44])

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

const encodeTime = (writer: EncoderSession, nanoseconds: bigint): Effect.Effect<boolean, XdrEncodeError> =>
  Effect.gen(function*() {
    const remainder = nanoseconds % 1_000_000_000n
    const seconds = nanoseconds / 1_000_000_000n - (remainder < 0n ? 1n : 0n)
    const nanos = remainder < 0n ? remainder + 1_000_000_000n : remainder

    if (seconds < -0x8000_0000_0000_0000n || seconds > 0x7fff_ffff_ffff_ffffn) return false
    yield* writer.write(XdrCodec.uint64, BigInt.asUintN(64, seconds))
    yield* writer.write(XdrCodec.uint32, Number(nanos))

    return true
  })

const encodeAttributeValues = (
  requested: ReadonlyArray<number>,
  observation: Vfs.ObjectObservation<Vfs.Metadata>,
  filehandle: Uint8Array,
  export_: NfsExport,
  options: Nfs4Options,
  supportedAttributes: ReadonlyArray<number>,
  usage: Vfs.VolumeUsage | null
): Effect.Effect<Uint8Array | undefined, XdrEncodeError> =>
  Effect.gen(function*() {
    if (requested.some((attribute) => !supportedAttributes.includes(attribute))) return undefined
    const values = yield* xdr.openWriter(options.limits, ByteSize.toNumberUnsafe(options.limits.maxRecordBytes))
    const metadata = observation.value

    for (const attribute of requested) {
      switch (attribute) {
        case 0:
          yield* writeBitmap(values, wordsFor(supportedAttributes))
          break
        case 1:
          yield* values.write(XdrCodec.uint32, metadata.kind === "file" ? 1 : metadata.kind === "directory" ? 2 : 5)
          break
        case 2:
          yield* values.write(XdrCodec.uint32, 0x3)
          break
        case 3:
          yield* values.write(XdrCodec.uint64, BigInt.asUintN(64, observation.revision))
          break
        case 4:
          yield* values.write(XdrCodec.uint64, metadata.size)
          break
        case 5:
        case 6:
        case 9:
        case 17:
        case 26:
        case 34:
          yield* values.write(XdrCodec.boolean, true)
          break
        case 7:
        case 16:
          yield* values.write(XdrCodec.boolean, false)
          break
        case 51:
          yield* values.write(XdrCodec.uint64, 0n)
          yield* values.write(XdrCodec.uint32, 1)
          break
        case 76:
          yield* values.write(XdrCodec.uint32, FSCHARSET_CAP4_ALLOWS_ONLY_UTF8)
          break
        case 8:
          yield* values.write(XdrCodec.uint64, export_.fsid[0])
          yield* values.write(XdrCodec.uint64, export_.fsid[1])
          break
        case 10:
          yield* values.write(XdrCodec.uint32, options.leaseDurationSeconds)
          break
        case 11:
          yield* values.write(XdrCodec.uint32, Status.OK)
          break
        case 19:
          yield* values.write(XdrCodec.opaque(), filehandle)
          break
        case 20:
        case 55:
          yield* values.write(XdrCodec.uint64, BigInt.asUintN(64, metadata.ino))
          break
        case 21:
        case 22:
        case 23: {
          const total = BigInt(export_.capacity!.limits.maxEntries!)
          yield* values.write(XdrCodec.uint64, attribute === 23 ? total : total - BigInt(usage!.entries))
          break
        }

        case 27:
          yield* values.write(XdrCodec.uint64, ByteSize.toBigInt(export_.capacity!.limits.maxFileBytes))
          break
        case 29:
          yield* values.write(XdrCodec.uint32, ByteSize.toNumberUnsafe(options.limits.maxNameBytes))
          break
        case 30:
          yield* values.write(XdrCodec.uint64, options.limits.maxReadBytes)
          break
        case 31:
          yield* values.write(XdrCodec.uint64, options.limits.maxWriteBytes)
          break
        case 33:
          yield* values.write(XdrCodec.uint32, metadata.mode)
          break
        case 35:
          yield* values.write(XdrCodec.uint32, metadata.nlink)
          break
        case 36:
          yield* values.write(XdrCodec.string(), String(metadata.uid))
          break
        case 37:
          yield* values.write(XdrCodec.string(), String(metadata.gid))
          break
        case 42:
        case 43:
        case 44: {
          const total = ByteSize.toBigInt(export_.capacity!.limits.maxBytes!)
          yield* values.write(XdrCodec.uint64, attribute === 44 ? total : total - usage!.usedBytes)
          break
        }

        case 45:
          yield* values.write(XdrCodec.uint64, metadata.size)
          break
        case 47:
          if (!(yield* encodeTime(values, metadata.atimeNs))) return undefined
          break
        case 52:
          if (!(yield* encodeTime(values, metadata.ctimeNs))) return undefined
          break
        case 53:
          if (!(yield* encodeTime(values, metadata.mtimeNs))) return undefined
          break
        case 75:
          yield* writeBitmap(values, options.writable ? wordsFor([4, 33, 36, 37]) : [])
          break
      }
    }

    return yield* values.finish
  })

const encodeAttributes = (
  requested: ReadonlyArray<number>,
  observation: Vfs.ObjectObservation<Vfs.Metadata>,
  filehandle: Uint8Array,
  export_: NfsExport,
  options: Nfs4Options,
  supportedAttributes: ReadonlyArray<number>,
  usage: Vfs.VolumeUsage | null
): Effect.Effect<Uint8Array | undefined, XdrEncodeError> =>
  Effect.gen(function*() {
    const values = yield* encodeAttributeValues(
      requested,
      observation,
      filehandle,
      export_,
      options,
      supportedAttributes,
      usage
    )

    if (values === undefined) return undefined

    return yield* encodeStatusBody(options.limits, [
      (writer) => writeBitmap(writer, wordsFor(requested)),
      field(XdrCodec.opaque(), values)
    ])
  })

/** Encodes a READDIR entry's attributes as only `rdattr_error` (RFC 8881 Section 18.23.3). */
const encodeReaddirError = (status: number, limits: Nfs4Limits): Effect.Effect<Uint8Array, XdrEncodeError> =>
  Effect.gen(function*() {
    const error = yield* xdr.encode(status, XdrCodec.uint32, limits, ByteSize.toNumberUnsafe(limits.maxRecordBytes))

    return yield* encodeStatusBody(limits, [
      (writer) => writeBitmap(writer, wordsFor([11])),
      field(XdrCodec.opaque(), error)
    ])
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
 *
 * In `read-only-local` this answer is advisory: OPEN and READ run through the
 * single privileged caller and perform no mode check, so a file ACCESS reports
 * as unreadable is still readable. That asymmetry is the profile's documented
 * boundary. `read-only-networked` maps the identity to a VFS caller and asks
 * that caller instead, so ACCESS and OPEN agree by construction.
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
  body: Uint8Array,
  limits: Nfs4Limits
): Effect.Effect<Uint8Array, XdrEncodeError> =>
  Effect.gen(function*() {
    const writer = yield* xdr.openWriter(limits, ByteSize.toNumberUnsafe(limits.maxRecordBytes))
    yield* writer.write(XdrCodec.uint32, xid)
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.uint32, 2)
    yield* writer.write(XdrCodec.uint32, program)
    yield* writer.write(XdrCodec.uint32, CALLBACK_RPC_VERSION)
    yield* writer.write(XdrCodec.uint32, procedure)
    yield* writer.write(XdrCodec.uint32, security.flavor)
    yield* writer.write(XdrCodec.opaque(ByteSize.bytes(MAX_OPAQUE_AUTH_BYTES)), security.credential ?? empty)
    yield* writer.write(XdrCodec.uint32, 0)
    yield* writer.write(XdrCodec.opaque(ByteSize.bytes(MAX_OPAQUE_AUTH_BYTES)), empty)
    yield* writer.appendEncoded(body)

    return yield* writer.finish
  })

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
  highestSlot: number,
  limits: Nfs4Limits
): Effect.Effect<Uint8Array, XdrEncodeError> =>
  encodeStatusBody(limits, [
    field(XdrCodec.string(), "probe"),
    field(XdrCodec.uint32, 1),
    field(XdrCodec.uint32, 0),
    field(XdrCodec.uint32, 1),
    field(XdrCodec.uint32, OP_CB_SEQUENCE),
    field(XdrCodec.fixedOpaque(16), session),
    field(XdrCodec.uint32, sequence),
    field(XdrCodec.uint32, slot),
    field(XdrCodec.uint32, highestSlot),
    field(XdrCodec.boolean, false),
    field(XdrCodec.array(XdrCodec.uint32), [])
  ])

/**
 * Decides whether a callback reply actually says the client handled the callback. An RPC REPLY is
 * not success on its own: the client's RPC layer answers PROG_UNAVAIL for a program it does not
 * serve, and AUTH_ERROR for a credential it will not take, both of which are well-formed replies
 * from a client with no working callback path. The CB_SEQUENCE result is checked too, because
 * Section 20.9.3 lets the client reject the slot or sequence it was given.
 */
const callbackAccepted = (
  reply: Uint8Array,
  limits: Nfs4Limits,
  session: Uint8Array,
  slot: number,
  sequence: number
): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const reader = yield* xdr.openReader(reply, limits)
    yield* reader.read(XdrCodec.uint32)

    // RPC: REPLY, MSG_ACCEPTED, verifier, then SUCCESS.
    if ((yield* reader.read(XdrCodec.uint32)) !== 1) return false

    if ((yield* reader.read(XdrCodec.uint32)) !== 0) return false
    yield* reader.read(XdrCodec.uint32)
    yield* reader.read(XdrCodec.opaque(ByteSize.bytes(MAX_OPAQUE_AUTH_BYTES)))

    if ((yield* reader.read(XdrCodec.uint32)) !== 0) return false

    // CB_COMPOUND: an all-OK status, then CB_SEQUENCE first (Section 20.9.3).
    if ((yield* reader.read(XdrCodec.uint32)) !== Status.OK) return false
    yield* reader.read(XdrCodec.string(limits.maxStringBytes))

    // Exactly one result: this server sends a CB_SEQUENCE-only CB_COMPOUND, so anything else is
    // not an answer to what it asked.
    if ((yield* reader.read(XdrCodec.uint32)) !== 1) return false

    if ((yield* reader.read(XdrCodec.uint32)) !== OP_CB_SEQUENCE) return false

    if ((yield* reader.read(XdrCodec.uint32)) !== Status.OK) return false

    // The client echoes what it was given; anything else means it answered a different callback.
    const echoed = bytesKey(yield* reader.read(XdrCodec.fixedOpaque(16))) === bytesKey(session) &&
      (yield* reader.read(XdrCodec.uint32)) === sequence &&
      (yield* reader.read(XdrCodec.uint32)) === slot

    // csr_highest_slotid and csr_target_highest_slotid are mandatory, and nothing may follow the
    // one result. Reading them out and finishing rejects a truncated or padded reply, which would
    // otherwise pass as a working callback path.
    yield* reader.read(XdrCodec.uint32)
    yield* reader.read(XdrCodec.uint32)
    yield* reader.finish

    return echoed
  }).pipe(Effect.catchTag("XdrDecodeError", () => Effect.succeed(false)))

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
  "Create",
  "Link",
  "Remove",
  "Rename",
  "Setattr",
  "Write",
  "Commit",
  "Open",
  "Close",
  "OpenDowngrade",
  "Lock",
  "Locku",
  "FreeStateid",
  "ExchangeId",
  "CreateSession",
  "DestroySession",
  "DestroyClient",
  "ReclaimComplete",
  // BACKCHANNEL_CTL replaces the callback program and credential and re-arms the probe, so a
  // compound carrying it must be bounded by its worst case: otherwise an optimistic bound lets
  // the mutation happen and the reply overflow afterwards, and only SEQUENCE is rolled back.
  "BackchannelCtl"
])

/**
 * Reply bound used by SEQUENCE before operation dispatch.
 * Variable-size results are bounded optimistically so small actual replies still fit a small
 * channel, and the slot is rolled back if the encoded reply proves too large. When the compound
 * also changes state, every variable result uses its worst case instead, because a rollback
 * cannot undo the state change.
 */
const replayReplyBound = (
  operations: ReadonlyArray<ParsedOperation>,
  tagBytes: number,
  limits: Nfs4Limits,
  securityFlavorCount: number
): number => {
  let bytes = 12 + tagBytes + (4 - tagBytes % 4) % 4
  const worstCase = operations.some((operation) => stateChangingKinds.has(operation.kind))
  const maxReadBytes = ByteSize.toNumberUnsafe(limits.maxReadBytes)
  const maxReaddirReplyBytes = ByteSize.toNumberUnsafe(limits.maxReaddirReplyBytes)
  const maxStringBytes = ByteSize.toNumberUnsafe(limits.maxStringBytes)
  const maxOwnerBytes = ByteSize.toNumberUnsafe(limits.maxOwnerBytes)

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
        bytes += 8 + 16 + 4 + 16 + 4 + 12 + 8
        break
      case "Create":
        bytes += 64
        break
      case "Rename":
        bytes += 56
        break
      case "Link":
      case "Remove":
        bytes += 32
        break
      case "Setattr":
        bytes += 32
        break
      case "Write":
        bytes += 24
        break
      case "Commit":
        bytes += 16
        break
      case "Close":
      case "OpenDowngrade":
      case "Lock":
        bytes += 8 + Math.max(16, 8 + 8 + 4 + 8 + 4 + maxOwnerBytes + 4)
        break
      case "Lockt":
        bytes += 8 + 8 + 8 + 4 + 8 + 4 + maxOwnerBytes + 4
        break
      case "Locku":
        bytes += 8 + 16
        break
      case "TestStateid":
        bytes += 12 + 4 * operation.value.length
        break
      case "Secinfo":
      case "SecinfoNoName":
        bytes += 12 + 4 * securityFlavorCount
        break
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

/** @internal */
export const makeNfs4Handler = (
  export_: NfsExport,
  options: Nfs4Options
): Effect.Effect<Nfs4Handler, PlatformError.PlatformError, Scope.Scope | Crypto.Crypto> => {
  assertOptions(options)
  const storageGeneration = options.storageGeneration ?? options.generation
  const supportedAttributes = supportedAttributesFor(export_)

  const encodeBody = <A>(value: A, codec: XdrCodec<A>): Effect.Effect<Uint8Array, XdrEncodeError> =>
    xdr.encode(value, codec, options.limits, ByteSize.toNumberUnsafe(options.limits.maxRecordBytes))

  const sampleUsage = (requested: ReadonlyArray<number>): Effect.Effect<Vfs.VolumeUsage | null, Vfs.VfsError> =>
    requested.some((attribute) => capacityAttributes.has(attribute))
      ? export_.capacity!.usage
      : Effect.succeed(null)

  return Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    const verifierInput = new Uint8Array(33)
    verifierInput[0] = 1
    verifierInput.set(options.generation, 1)
    verifierInput.set(storageGeneration, 17)
    const writeVerifier = (yield* crypto.digest("SHA-256", verifierInput)).slice(0, 8)

    const handlerScope = yield* Effect.scope
    const clients = new Map<bigint, ClientState>()
    const clientsByOwner = new Map<string, ClientState>()
    const sessions = new Map<string, SessionState>()
    const opens = new Map<string, OpenState>()
    const lockStates = new Map<string, LockState>()
    let clientSerial = 1n
    let sessionSerial = 1n
    let openSerial = 1n
    let lockCount = 0

    const conflictingLock = (
      reference: Vfs.ObjectReference,
      client: ClientState,
      ownerKey: string,
      range: LockRange,
      type: number
    ) => {
      for (const state of lockStates.values()) {
        if (state.open.reference !== reference || (state.client === client && state.ownerKey === ownerKey)) continue

        for (const entry of state.ranges) {
          if (overlaps(entry.range, range) && (WRITE_LOCK_TYPES.has(type) || WRITE_LOCK_TYPES.has(entry.type))) {
            return { state, entry }
          }
        }
      }

      return undefined
    }

    const deniedLock = (
      code: number,
      conflict: { state: LockState; entry: HeldRange }
    ): Effect.Effect<ResultPart, XdrEncodeError> =>
      Effect.map(
        encodeStatusBody(options.limits, [
          field(XdrCodec.uint64, conflict.entry.range.offset),
          field(XdrCodec.uint64, conflict.entry.range.length),
          field(XdrCodec.uint32, conflict.entry.type),
          field(XdrCodec.uint64, conflict.state.client.id),
          field(XdrCodec.opaque(), conflict.state.owner)
        ]),
        (body): ResultPart => ({ code, status: Status.DENIED, body })
      )

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
    const pendingCallbacks = new Map<number, {
      readonly carrier: Connection
      readonly reply: Deferred.Deferred<Uint8Array>
    }>()

    let callbackXid = 1

    /**
     * Sends one callback down every connection carrying a session's backchannel and answers
     * whether any of them accepted it. The carriers race rather than taking turns: a connection
     * whose write succeeds but whose client never replies, or which answers with an RPC
     * rejection, must not stop a healthy second connection from winning, and one deadline covers
     * the whole attempt because the write itself can block against a peer that stops reading.
     */
    const callback = (
      session: SessionState,
      procedure: number,
      body: Uint8Array,
      accepted: (reply: Uint8Array) => Effect.Effect<boolean>
    ): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        const back = session.back
        const security = back?.security

        if (back === undefined || security === undefined) return false

        // A connection that has gone away is only removed from the map once `disconnect` acquires
        // the state gate, so a stale entry can still be present.
        const carriers: Array<Connection> = []

        for (const [connection, direction] of session.connections) {
          if ((direction & CHANNEL_BACK) !== 0) carriers.push(connection)
        }

        if (carriers.length === 0) return false

        // ca_maxrequestsize bounds the whole RPC call the client will accept, not just its
        // CB_COMPOUND body, so the framed message is what gets measured. The xid does not change
        // the size, so any value serves for the measurement.
        const measured = yield* Effect.result(
          encodeCallbackCall(0, back.program, procedure, security, body, options.limits)
        )

        if (Result.isFailure(measured) || measured.success.length > back.attrs.maxRequest) return false

        // A carrier that fails outright must not burn the whole deadline when it is the only one,
        // so the race also ends as soon as every carrier has definitively failed.
        let failed = 0
        const exhausted = yield* Deferred.make<boolean>()

        const noteFailure = Effect.sync(() => {
          failed++

          if (failed >= carriers.length) Deferred.doneUnsafe(exhausted, Effect.succeed(false))
        })

        const attempt = (carrier: Connection) =>
          Effect.gen(function*() {
            // The xid is masked because it is both a map key and a uint32 on the wire; an
            // unmasked counter would eventually throw instead of wrapping.
            const xid = callbackXid
            callbackXid = (callbackXid + 1) >>> 0
            const reply = yield* Deferred.make<Uint8Array>()
            pendingCallbacks.set(xid, { carrier, reply })

            return yield* Effect.ensuring(
              Effect.gen(function*() {
                const encoded = yield* Effect.result(
                  encodeCallbackCall(xid, back.program, procedure, security, body, options.limits)
                )

                if (Result.isFailure(encoded)) {
                  yield* noteFailure

                  return yield* Effect.never
                }

                const sent = yield* carrier.send(encoded.success)

                // A carrier that cannot be written to, or whose client rejects the callback, loses
                // the race instead of ending it. The outer deadline bounds the wait when every
                // carrier does so.
                if (!sent) {
                  yield* noteFailure

                  return yield* Effect.never
                }

                const answered = yield* Deferred.await(reply)

                if (yield* accepted(answered)) return true
                yield* noteFailure

                return yield* Effect.never
              }),
              Effect.sync(() => pendingCallbacks.delete(xid))
            )
          })

        return yield* Effect.raceAll([...carriers.map(attempt), Deferred.await(exhausted)]).pipe(
          Effect.timeoutOption(options.callbackTimeout),
          Effect.map((result) => Option.isSome(result) && result.value)
        )
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

        for (const [key, lock] of lockStates) {
          if (lock.client !== client) continue
          lockCount -= lock.ranges.length
          lockStates.delete(key)
        }

        for (const [key, open] of opens) {
          if (open.client !== client) continue

          // Revocation is reached from EXCHANGE_ID, CREATE_SESSION and an expired SEQUENCE, which
          // are interruptible operations. Each handle's close and its removal from `opens` are one
          // region for the same reason as CLOSE: an interrupt between them would leave a closed
          // handle for the handler scope's finalizer to close a second time. The loop stays
          // interruptible between opens.
          yield* Effect.uninterruptible(
            open.close.pipe(Effect.tap(() => Effect.sync(() => opens.delete(key))))
          )
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

    // Section 8.3: a lease expires on its own schedule, so reclamation cannot wait for a compound
    // from some other client. On an idle server that compound never arrives, and an abandoned
    // client's opens and replay budget would stay charged until the handler scope closed. Half the
    // lease bounds how long expired state outlives its lease by one tick.
    const sweepInterval = Duration.seconds(Math.max(1, options.leaseDurationSeconds / 2))

    yield* Effect.forkIn(
      // `Effect.uninterruptible` sits inside `withPermit`, never around it, so scope closure
      // interrupts a sweep that is still waiting for the gate rather than queueing behind it.
      Effect.repeat(stateGate.withPermit(Effect.uninterruptible(sweepExpired)), {
        schedule: Schedule.spaced(sweepInterval)
      }),
      handlerScope
    )

    yield* Effect.addFinalizer(() => Effect.forEach(opens.values(), (open) => open.close, { discard: true }))

    /** Reads only the leading SEQUENCE of a compound to find its session, tolerating later decode errors. */
    const sequenceSessionOf = (
      bytes: Uint8Array
    ): Effect.Effect<{ readonly session: SessionState; readonly operationCount: number } | undefined> =>
      Effect.gen(function*() {
        const reader = yield* xdr.openReader(bytes, options.limits)
        yield* reader.read(XdrCodec.opaque(options.limits.maxStringBytes))
        const minor = yield* reader.read(XdrCodec.uint32)
        const operationCount = yield* reader.read(XdrCodec.uint32)

        if (minor !== 1 || (yield* reader.read(XdrCodec.uint32)) !== Operation.SEQUENCE) return undefined

        const session = sessions.get(bytesKey(yield* reader.read(XdrCodec.fixedOpaque(16))))

        return session === undefined ? undefined : { session, operationCount }
      }).pipe(Effect.catchTag("XdrDecodeError", () => Effect.as(Effect.void, undefined)))

    /**
     * `restore` reopens the compound's own interrupt window. The caller runs the whole compound
     * uninterruptibly so the replay-slot commit below cannot be torn in half, but an operation
     * that stalls in the backing store must not hold the handler scope open forever, so each
     * operation is dispatched through it. The boundary is between operations: anything that
     * mutates server state guards itself within its own operation (see OPEN and CLOSE), and an
     * interrupt arriving between them rolls the slot back via `rollbackSequence` so nothing stays
     * charged for a reply that was never sent.
     */
    const executeCompound = (
      call: CompoundCall,
      export_: NfsExport,
      activeCaller: Vfs.Caller | undefined,
      restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
    ): Effect.Effect<Uint8Array, RpcPolicyDenied | XdrEncodeError> =>
      Effect.flatMap(
        Effect.result(parseCompound(call.arguments, options.limits)),
        (parsedResult): Effect.Effect<Uint8Array, RpcPolicyDenied | XdrEncodeError> => {
          if (Result.isFailure(parsedResult)) {
            return Effect.gen(function*() {
              const tagResult = yield* Effect.result(
                xdr.openReader(call.arguments, options.limits).pipe(
                  Effect.flatMap((reader) => reader.read(XdrCodec.opaque(options.limits.maxStringBytes)))
                )
              )

              const tag = Result.isFailure(tagResult) ? empty : tagResult.success

              // Section 2.10.6.4: an oversized request is reported as such even when later
              // operations fail to decode.
              const oversized = yield* sequenceSessionOf(call.arguments)

              if (
                oversized !== undefined &&
                (call.requestBytes ?? call.arguments.length) > oversized.session.fore.maxRequest
              ) {
                return yield* encodeCompound(options.limits, tag, [{
                  code: Operation.SEQUENCE,
                  status: Status.REQ_TOO_BIG
                }])
              }

              if (oversized !== undefined && oversized.operationCount > oversized.session.fore.maxOperations) {
                return yield* encodeCompound(options.limits, tag, [{
                  code: Operation.SEQUENCE,
                  status: Status.TOO_MANY_OPS
                }])
              }

              return yield* encodeCompound(options.limits, tag, [], Status.BADXDR)
            })
          }

          const parsed = parsedResult.success

          if (parsed.minor !== 1) {
            return encodeCompound(options.limits, parsed.tag, [], Status.MINOR_VERS_MISMATCH)
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
              return encodeCompound(options.limits, parsed.tag, [{
                code: Operation.ILLEGAL,
                status: Status.OP_ILLEGAL
              }])
            }

            if (first.kind === "Malformed") {
              return encodeCompound(options.limits, parsed.tag, [{ code: first.code, status: Status.BADXDR }])
            }

            // Sections 18.34.3, 18.35.3, 18.36.3, 18.37.3, and 18.50.3: these MUST be the only operation.
            if (isBootstrap) {
              return encodeCompound(options.limits, parsed.tag, [{ code: firstCode, status: Status.NOT_ONLY_OP }])
            }

            // Section 15.2 allows only NFS4ERR_NOTSUPP for the NFSv4.0 operations.
            if (mustNotImplementOperations.has(firstCode!)) {
              return encodeCompound(options.limits, parsed.tag, [{ code: firstCode!, status: Status.NOTSUPP }])
            }

            return encodeCompound(options.limits, parsed.tag, [{ code: firstCode!, status: Status.OP_NOT_IN_SESSION }])
          }

          if (first?.kind === "Sequence") {
            const value = first.value
            const session = sessions.get(bytesKey(value.session))
            const slot = session?.slots[value.slot]

            if (
              session !== undefined && slot !== undefined && value.sequence === slot.sequence &&
              slot.response !== undefined
            ) {
              // Section 2.10.3.1 ties association to SEQUENCE being transmitted, not to the result,
              // so it happens before the retry is judged: even a false retry was transmitted here.
              associate(session, call.connection, CHANNEL_FORE)

              if (!sameRequest(slot.request, call.arguments) || slot.credentials !== credentialsKey(call.credentials)) {
                return encodeCompound(options.limits, parsed.tag, [{
                  code: Operation.SEQUENCE,
                  status: Status.SEQ_FALSE_RETRY
                }])
              }

              // A policy may remap the same wire credential between attempts. Never replay a
              // response computed under a caller that no longer has this request's authority.
              if (slot.caller !== activeCaller) return Effect.fail(new RpcPolicyDenied())

              return Effect.succeed(new Uint8Array(slot.response))
            }
          }

          let rollbackSequence: (() => void) | undefined
          const mayChangeState = parsed.operations.some((operation) => stateChangingKinds.has(operation.kind))
          let consumedSequence = false

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

            const rejectAfterExecution = (status: number): Effect.Effect<Uint8Array, XdrEncodeError> => {
              if (!mayChangeState) {
                rollbackSequence?.()
              }

              rollbackSequence = undefined

              return encodeCompound(options.limits, parsed.tag, [{ code: Operation.SEQUENCE, status }])
            }

            for (let index = 0; index < parsed.operations.length; index++) {
              const operation = parsed.operations[index]!
              let result: ResultPart

              // Operations remain interruptible while waiting on the export. Their own commit
              // boundaries protect state changes; the consumed slot prevents rerunning them.
              result = yield* restore(execute(operation)).pipe(
                Effect.catchTag("XdrEncodeError", (error) =>
                  Effect.succeed({
                    code: operation.code,
                    status: error.reason === "output-limit" ? Status.REP_TOO_BIG : Status.SERVERFAULT
                  }))
              )
              parts.push(result)

              if (index === 0 && mayChangeState && activeSlot !== undefined && result.status === Status.OK) {
                // Publish a consumed-slot marker before any later operation can commit. An
                // interrupted or failed operation can leave this marker instead of its full reply.
                const second = parsed.operations[1]
                activeSlot.response = yield* (second === undefined
                  ? encodeCompound(options.limits, parsed.tag, [result])
                  : encodeCompound(options.limits, parsed.tag, [
                    result,
                    { code: second.code, status: Status.RETRY_UNCACHED_REP }
                  ]))
                activeSlot.request = new Uint8Array(call.arguments)
                activeSlot.credentials = credentialsKey(call.credentials)

                if (activeCaller === undefined) delete activeSlot.caller
                else activeSlot.caller = activeCaller

                consumedSequence = true
              }

              if (result.status !== Status.OK) break
            }

            const encodedResponse = yield* Effect.result(encodeCompound(options.limits, parsed.tag, parts))

            if (Result.isFailure(encodedResponse)) {
              if (encodedResponse.failure.reason === "output-limit") {
                return yield* rejectAfterExecution(Status.REP_TOO_BIG)
              }

              return yield* encodedResponse.failure
            }

            const response = encodedResponse.success
            const responseBytes = addBytes(byteLength(response.length), rpcReplyOverheadBytes)

            if (responseBytes > byteLength(activeSession?.fore.maxResponse ?? Number.MAX_SAFE_INTEGER)) {
              return yield* rejectAfterExecution(Status.REP_TOO_BIG)
            }

            if (
              shouldCache &&
              responseBytes > byteLength(activeSession?.fore.maxCachedResponse ?? Number.MAX_SAFE_INTEGER)
            ) {
              return yield* rejectAfterExecution(Status.REP_TOO_BIG_TO_CACHE)
            }

            if (activeSlot !== undefined && shouldCache) {
              const retainedBytes = addBytes(byteLength(call.arguments.length), byteLength(response.length))

              if (
                retainedBytes > options.limits.maxReplayBytes ||
                addBytes(
                    subtractBytes(replayBytes, activeSlot.retainedBytes ?? ByteSize.bytes(0)),
                    retainedBytes
                  ) > options.limits.maxReplayBytes
              ) {
                return yield* rejectAfterExecution(Status.REP_TOO_BIG_TO_CACHE)
              }

              replayBytes = subtractBytes(replayBytes, activeSlot.retainedBytes ?? ByteSize.bytes(0))
              activeSlot.response = new Uint8Array(response)
              activeSlot.request = new Uint8Array(call.arguments)
              activeSlot.credentials = credentialsKey(call.credentials)

              if (activeCaller === undefined) delete activeSlot.caller
              else activeSlot.caller = activeCaller
              activeSlot.retainedBytes = retainedBytes
              replayBytes = addBytes(replayBytes, retainedBytes)
            } else if (activeSlot !== undefined) {
              const sequencePart = parts[0]!
              const second = parsed.operations[1]

              const replay = yield* (second === undefined
                ? encodeCompound(options.limits, parsed.tag, [sequencePart])
                : encodeCompound(options.limits, parsed.tag, [
                  sequencePart,
                  { code: second.code, status: Status.RETRY_UNCACHED_REP }
                ]))

              const retainedBytes = addBytes(byteLength(call.arguments.length), byteLength(replay.length))

              if (
                addBytes(
                  subtractBytes(replayBytes, activeSlot.retainedBytes ?? ByteSize.bytes(0)),
                  retainedBytes
                ) > options.limits.maxReplayBytes
              ) {
                return yield* rejectAfterExecution(Status.DELAY)
              }

              replayBytes = subtractBytes(replayBytes, activeSlot.retainedBytes ?? ByteSize.bytes(0))
              activeSlot.response = replay
              activeSlot.request = new Uint8Array(call.arguments)
              activeSlot.credentials = credentialsKey(call.credentials)

              if (activeCaller === undefined) delete activeSlot.caller
              else activeSlot.caller = activeCaller
              activeSlot.retainedBytes = retainedBytes
              replayBytes = addBytes(replayBytes, retainedBytes)
            }

            rollbackSequence = undefined

            return response

            function execute(operation: ParsedOperation): Effect.Effect<ResultPart, XdrEncodeError> {
              const noCurrent = (): ResultPart => ({ code: operation.code, status: Status.NOFILEHANDLE })

              const mapFs = <A>(effect: Effect.Effect<A, Vfs.VfsError>): Effect.Effect<A, number> =>
                effect.pipe(Effect.mapError((error) => failureForFs(error, operation.code)))

              // Fails as ACCESS unless every requested bit is granted.
              const requireAccess = (reference: Vfs.ObjectReference, bits: number): Effect.Effect<void, number> =>
                mapFs(export_.access(reference, bits)).pipe(
                  Effect.flatMap((granted) => granted === bits ? Effect.void : Effect.fail(Status.ACCESS))
                )

              const withCurrent = <A>(
                f: (reference: Vfs.ObjectReference) => Effect.Effect<A, number>
              ): Effect.Effect<A, number> => current === undefined ? Effect.fail(Status.NOFILEHANDLE) : f(current)

              const statusResult = <A>(
                effect: Effect.Effect<A, number | XdrEncodeError>,
                success: (value: A) => Uint8Array | undefined | Effect.Effect<Uint8Array | undefined, XdrEncodeError> =
                  () => undefined
              ): Effect.Effect<ResultPart, XdrEncodeError> =>
                Effect.flatMap(Effect.result(effect), (outcome) => {
                  if (Result.isFailure(outcome)) {
                    return outcome.failure instanceof XdrEncodeError
                      ? Effect.fail(outcome.failure)
                      : Effect.succeed({ code: operation.code, status: outcome.failure })
                  }

                  const body = success(outcome.success)

                  return Effect.map(Effect.isEffect(body) ? body : Effect.succeed(body), (encoded): ResultPart =>
                    encoded === undefined
                      ? { code: operation.code, status: Status.OK }
                      : { code: operation.code, status: Status.OK, body: encoded })
                })

              const requireAttributes = (
                attributes: Effect.Effect<Uint8Array | undefined, XdrEncodeError>
              ): Effect.Effect<Uint8Array, number | XdrEncodeError> =>
                Effect.filterOrFail(
                  attributes,
                  (value): value is Uint8Array => value !== undefined,
                  () => Status.SERVERFAULT
                )

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
                  Effect.filterOrFail(
                    (observation) => observation.value.kind === "directory",
                    (observation) => observation.value.kind === "symlink" ? symlinkStatus : Status.NOTDIR
                  ),
                  Effect.asVoid
                )

              const parentOfDirectory = (
                reference: Vfs.ObjectReference,
                symlinkStatus: number
              ): Effect.Effect<Vfs.ObjectReference, number> =>
                requireDirectory(reference, symlinkStatus).pipe(
                  Effect.flatMap(() => parentOf(reference, operation.code))
                )

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
              ): Effect.Effect<ResultPart, XdrEncodeError> => {
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
                          if (error instanceof InvalidNameError) return Effect.fail(nameStatus(error, operation.code))
                          throw error
                        }
                      }

                      return Effect.fail(Status.ROFS)
                    })
                  )
                )

                return statusResult(checks)
              }

              const validName = (name: Uint8Array): Effect.Effect<void, number> =>
                Effect.try({
                  try: () => {
                    validateName(name, options.limits.maxNameBytes)
                  },
                  catch: (error) =>
                    error instanceof InvalidNameError ? nameStatus(error, operation.code) : Status.SERVERFAULT
                })

              const writeChangeInfo = (change: Vfs.DirectoryChange): WriteField => (writer) =>
                Effect.gen(function*() {
                  yield* writer.write(XdrCodec.boolean, true)
                  yield* writer.write(XdrCodec.uint64, BigInt.asUintN(64, change.before))
                  yield* writer.write(XdrCodec.uint64, BigInt.asUintN(64, change.after))
                })

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
                      let revokeConfirmed = false

                      if (confirmedRecord !== undefined && confirmedRecord.principal !== principal) {
                        // Case 3: owner collision with another principal. Live state protects the
                        // confirmed record; otherwise it is replaced outright.
                        const hasState = [...sessions.values()].some((session) => session.client === confirmedRecord) ||
                          [...opens.values()].some((open) => open.client === confirmedRecord)

                        if (hasState && options.now() <= confirmedRecord.leaseExpiresAt) {
                          return { code: operation.code, status: Status.CLID_INUSE } satisfies ResultPart
                        }

                        revokeConfirmed = true
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

                      const created: ClientState = {
                        id: clientSerial,
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

                      // A failed response encode must not consume a client ID, replace an owner,
                      // or revoke a confirmed record the caller cannot identify afterward.
                      const response = yield* exchangeIdResult(created)

                      if (revokeConfirmed && confirmedRecord !== undefined) {
                        yield* revokeClient(confirmedRecord)
                        removeClientRecord(confirmedRecord)
                      }

                      if (unconfirmed !== undefined && !unconfirmed.confirmed) {
                        releaseCreateSessionReplay(unconfirmed)
                        clients.delete(unconfirmed.id)
                      }

                      clientSerial++
                      clients.set(created.id, created)
                      clientsByOwner.set(owner, created)

                      return response
                    })
                  }

                  return exchangeIdResult(client)

                  function exchangeIdResult(client: ClientState): Effect.Effect<ResultPart, XdrEncodeError> {
                    const flags = EXCHGID4_FLAG_USE_NON_PNFS |
                      (client.confirmed ? EXCHGID4_FLAG_CONFIRMED_R : 0)

                    return Effect.map(
                      encodeStatusBody(options.limits, [
                        field(XdrCodec.uint64, client.id),
                        field(XdrCodec.uint32, client.sequence),
                        field(XdrCodec.uint32, flags >>> 0),
                        field(XdrCodec.uint32, 0),
                        field(XdrCodec.uint64, export_.fsid[0]),
                        field(XdrCodec.opaque(), options.generation),
                        field(XdrCodec.opaque(), options.generation),
                        field(XdrCodec.array(XdrCodec.uint32), [])
                      ]),
                      (body): ResultPart => ({ code: operation.code, status: Status.OK, body })
                    )
                  }
                }

                case "CreateSession": {
                  const value = operation.value
                  const client = clients.get(value.client)

                  if (client === undefined) {
                    return Effect.succeed({ code: operation.code, status: Status.STALE_CLIENTID })
                  }

                  const replay = client.createSessionReplay

                  if (replay?.sequence === value.sequence) {
                    // Section 18.36.4 phase 2: an equal csa_sequence identifies a retry, which may
                    // arrive with or without a preceding SEQUENCE; the cached result is returned
                    // before any argument validation.
                    //
                    // A retry usually arrives because the original reply was lost with the
                    // connection. The client then holds a session it believes is bound to the
                    // channels the cached reply names, so the replaying connection is associated
                    // with exactly those directions.
                    const replayed = replay.session === undefined ? undefined : sessions.get(bytesKey(replay.session))

                    if (replayed !== undefined && replay.directions !== undefined) {
                      associate(replayed, call.connection, replay.directions)
                    }

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
                  const complete = (
                    status: number,
                    body?: Uint8Array,
                    created?: { readonly session: Uint8Array; readonly directions: number }
                  ): ResultPart => {
                    const previousRetainedBytes = client.createSessionReplay?.retainedBytes ?? ByteSize.bytes(0)
                    const retainedBytes = byteLength(body?.length ?? 0)
                    replayBytes = subtractBytes(replayBytes, previousRetainedBytes)
                    replayBytes = addBytes(replayBytes, retainedBytes)
                    client.sequence = nextSequenceId(client.sequence)

                    let nextReplay: CreateSessionReplay = { sequence: value.sequence, status, retainedBytes }

                    if (created !== undefined) {
                      nextReplay = { ...nextReplay, session: created.session, directions: created.directions }
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

                    if ((value.flags & ~CREATE_SESSION4_KNOWN_FLAGS) !== 0) {
                      return complete(Status.INVAL)
                    }

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

                    // The server may use fewer slots than the client offered; it may not claim more.
                    const backSlots = Math.max(1, Math.min(value.back.maxRequests, options.limits.maxSlotsPerSession))

                    // Section 18.36.3: for the backchannel the server MUST NOT change
                    // ca_maxoperations or ca_maxrequests, so the client's attributes are echoed
                    // unchanged. The server's own slot table may still be smaller; that is an
                    // internal limit on how many callbacks it issues, not a renegotiation.
                    const back: ChannelAttrs = { ...value.back, headerPadding: 0, rdmaIrd: [] }

                    const agreedFlags = wantsBackChannel ? CREATE_SESSION4_FLAG_CONN_BACK_CHAN : 0

                    const body = yield* encodeStatusBody(options.limits, [
                      field(XdrCodec.fixedOpaque(16), id),
                      field(XdrCodec.uint32, value.sequence),
                      field(XdrCodec.uint32, agreedFlags),
                      (writer) => writeChannelAttrs(writer, fore),
                      (writer) => writeChannelAttrs(writer, back)
                    ])

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

                    // A backchannel the client asked for but sized so it can carry nothing is
                    // rejected rather than quietly rounded up: the server must not send callbacks
                    // on capacity the client never offered, and ca_maxrequests may not be changed
                    // for the backchannel. One operation is enough, because the only callback this
                    // server sends is a CB_SEQUENCE-only CB_COMPOUND.
                    if (wantsBackChannel && (value.back.maxRequests < 1 || value.back.maxOperations < 1)) {
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
                          probed: false,
                          arming: 0
                        }
                        : undefined
                    })
                    client.confirmed = true
                    client.leaseExpiresAt = options.now() + options.leaseDurationSeconds * 1000

                    return complete(Status.OK, body, {
                      session: id,
                      directions: CHANNEL_FORE | (wantsBackChannel ? CHANNEL_BACK : 0)
                    })
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

                  const replyBound = replayReplyBound(
                    parsed.operations,
                    parsed.tag.length,
                    options.limits,
                    options.securityFlavors?.length ?? 2
                  )

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

                  const uncachedReplayBound = 12 + parsed.tag.length + (4 - parsed.tag.length % 4) % 4 +
                    44 + (parsed.operations.length > 1 ? 8 : 0)

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
                    caller: slot.caller,
                    retainedBytes: slot.retainedBytes
                  }

                  rollbackSequence = () => {
                    // Restore only this slot's accounting; other operations in the compound may have
                    // changed the shared counter legitimately.
                    replayBytes = subtractBytes(replayBytes, slot.retainedBytes ?? ByteSize.bytes(0))
                    replayBytes = addBytes(replayBytes, previousSlot.retainedBytes ?? ByteSize.bytes(0))
                    slot.sequence = previousSlot.sequence

                    if (previousSlot.response === undefined) delete slot.response
                    else slot.response = previousSlot.response

                    if (previousSlot.request === undefined) delete slot.request
                    else slot.request = previousSlot.request

                    if (previousSlot.credentials === undefined) delete slot.credentials
                    else slot.credentials = previousSlot.credentials

                    if (previousSlot.caller === undefined) delete slot.caller
                    else slot.caller = previousSlot.caller

                    if (previousSlot.retainedBytes === undefined) delete slot.retainedBytes
                    else slot.retainedBytes = previousSlot.retainedBytes
                  }

                  replayBytes = subtractBytes(replayBytes, slot.retainedBytes ?? ByteSize.bytes(0))
                  replayBytes = addBytes(replayBytes, retainedBound)
                  slot.sequence = value.sequence
                  delete slot.response
                  delete slot.request
                  delete slot.credentials
                  delete slot.caller
                  slot.retainedBytes = retainedBound
                  session.client.leaseExpiresAt = options.now() + options.leaseDurationSeconds * 1000
                  activeSession = session
                  activeSlot = slot
                  shouldCache = value.cache

                  // Section 18.46.3: report a backchannel the server cannot use, so the client can
                  // repair it with BIND_CONN_TO_SESSION or BACKCHANNEL_CTL.
                  const statusFlags = session.back !== undefined && !session.back.healthy
                    ? SEQ4_STATUS_CB_PATH_DOWN_SESSION
                    : 0

                  return Effect.flatMap(
                    encodeStatusBody(options.limits, [
                      field(XdrCodec.fixedOpaque(16), session.id),
                      field(XdrCodec.uint32, value.sequence),
                      field(XdrCodec.uint32, value.slot),
                      field(XdrCodec.uint32, session.slots.length - 1),
                      field(XdrCodec.uint32, session.slots.length - 1),
                      field(XdrCodec.uint32, statusFlags)
                    ]),
                    (body) => {
                      // Probe only after the SEQUENCE reply body has encoded successfully.
                      const back = session.back

                      if (back === undefined || back.probed) {
                        return Effect.succeed({ code: operation.code, status: Status.OK, body })
                      }

                      back.probed = true

                      return Effect.forkIn(probe(session), handlerScope).pipe(
                        Effect.as({ code: operation.code, status: Status.OK, body })
                      )
                    }
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
                  // has one to bind. The section does not name an error for that case; INVAL is
                  // chosen because it is the error it uses for a channel change it cannot make, and
                  // Section 15.2 lists it for this operation.
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

                  // Section 18.34.4: a client whose backchannel lost its connections binds a new
                  // one. Clearing `probed` is what makes the next SEQUENCE actually retry the
                  // path; without it a recovered client stays marked down forever.
                  if ((bound & CHANNEL_BACK) !== 0 && session.back !== undefined) {
                    session.back.probed = false
                    session.back.arming++
                  }

                  const answered = bound === CHANNEL_BACK
                    ? CDFS4_BACK
                    : bound === CHANNEL_FORE
                    ? CDFS4_FORE
                    : CDFS4_BOTH

                  return Effect.map(
                    encodeStatusBody(options.limits, [
                      field(XdrCodec.fixedOpaque(16), session.id),
                      field(XdrCodec.uint32, answered),
                      field(XdrCodec.boolean, false)
                    ]),
                    (body): ResultPart => ({ code: operation.code, status: Status.OK, body })
                  )
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

                  // Section 18.33.3 replaces the backchannel's callback program, so it needs a
                  // backchannel to act on. It names no error for a session without one; INVAL is
                  // chosen because Section 15.2 lists it for this operation.
                  if (activeSession.back === undefined) {
                    return Effect.succeed({ code: operation.code, status: Status.INVAL })
                  }

                  activeSession.back.program = operation.value.program

                  // Section 18.33.3 adds credentials rather than replacing them, but a re-offer is
                  // the client's current authorization, so a newly offered flavor is adopted.
                  const reoffered = chooseCallbackSecurity(operation.value.security)

                  if (reoffered !== undefined) activeSession.back.security = reoffered

                  // A re-advertised program is the client repairing its callback service. Clearing
                  // `probed` is what actually gives the new endpoint another chance: health alone
                  // would be a claim no callback has tested. A path with no encodable credential
                  // stays down, because nothing can be sent down it.
                  activeSession.back.probed = false
                  activeSession.back.arming++
                  activeSession.back.healthy = activeSession.back.security !== undefined

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
                          : error.reason === "Unavailable"
                          ? Status.SERVERFAULT
                          : Status.BADHANDLE
                      })
                    )
                  )
                case "Getfh":
                  if (current === undefined) return Effect.succeed(noCurrent())

                  return export_.handleFor(current).pipe(
                    Effect.mapError(() => Status.SERVERFAULT),
                    Effect.flatMap((handle) =>
                      Effect.map(
                        encodeBody(handle, XdrCodec.opaque()),
                        (body): ResultPart => ({ code: operation.code, status: Status.OK, body })
                      )
                    ),
                    Effect.catchIf(
                      (error): error is typeof Status.SERVERFAULT => Predicate.isNumber(error),
                      (status) => Effect.succeed({ code: operation.code, status })
                    )
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
                        Effect.andThen(
                          export_.lookup(reference, operation.value).pipe(
                            Effect.mapError((error) => nameStatus(error, operation.code))
                          )
                        )
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
                      export_.lookup(reference, operation.value).pipe(
                        Effect.mapError((error) => nameStatus(error, operation.code))
                      )
                    ),
                    () => {
                      setCurrent(undefined)

                      return xdr.encode(
                        options.securityFlavors ?? [AUTH_SYS, AUTH_NONE],
                        XdrCodec.array(XdrCodec.uint32),
                        options.limits,
                        ByteSize.toNumberUnsafe(options.limits.maxRecordBytes)
                      )
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

                      return xdr.encode(
                        options.securityFlavors ?? [AUTH_SYS, AUTH_NONE],
                        XdrCodec.array(XdrCodec.uint32),
                        options.limits,
                        ByteSize.toNumberUnsafe(options.limits.maxRecordBytes)
                      )
                    }
                  )
                case "Getattr": {
                  if (current === undefined) {
                    return Effect.succeed(noCurrent())
                  }

                  const reference = current
                  const requested = requestedAttributes(operation.value)

                  const supportedRequested = requested.filter((attribute) => supportedAttributes.includes(attribute))

                  const attributes = filehandleFor(reference, supportedRequested).pipe(
                    Effect.flatMap((filehandle) =>
                      mapFs(export_.observeMetadata(reference)).pipe(
                        Effect.flatMap((observation) =>
                          mapFs(sampleUsage(supportedRequested)).pipe(
                            Effect.flatMap((usage) =>
                              requireAttributes(
                                encodeAttributes(
                                  supportedRequested,
                                  observation,
                                  filehandle,
                                  export_,
                                  options,
                                  supportedAttributes,
                                  usage
                                )
                              )
                            )
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
                          mapFs(sampleUsage(requested)).pipe(
                            Effect.flatMap((usage) =>
                              requireAttributes(
                                encodeAttributeValues(
                                  requested,
                                  observation,
                                  filehandle,
                                  export_,
                                  options,
                                  supportedAttributes,
                                  usage
                                )
                              )
                            )
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
                  const reference = current

                  return statusResult(
                    Effect.gen(function*() {
                      const observation = yield* mapFs(export_.observeMetadata(reference))
                      const supported = requested & supportedAccessMask(observation.value.kind)

                      let granted = activeCaller === undefined
                        ? grantedAccess(supported, observation.value, call.credentials)
                        : 0

                      if (activeCaller !== undefined) {
                        const writeFlags = observation.value.kind === "directory"
                          ? [ACCESS4_MODIFY, ACCESS4_EXTEND, ACCESS4_DELETE]
                          : [ACCESS4_MODIFY, ACCESS4_EXTEND]

                        const writeBits = observation.value.kind === "directory" ? 0o3 : 0o2

                        for (
                          const [flag, bit] of [
                            [ACCESS4_READ, 0o4],
                            [observation.value.kind === "directory" ? ACCESS4_LOOKUP : ACCESS4_EXECUTE, 0o1],
                            ...(options.writable ? writeFlags.map((flag) => [flag, writeBits] as const) : [])
                          ] as const
                        ) {
                          if ((supported & flag) === 0) continue

                          const allowed = yield* export_.access(reference, bit).pipe(
                            Effect.map((granted) => granted === bit),
                            Effect.mapError((error) => failureForFs(error, operation.code))
                          )

                          if (allowed) granted |= flag
                        }
                      }

                      return { supported, granted }
                    }),
                    ({ supported, granted }) =>
                      encodeStatusBody(options.limits, [
                        field(XdrCodec.uint32, supported),
                        field(XdrCodec.uint32, granted)
                      ])
                  )
                }

                case "Commit": {
                  if (current === undefined) return Effect.succeed(noCurrent())

                  // Every writable mutation is committed before publication. There is no unstable
                  // range to flush, but a failed provider must not produce a success reply.
                  return statusResult(
                    requireRegularFile(current),
                    () =>
                      xdr.encode(
                        writeVerifier,
                        XdrCodec.fixedOpaque(8),
                        options.limits,
                        ByteSize.toNumberUnsafe(options.limits.maxRecordBytes)
                      )
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
                    (target) =>
                      xdr.encode(
                        target,
                        XdrCodec.opaque(),
                        options.limits,
                        ByteSize.toNumberUnsafe(options.limits.maxRecordBytes)
                      )
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

                        const usage = yield* mapFs(sampleUsage(supportedRequested))

                        const verifier = makeCookieVerifier(storageGeneration, observation.revision)

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

                        const paddedTagBytes = parsed.tag.length + (4 - parsed.tag.length % 4) % 4

                        const envelopeBytes = 44 + paddedTagBytes +
                          parts.reduce((bytes, part) => bytes + 8 + (part.body?.length ?? 0), 0)

                        const responseLimit = Math.min(
                          value.maxcount,
                          ByteSize.toNumberUnsafe(options.limits.maxReaddirReplyBytes),
                          Math.max(0, ByteSize.toNumberUnsafe(maxRpcResponseBytes) - envelopeBytes),
                          Math.max(0, (activeSession?.fore.maxResponse ?? Number.MAX_SAFE_INTEGER) - envelopeBytes),
                          shouldCache
                            ? Math.max(
                              0,
                              (activeSession?.fore.maxCachedResponse ?? Number.MAX_SAFE_INTEGER) - envelopeBytes
                            )
                            : Number.MAX_SAFE_INTEGER
                        )

                        if (responseLimit < 16) {
                          return { code: operation.code, status: Status.TOOSMALL } satisfies ResultPart
                        }

                        const writer = yield* xdr.openWriter(
                          options.limits,
                          ByteSize.toNumberUnsafe(options.limits.maxRecordBytes)
                        )

                        yield* writer.write(XdrCodec.fixedOpaque(8), verifier)
                        let count = 0
                        let directoryBytes = 0

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
                            ? yield* encodeStatusBody(options.limits, [
                              field(XdrCodec.uint32, 0),
                              field(XdrCodec.uint32, 0)
                            ])
                            : yield* filehandleFor(entry.reference, supportedRequested).pipe(
                              Effect.flatMap((handle) =>
                                mapFs(export_.observeMetadata(entry.reference)).pipe(
                                  Effect.flatMap((metadata) =>
                                    requireAttributes(
                                      encodeAttributes(
                                        supportedRequested,
                                        metadata,
                                        handle,
                                        export_,
                                        options,
                                        supportedAttributes,
                                        usage
                                      )
                                    )
                                  )
                                )
                              ),
                              // With rdattr_error requested, a failing entry reports its own error.
                              Effect.catch((error): Effect.Effect<Uint8Array, number | XdrEncodeError> => {
                                if (error instanceof XdrEncodeError) return Effect.fail(error)

                                if (supportedRequested.includes(11)) return encodeReaddirError(error, options.limits)

                                return Effect.fail(error)
                              })
                            )

                          const encoded = yield* encodeStatusBody(options.limits, [
                            field(XdrCodec.boolean, true),
                            field(XdrCodec.uint64, BigInt(item + 3)),
                            field(XdrCodec.opaque(), entry.name),
                            (itemWriter) => itemWriter.appendEncoded(attrs)
                          ])

                          const entryDirectoryBytes = 12 + entry.name.length + (4 - entry.name.length % 4) % 4

                          if (
                            (value.dircount !== 0 && directoryBytes + entryDirectoryBytes > value.dircount) ||
                            (yield* writer.length) + encoded.length + 8 > responseLimit
                          ) {
                            if (count === 0) {
                              return { code: operation.code, status: Status.TOOSMALL } satisfies ResultPart
                            }

                            break
                          }

                          yield* writer.appendEncoded(encoded)
                          directoryBytes += entryDirectoryBytes
                          count += 1
                        }

                        yield* writer.write(XdrCodec.boolean, false)
                        yield* writer.write(XdrCodec.boolean, start + count >= observation.value.length)

                        return {
                          code: operation.code,
                          status: Status.OK,
                          body: yield* writer.finish
                        } satisfies ResultPart
                      })
                    ),
                    Effect.catchIf(Predicate.isNumber, (status) => Effect.succeed({ code: operation.code, status }))
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

                    if (!options.writable) return rejectMutation([value.name], "none", Status.SYMLINK)

                    return Effect.uninterruptibleMask((restore) =>
                      Effect.gen(function*() {
                        yield* restore(requireDirectory(directory, Status.SYMLINK))
                        const create = value.create!

                        const found = yield* restore(
                          export_.lookup(directory, value.name).pipe(
                            Effect.catch((error) =>
                              error instanceof InvalidNameError || error.code !== "NotFound"
                                ? Effect.fail(nameStatus(error, operation.code)) :
                                Effect.void
                            )
                          )
                        )

                        const observed = found === undefined
                          ? undefined
                          : yield* restore(mapFs(export_.observeMetadata(found)))

                        if (observed !== undefined && create.mode === 1) return yield* Effect.fail(Status.EXIST)

                        // Existing-file creates ignore initial values; the attribute mask and
                        // XDR structure still obey the selected create mode's restrictions.
                        const attrs = yield* creationAttributes(create, options.limits, observed !== undefined).pipe(
                          Effect.mapError((error) => error instanceof XdrDecodeError ? Status.BADXDR : error)
                        )

                        if (observed !== undefined) {
                          if (create.mode >= 2) {
                            const times = attrs.settings.times

                            if (
                              observed.value.kind !== "file" || times.access.kind !== "value" ||
                              times.modification.kind !== "value" ||
                              observed.value.atimeNs !== times.access.nanoseconds ||
                              observed.value.mtimeNs !== times.modification.nanoseconds
                            ) return yield* Effect.fail(Status.EXIST)
                          }

                          if (observed.value.kind !== "file") {
                            return yield* Effect.fail(observed.value.kind === "symlink" ? Status.SYMLINK : Status.ISDIR)
                          }
                        }

                        const owner = bytesKey(value.owner)

                        const existing = found === undefined ?
                          undefined :
                          [...opens.values()].find((open) =>
                            open.client === activeSession!.client && open.owner === owner && open.reference === found
                          )

                        if (
                          found !== undefined && [...opens.values()].some((open) =>
                            open.reference === found &&
                            ((open.deny & accessMode) !== 0 || (value.deny & open.access) !== 0)
                          )
                        ) {
                          return yield* Effect.fail(Status.SHARE_DENIED)
                        }

                        if (existing === undefined && opens.size >= options.limits.maxOpens) {
                          return yield* Effect.fail(Status.DELAY)
                        }

                        const truncate = create.mode === 0 && attrs.settings.initialSize === 0n &&
                          observed !== undefined

                        if (truncate && !wantsWrite) return yield* Effect.fail(Status.INVAL)

                        const opened = yield* restore(
                          export_.openChild(directory, value.name, {
                            ...attrs.settings,
                            access: accessMode === 3 ? "readWrite" : wantsWrite ? "write" : "read",
                            create: found === undefined ? "exclusive" : "ifMissing",
                            followFinalSymlink: false,
                            truncate,
                            expectedChild: found === undefined ? null : {
                              reference: found,
                              revision: observed!.revision,
                              atimeNs: observed!.value.atimeNs,
                              mtimeNs: observed!.value.mtimeNs
                            }
                          }).pipe(Effect.mapError((error) => {
                            if (error instanceof ExportCapacityError) return Status.DELAY

                            if (error instanceof InvalidNameError) return nameStatus(error, operation.code)

                            if (error.code === "StaleReference") return Status.DELAY

                            return failureForFs(error, operation.code)
                          }))
                        )

                        let id: Uint8Array

                        if (existing === undefined) {
                          id = makeStateId(options.generation, openSerial++, 1)
                          opens.set(stateIdKey(id), {
                            id,
                            sequence: 1,
                            access: accessMode,
                            deny: value.deny,
                            owner,
                            client: activeSession!.client,
                            reference: opened.reference,
                            readFile: accessMode & OPEN4_SHARE_ACCESS_READ ? opened.handle : undefined,
                            writeFile: wantsWrite ? opened.handle : undefined,
                            close: opened.close
                          })
                        } else {
                          const needsRead = (accessMode & OPEN4_SHARE_ACCESS_READ) !== 0 &&
                            existing.readFile === undefined

                          const needsWrite = wantsWrite && existing.writeFile === undefined

                          if (needsRead || needsWrite) {
                            if (needsRead) existing.readFile = opened.handle

                            if (needsWrite) existing.writeFile = opened.handle
                            existing.close = opened.close.pipe(Effect.andThen(existing.close))
                          } else yield* opened.close
                          existing.access |= accessMode
                          existing.deny |= value.deny
                          advanceStateId(existing)
                          id = existing.id
                        }

                        current = opened.reference
                        const applied = opened.created ? attrs.attributes : truncate ? [4] : []

                        return yield* openResult(
                          id,
                          opened.directory.before,
                          true,
                          opened.directory.after,
                          create.mode >= 2 ? [...applied, 47, 53] : applied
                        )
                      })
                    ).pipe(
                      Effect.catchIf(Predicate.isNumber, (status) => Effect.succeed({ code: operation.code, status }))
                    )
                  }

                  const target = value.claim === 4
                    ? Effect.succeed({ revision: 0n, reference: directory })
                    : requireDirectory(directory, Status.SYMLINK).pipe(
                      Effect.andThen(mapFs(export_.observeMetadata(directory))),
                      Effect.flatMap((directoryObservation) =>
                        export_.lookup(directory, value.name).pipe(
                          Effect.mapError((error) => nameStatus(error, operation.code)),
                          Effect.map((reference) => ({ revision: directoryObservation.revision, reference }))
                        )
                      )
                    )

                  return target.pipe(
                    Effect.tap(({ reference }) => requireRegularFile(reference)),
                    // Write access is refused only once the target is known to be a regular file.
                    Effect.tap(() => wantsWrite && !options.writable ? Effect.fail(Status.ROFS) : Effect.void),
                    Effect.flatMap(({ revision, reference }) =>
                      Effect.uninterruptibleMask((restore) =>
                        Effect.suspend(() => {
                          const owner = bytesKey(value.owner)

                          const existing = [...opens.values()].find((open) =>
                            open.client === activeSession!.client && open.owner === owner &&
                            open.reference === reference
                          )

                          // Section 9.7 checks every open, including this open-owner's own state.
                          const denied = [...opens.values()].some((open) =>
                            open.reference === reference &&
                            ((open.deny & accessMode) !== 0 || (value.deny & open.access) !== 0)
                          )

                          if (denied) {
                            return Effect.succeed(
                              { code: operation.code, status: Status.SHARE_DENIED } satisfies ResultPart
                            )
                          }

                          if (existing !== undefined) {
                            // The same open-owner upgrades its reservation (Section 9.7).
                            // Its mapped caller may have lost access since the earlier OPEN.
                            const nextAccess = existing.access | accessMode

                            const permission = activeCaller === undefined ?
                              Effect.void :
                              requireAccess(reference, (accessMode & 1 ? 0o4 : 0) | (accessMode & 2 ? 0o2 : 0))

                            const addedAccess = nextAccess & ~existing.access

                            const heldHandle = addedAccess === OPEN4_SHARE_ACCESS_READ
                              ? existing.readFile
                              : existing.writeFile

                            const replacement = addedAccess === 0 || heldHandle !== undefined ?
                              Effect.succeed(null) :
                              mapFs(export_.open(reference, addedAccess === OPEN4_SHARE_ACCESS_READ ? "read" : "write"))

                            let transferred = false

                            return restore(permission).pipe(
                              Effect.andThen(Effect.acquireUseRelease(
                                restore(replacement),
                                (opened) =>
                                  opened === null ? Effect.void : Effect.sync(() => {
                                    const previousClose = existing.close

                                    if (addedAccess === OPEN4_SHARE_ACCESS_READ) existing.readFile = opened.handle

                                    if (addedAccess === OPEN4_SHARE_ACCESS_WRITE) existing.writeFile = opened.handle

                                    existing.close = opened.close.pipe(Effect.andThen(previousClose))
                                    transferred = true
                                  }),
                                (opened) => opened === null || transferred ? Effect.void : opened.close
                              )),
                              Effect.flatMap(() => {
                                existing.access = nextAccess
                                existing.deny |= value.deny
                                advanceStateId(existing)
                                current = reference

                                return openResult(existing.id, revision, value.claim === 4)
                              })
                            )
                          }

                          if (opens.size >= options.limits.maxOpens) {
                            return Effect.succeed({ code: operation.code, status: Status.DELAY } satisfies ResultPart)
                          }

                          const serial = openSerial++

                          return restore(
                            mapFs(
                              export_.open(reference, accessMode === 3 ? "readWrite" : wantsWrite ? "write" : "read")
                            )
                          ).pipe(
                            Effect.flatMap((opened) => {
                              const id = makeStateId(options.generation, serial, 1)
                              opens.set(stateIdKey(id), {
                                id,
                                sequence: 1,
                                access: accessMode,
                                deny: value.deny,
                                owner,
                                client: activeSession!.client,
                                reference,
                                readFile: (accessMode & OPEN4_SHARE_ACCESS_READ) !== 0 ? opened.handle : undefined,
                                writeFile: wantsWrite ? opened.handle : undefined,
                                close: opened.close
                              })
                              current = reference

                              return openResult(id, revision, value.claim === 4)
                            })
                          )
                        })
                      )
                    ),
                    Effect.catchIf(Predicate.isNumber, (status) => Effect.succeed({ code: operation.code, status }))
                  )

                  function openResult(
                    id: Uint8Array,
                    revision: bigint,
                    atomic: boolean,
                    after = revision,
                    attributes: ReadonlyArray<number> = []
                  ): Effect.Effect<ResultPart, XdrEncodeError> {
                    const delegationFields: ReadonlyArray<WriteField> = delegationWant === 0
                      ? [field(XdrCodec.uint32, OPEN_DELEGATE_NONE)]
                      : [
                        field(XdrCodec.uint32, OPEN_DELEGATE_NONE_EXT),
                        field(
                          XdrCodec.uint32,
                          delegationWant === OPEN4_SHARE_ACCESS_WANT_NO_DELEG
                            ? WND4_NOT_WANTED
                            : delegationWant === OPEN4_SHARE_ACCESS_WANT_CANCEL
                            ? WND4_CANCELLED
                            : WND4_NOT_SUPP_FTYPE
                        )
                      ]

                    return Effect.map(
                      encodeStatusBody(options.limits, [
                        field(XdrCodec.fixedOpaque(16), id),
                        field(XdrCodec.boolean, atomic),
                        field(XdrCodec.uint64, BigInt.asUintN(64, revision)),
                        field(XdrCodec.uint64, BigInt.asUintN(64, after)),
                        field(XdrCodec.uint32, 0),
                        (writer) => writeBitmap(writer, wordsFor(attributes)),
                        ...delegationFields
                      ]),
                      (body): ResultPart => {
                        currentStateid = id

                        return { code: operation.code, status: Status.OK, body }
                      }
                    )
                  }
                }

                case "Read": {
                  // RFC 8881 Section 18.22.3 lets the server return fewer bytes than requested.
                  const value = {
                    ...operation.value,
                    count: Math.min(operation.value.count, ByteSize.toNumberUnsafe(options.limits.maxReadBytes))
                  }

                  if (current === undefined) return Effect.succeed(noCurrent())

                  const readPermission = activeCaller === undefined
                    ? Effect.void
                    : requireAccess(current, 0o4)

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
                      Effect.andThen(readPermission),
                      Effect.andThen(
                        Effect.acquireUseRelease(
                          mapFs(export_.open(reference)),
                          (opened) => readFrom(opened.handle),
                          (opened) => opened.close
                        )
                      ),
                      Effect.catchIf(Predicate.isNumber, (status) => Effect.succeed({ code: operation.code, status }))
                    )
                  }

                  const effectiveStateid = isCurrentStateId(value.stateid) ? currentStateid : value.stateid

                  if (effectiveStateid === undefined) {
                    return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                  }

                  const stateKey = stateIdKey(effectiveStateid)
                  const lock = lockStates.get(stateKey)
                  const open = opens.get(stateKey) ?? lock?.open

                  if (open === undefined) return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                  const suppliedSequence = stateIdSequence(effectiveStateid)
                  const stateSequence = lock?.sequence ?? open.sequence

                  if (suppliedSequence !== 0 && suppliedSequence < stateSequence) {
                    return Effect.succeed({ code: operation.code, status: Status.OLD_STATEID })
                  }

                  if (suppliedSequence > stateSequence) {
                    return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                  }

                  if (
                    activeSession === undefined || current === undefined || open.client !== activeSession.client ||
                    open.reference !== current
                  ) {
                    return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                  }

                  if ((open.access & OPEN4_SHARE_ACCESS_READ) === 0) {
                    return Effect.succeed({ code: operation.code, status: Status.OPENMODE })
                  }

                  if (open.readFile === undefined) {
                    return Effect.succeed({ code: operation.code, status: Status.SERVERFAULT })
                  }

                  return readPermission.pipe(
                    Effect.andThen(readFrom(open.readFile)),
                    Effect.catchIf(Predicate.isNumber, (status) => Effect.succeed({ code: operation.code, status }))
                  )

                  function readFrom(file: Vfs.FileHandle): Effect.Effect<ResultPart, XdrEncodeError> {
                    return file.pread(value.count, value.offset).pipe(
                      Effect.flatMap(({ bytes: data, eof }) =>
                        Effect.map(
                          encodeStatusBody(options.limits, [
                            field(XdrCodec.boolean, eof),
                            field(XdrCodec.opaque(), data)
                          ]),
                          (body): ResultPart => ({ code: operation.code, status: Status.OK, body })
                        )
                      ),
                      Effect.catchTag("VfsError", (error) =>
                        Effect.succeed({ code: operation.code, status: failureForFs(error, operation.code) }))
                    )
                  }
                }

                case "OpenDowngrade": {
                  if (current === undefined) {
                    return Effect.succeed(noCurrent())
                  }

                  const value = operation.value
                  // Section 16.2.3: the special current stateid refers to a preceding OPEN.
                  const stateid = isCurrentStateId(value.stateid) ? currentStateid : value.stateid

                  if (stateid === undefined) {
                    // The special stateid has no earlier OPEN result to refer to.
                    return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                  }

                  const open = opens.get(stateIdKey(stateid))

                  if (open === undefined) {
                    return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                  }

                  const stateidStatus = checkOpenStateId(stateid, open)

                  if (stateidStatus !== Status.OK) {
                    return Effect.succeed({ code: operation.code, status: stateidStatus })
                  }

                  // Section 18.18.3: delegation want bits are masked off, and the new modes must be
                  // non-empty subsets of what is held.
                  const access = value.access & ~OPEN4_SHARE_ACCESS_WANT_DELEG_MASK

                  if (access === 0 || (access & ~open.access) !== 0 || (value.deny & ~open.deny) !== 0) {
                    return Effect.succeed({ code: operation.code, status: Status.INVAL })
                  }

                  open.access = access
                  open.deny = value.deny
                  advanceStateId(open)
                  currentStateid = open.id

                  return Effect.map(
                    xdr.encode(
                      open.id,
                      XdrCodec.fixedOpaque(16),
                      options.limits,
                      ByteSize.toNumberUnsafe(options.limits.maxRecordBytes)
                    ),
                    (body): ResultPart => ({ code: operation.code, status: Status.OK, body })
                  )
                }

                case "FreeStateid": {
                  if (activeSession === undefined) {
                    return Effect.succeed({ code: operation.code, status: Status.BADSESSION })
                  }

                  const open = isSpecialStateId(operation.value) ? undefined : opens.get(stateIdKey(operation.value))

                  if (open === undefined && !isSpecialStateId(operation.value)) {
                    const key = stateIdKey(operation.value)
                    const lock = lockStates.get(key)

                    if (lock !== undefined && lock.client === activeSession.client) {
                      const status = checkStateIdSequence(operation.value, lock)

                      if (status !== Status.OK) {
                        // A stale stateid cannot release the lock owner's state.
                        return Effect.succeed({ code: operation.code, status })
                      }

                      if (lock.ranges.length !== 0) {
                        return Effect.succeed({ code: operation.code, status: Status.LOCKS_HELD })
                      }

                      lockStates.delete(key)

                      return Effect.succeed({ code: operation.code, status: Status.OK })
                    }
                  }

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
                    if (isSpecialStateId(stateid)) {
                      return Status.BAD_STATEID
                    }

                    const open = opens.get(stateIdKey(stateid))

                    if (open === undefined) {
                      const lock = lockStates.get(stateIdKey(stateid))

                      return lock === undefined || lock.client !== session.client
                        ? Status.BAD_STATEID
                        : checkStateIdSequence(stateid, lock)
                    }

                    if (open.client !== session.client) {
                      // TEST_STATEID cannot expose another client's open state.
                      return Status.BAD_STATEID
                    }

                    return checkStateIdSequence(stateid, open)
                  })

                  return Effect.map(
                    xdr.encode(
                      results,
                      XdrCodec.array(XdrCodec.uint32),
                      options.limits,
                      ByteSize.toNumberUnsafe(options.limits.maxRecordBytes)
                    ),
                    (body): ResultPart => ({ code: operation.code, status: Status.OK, body })
                  )
                }

                case "SetSsv":
                  // State protection is always SP4_NONE (RFC 8881 Section 18.47.3).
                  return Effect.succeed({ code: operation.code, status: Status.INVAL })
                case "Lock": {
                  if (current === undefined) {
                    return Effect.succeed(noCurrent())
                  }

                  const value = operation.value
                  const range = lockRange(value.offset, value.length)

                  return requireRegularFile(current).pipe(
                    Effect.andThen(Effect.gen(function*() {
                      if (range === undefined) {
                        return { code: operation.code, status: Status.INVAL }
                      }

                      if (value.reclaim) {
                        return { code: operation.code, status: Status.NO_GRACE }
                      }

                      if (WRITE_LOCK_TYPES.has(value.lockType) && !options.writable) {
                        return { code: operation.code, status: Status.ROFS }
                      }

                      if (activeSession === undefined) {
                        return { code: operation.code, status: Status.BADSESSION }
                      }

                      const client = activeSession.client
                      const locker = value.locker
                      let lock: LockState | undefined
                      let created = false

                      if (locker.kind === "new") {
                        const stateid = isCurrentStateId(locker.stateid) ? currentStateid : locker.stateid

                        if (stateid === undefined) {
                          return { code: operation.code, status: Status.BAD_STATEID }
                        }

                        const open = opens.get(stateIdKey(stateid))

                        if (open === undefined) {
                          return { code: operation.code, status: Status.BAD_STATEID }
                        }

                        const status = checkOpenStateId(stateid, open)

                        if (status !== Status.OK) {
                          return { code: operation.code, status }
                        }

                        if ((open.access & (WRITE_LOCK_TYPES.has(value.lockType) ? 2 : 1)) === 0) {
                          return { code: operation.code, status: Status.OPENMODE }
                        }

                        const ownerKey = bytesKey(locker.owner)
                        lock = [...lockStates.values()].find((entry) =>
                          entry.client === client && entry.ownerKey === ownerKey && entry.open === open
                        )

                        if (lock === undefined) {
                          if (lockStates.size >= options.limits.maxLockOwners) {
                            return { code: operation.code, status: Status.DELAY }
                          }

                          const id = makeStateId(options.generation, openSerial++, 0)

                          lock = {
                            id,
                            sequence: 0,
                            client: activeSession.client,
                            owner: locker.owner,
                            ownerKey,
                            open,
                            ranges: []
                          }
                          created = true
                        }
                      } else {
                        const stateid = isCurrentStateId(locker.stateid) ? currentStateid : locker.stateid

                        if (stateid === undefined) {
                          return { code: operation.code, status: Status.BAD_STATEID }
                        }

                        lock = lockStates.get(stateIdKey(stateid))

                        if (lock === undefined) {
                          return { code: operation.code, status: Status.BAD_STATEID }
                        }

                        const status = checkLockStateId(stateid, lock)

                        if (status !== Status.OK) {
                          return { code: operation.code, status }
                        }

                        if ((lock.open.access & (WRITE_LOCK_TYPES.has(value.lockType) ? 2 : 1)) === 0) {
                          return { code: operation.code, status: Status.OPENMODE }
                        }
                      }

                      const conflict = conflictingLock(
                        lock.open.reference,
                        lock.client,
                        lock.ownerKey,
                        range,
                        value.lockType
                      )

                      if (conflict !== undefined) {
                        return yield* deniedLock(operation.code, conflict)
                      }

                      const ownerStates = [...lockStates.values()].filter((state) =>
                        state.client === lock.client && state.ownerKey === lock.ownerKey &&
                        state.open.reference === lock.open.reference
                      )

                      if (created) {
                        ownerStates.push(lock)
                      }

                      const updates = ownerStates.map((state) => ({
                        state,
                        next: replaceLockRange(
                          state.ranges,
                          range,
                          state === lock ? (WRITE_LOCK_TYPES.has(value.lockType) ? 2 : 1) : undefined
                        )
                      }))

                      const nextCount = updates.reduce(
                        (count, update) =>
                          count + update.next.length - update.state.ranges.length,
                        lockCount
                      )

                      if (nextCount > options.limits.maxLocks) {
                        return { code: operation.code, status: Status.DELAY }
                      }

                      if (created) lockStates.set(stateIdKey(lock.id), lock)

                      const ownNext = updates.find((update) => update.state === lock)!.next

                      const changed = lock.ranges.length !== ownNext.length ||
                        lock.ranges.some((entry, index) =>
                          entry.range.offset !== ownNext[index]!.range.offset ||
                          entry.range.end !== ownNext[index]!.range.end ||
                          entry.type !== ownNext[index]!.type
                        )

                      lockCount = nextCount

                      for (const update of updates) {
                        update.state.ranges.splice(0, update.state.ranges.length, ...update.next)
                      }

                      if (changed) advanceStateId(lock)
                      currentStateid = lock.id

                      const body = yield* xdr.encode(
                        lock.id,
                        XdrCodec.fixedOpaque(16),
                        options.limits,
                        ByteSize.toNumberUnsafe(options.limits.maxRecordBytes)
                      )

                      return { code: operation.code, status: Status.OK, body }
                    })),
                    Effect.catchIf(Predicate.isNumber, (status) => Effect.succeed({ code: operation.code, status }))
                  )
                }

                case "Lockt": {
                  if (current === undefined) return Effect.succeed(noCurrent())
                  const reference = current
                  const value = operation.value
                  const range = lockRange(value.offset, value.length)

                  return requireRegularFile(reference).pipe(
                    Effect.flatMap(() =>
                      Effect.gen(function*() {
                        if (range === undefined) return { code: operation.code, status: Status.INVAL }

                        if (WRITE_LOCK_TYPES.has(value.lockType) && !options.writable) {
                          return { code: operation.code, status: Status.ROFS }
                        }

                        if (activeSession === undefined) return { code: operation.code, status: Status.BADSESSION }

                        const conflict = conflictingLock(
                          reference,
                          activeSession.client,
                          bytesKey(value.owner),
                          range,
                          value.lockType
                        )

                        return conflict === undefined
                          ? { code: operation.code, status: Status.OK }
                          : yield* deniedLock(operation.code, conflict)
                      })
                    ),
                    Effect.catchIf(Predicate.isNumber, (status) => Effect.succeed({ code: operation.code, status }))
                  )
                }

                case "Locku": {
                  if (current === undefined) return Effect.succeed(noCurrent())
                  const value = operation.value
                  const range = lockRange(value.offset, value.length)

                  if (range === undefined) return Effect.succeed({ code: operation.code, status: Status.INVAL })
                  const stateid = isCurrentStateId(value.stateid) ? currentStateid : value.stateid

                  if (stateid === undefined) return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                  const lock = lockStates.get(stateIdKey(stateid))

                  if (lock === undefined) return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                  const status = checkLockStateId(stateid, lock)

                  if (status !== Status.OK) return Effect.succeed({ code: operation.code, status })

                  const ownerStates = [...lockStates.values()].filter((state) =>
                    state.client === lock.client && state.ownerKey === lock.ownerKey &&
                    state.open.reference === lock.open.reference
                  )

                  if (!ownerStates.some((state) => state.ranges.some((entry) => overlaps(entry.range, range)))) {
                    return Effect.succeed({ code: operation.code, status: Status.LOCK_RANGE })
                  }

                  const updates = ownerStates.map((state) => ({ state, next: replaceLockRange(state.ranges, range) }))

                  const nextCount = updates.reduce(
                    (count, update) => count + update.next.length - update.state.ranges.length,
                    lockCount
                  )

                  if (nextCount > options.limits.maxLocks) {
                    return Effect.succeed({ code: operation.code, status: Status.DELAY })
                  }

                  lockCount = nextCount

                  for (const update of updates) {
                    update.state.ranges.splice(0, update.state.ranges.length, ...update.next)
                  }

                  advanceStateId(lock)
                  currentStateid = lock.id

                  return Effect.map(
                    xdr.encode(
                      lock.id,
                      XdrCodec.fixedOpaque(16),
                      options.limits,
                      ByteSize.toNumberUnsafe(options.limits.maxRecordBytes)
                    ),
                    (body): ResultPart => ({ code: operation.code, status: Status.OK, body })
                  )
                }

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

                  if (stateidStatus !== Status.OK) {
                    return Effect.succeed({ code: operation.code, status: stateidStatus })
                  }

                  if (
                    [...lockStates.values()].some((lock) => lock.open === open && lock.ranges.length > 0)
                  ) {
                    return Effect.succeed({ code: operation.code, status: Status.LOCKS_HELD })
                  }

                  const closedStateid = new Uint8Array(open.id)
                  new DataView(closedStateid.buffer).setUint32(0, open.sequence + 1)

                  // Closing the handle and dropping it from `opens` are one region. An interrupt
                  // delivered between them would leave a closed handle in the map for the handler
                  // scope's finalizer to close a second time.
                  return xdr.encode(
                    closedStateid,
                    XdrCodec.fixedOpaque(16),
                    options.limits,
                    ByteSize.toNumberUnsafe(options.limits.maxRecordBytes)
                  ).pipe(
                    Effect.flatMap((body) =>
                      Effect.uninterruptible(
                        open.close.pipe(
                          Effect.tap(() =>
                            Effect.sync(() => {
                              opens.delete(key)

                              for (const [lockKey, lock] of lockStates) {
                                if (lock.open === open) lockStates.delete(lockKey)
                              }

                              currentStateid = closedStateid
                            })
                          )
                        )
                      ).pipe(Effect.as({ code: operation.code, status: Status.OK, body }))
                    )
                  )
                }

                case "Write": {
                  if (current === undefined) return Effect.succeed(noCurrent())

                  if (!options.writable) return Effect.succeed({ code: operation.code, status: Status.ROFS })

                  const value = operation.value
                  const reference = current
                  const stateid = isCurrentStateId(value.stateid) ? currentStateid : value.stateid

                  if (value.stable > 2) return Effect.succeed({ code: operation.code, status: Status.INVAL })

                  if (stateid === undefined || isAllZero(stateid) || isAllOnes(stateid)) {
                    return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                  }

                  const key = stateIdKey(stateid)
                  const lock = lockStates.get(key)
                  const open = opens.get(key) ?? lock?.open

                  if (open === undefined) return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })

                  const stateStatus = lock === undefined
                    ? checkOpenStateId(stateid, open)
                    : checkLockStateId(stateid, lock)

                  if (stateStatus !== Status.OK) return Effect.succeed({ code: operation.code, status: stateStatus })

                  if ((open.access & OPEN4_SHARE_ACCESS_WRITE) === 0) {
                    return Effect.succeed({ code: operation.code, status: Status.OPENMODE })
                  }

                  if (open.writeFile === undefined) {
                    return Effect.succeed({ code: operation.code, status: Status.SERVERFAULT })
                  }

                  const writeFile = open.writeFile

                  return statusResult(
                    requireRegularFile(reference).pipe(
                      Effect.andThen(
                        activeCaller === undefined
                          ? Effect.void
                          : requireAccess(reference, 0o2)
                      ),
                      Effect.andThen(mapFs(writeFile.pwrite(value.data, value.offset)))
                    ),
                    (count) =>
                      encodeStatusBody(options.limits, [
                        field(XdrCodec.uint32, count),
                        field(XdrCodec.uint32, 2),
                        field(XdrCodec.fixedOpaque(8), writeVerifier)
                      ])
                  )
                }

                case "Setattr": {
                  if (current === undefined || !options.writable) {
                    return Effect.map(
                      xdr.encode(
                        [],
                        XdrCodec.array(XdrCodec.uint32),
                        options.limits,
                        ByteSize.toNumberUnsafe(options.limits.maxRecordBytes)
                      ),
                      (body): ResultPart => ({
                        code: operation.code,
                        status: current === undefined ? Status.NOFILEHANDLE : Status.ROFS,
                        body
                      })
                    )
                  }

                  const reference = current
                  const value = operation.value

                  return Effect.gen(function*() {
                    const reply = (
                      status: number,
                      attrsset: ReadonlyArray<number> = []
                    ): Effect.Effect<ResultPart, XdrEncodeError> =>
                      Effect.map(
                        encodeStatusBody(options.limits, [(writer) => writeBitmap(writer, wordsFor(attrsset))]),
                        (body): ResultPart => ({ code: operation.code, status, body })
                      )

                    const decoded = yield* setattrAttributes(value.attrs, options.limits, supportedAttributes).pipe(
                      Effect.mapError((error) => error instanceof XdrDecodeError ? Status.BADXDR : error),
                      Effect.map((changes) => ({ changes })),
                      Effect.catch((status) => Effect.succeed({ status }))
                    )

                    if ("status" in decoded) return yield* reply(decoded.status)

                    if (decoded.changes.some((change) => change.kind === "size")) {
                      const stateid = isCurrentStateId(value.stateid) ? currentStateid : value.stateid

                      if (stateid === undefined || isAllZero(stateid) || isAllOnes(stateid)) {
                        return yield* reply(Status.BAD_STATEID)
                      }

                      const key = stateIdKey(stateid)
                      const lock = lockStates.get(key)
                      const open = opens.get(key) ?? lock?.open

                      if (open === undefined || open.reference !== reference) return yield* reply(Status.BAD_STATEID)

                      const stateStatus = lock === undefined
                        ? checkOpenStateId(stateid, open)
                        : checkLockStateId(stateid, lock)

                      if (stateStatus !== Status.OK) return yield* reply(stateStatus)

                      if ((open.access & OPEN4_SHARE_ACCESS_WRITE) === 0) return yield* reply(Status.OPENMODE)

                      if (
                        [...opens.values()].some((state) =>
                          state.reference === reference && (state.deny & OPEN4_SHARE_ACCESS_WRITE) !== 0
                        )
                      ) return yield* reply(Status.SHARE_DENIED)
                    }

                    // RFC 8881 lets a failed SETATTR report some attributes or none; one setattr applies all
                    // of them or none, so attrsset is empty on failure and complete on success.
                    const status = yield* applySetattr(export_, reference, setattrOptions(decoded.changes)).pipe(
                      Effect.as(Status.OK),
                      Effect.catch((error) =>
                        Effect.succeed(error === Status.DELAY ? error : failureForFs(error, operation.code))
                      )
                    )

                    return yield* reply(
                      status,
                      status === Status.OK
                        ? decoded.changes.map((change) => change.attribute)
                        : []
                    )
                  })
                }

                // Section 15.2 lists NFS4ERR_SYMLINK for LINK but not for CREATE, REMOVE, or RENAME.
                case "Create": {
                  if (current === undefined) return Effect.succeed(noCurrent())

                  if (!options.writable) return rejectMutation([operation.value.name], "none", Status.NOTDIR)

                  const value = operation.value
                  const parent = current

                  return statusResult(
                    Effect.gen(function*() {
                      yield* requireDirectory(parent, Status.NOTDIR)
                      yield* validName(value.name)

                      if (value.kind !== 2 && value.kind !== 5) return yield* Effect.fail(Status.BADTYPE)

                      const attributes = attributesIn(value.attrs.bitmap)
                      const supported = value.kind === 2 ? [33, 48, 54] : [48, 54]

                      if (!attributes.every((attribute) => supported.includes(attribute))) {
                        return yield* Effect.fail(Status.ATTRNOTSUPP)
                      }

                      const reader = yield* xdr.openReader(value.attrs.values, options.limits)
                      let mode: number | undefined

                      const times: Types.Mutable<Vfs.Times> = {
                        access: { kind: "omit" },
                        modification: { kind: "omit" }
                      }

                      for (const attribute of attributes) {
                        if (attribute === 33) {
                          mode = yield* reader.read(XdrCodec.uint32)

                          if (mode > 0o7777) return yield* Effect.fail(Status.INVAL)
                        } else {
                          const how = yield* reader.read(XdrCodec.uint32)

                          const time: Vfs.Times["access"] = how === 0 ? { kind: "now" } : {
                            kind: "value",
                            nanoseconds: BigInt.asIntN(64, yield* reader.read(XdrCodec.uint64)) * 1_000_000_000n +
                              BigInt(yield* reader.read(XdrCodec.uint32))
                          }

                          if (attribute === 48) times.access = time
                          else times.modification = time
                        }
                      }

                      yield* reader.finish

                      const result = yield* (value.kind === 2
                        ? export_.mkdir(
                          parent,
                          value.name,
                          mode === undefined ? { times } : { mode, times, exactMode: true }
                        )
                        : export_.symlink(value.target!, parent, value.name, { times })).pipe(
                          Effect.mapError((error) =>
                            error instanceof ExportCapacityError ?
                              Status.DELAY :
                              error instanceof InvalidNameError
                              ? nameStatus(error, operation.code)
                              : failureForFs(error, operation.code)
                          )
                        )

                      setCurrent(result.reference)

                      return { change: result.directory, attributes }
                    }).pipe(Effect.mapError((error) => error instanceof XdrDecodeError ? Status.BADXDR : error)),
                    ({ change, attributes }) =>
                      encodeStatusBody(options.limits, [
                        writeChangeInfo(change),
                        (writer) => writeBitmap(writer, wordsFor(attributes))
                      ])
                  )
                }

                case "Remove": {
                  if (current === undefined) return Effect.succeed(noCurrent())

                  if (!options.writable) return rejectMutation([operation.value], "none", Status.NOTDIR)
                  const directory = current

                  return statusResult(
                    Effect.gen(function*() {
                      yield* requireDirectory(directory, Status.NOTDIR)
                      yield* validName(operation.value)

                      return yield* mapFs(export_.remove(directory, operation.value))
                    }),
                    (change) => encodeStatusBody(options.limits, [writeChangeInfo(change)])
                  )
                }

                case "Rename": {
                  if (current === undefined || saved === undefined) return Effect.succeed(noCurrent())

                  if (!options.writable) {
                    return rejectMutation(
                      [operation.value.oldName, operation.value.newName],
                      "directory",
                      Status.NOTDIR
                    )
                  }

                  const destination = current
                  const source = saved

                  return statusResult(
                    Effect.gen(function*() {
                      yield* requireDirectory(destination, Status.NOTDIR)
                      yield* requireDirectory(source, Status.NOTDIR)
                      yield* validName(operation.value.oldName)
                      yield* validName(operation.value.newName)

                      return yield* export_.rename(
                        source,
                        operation.value.oldName,
                        destination,
                        operation.value.newName
                      )
                        .pipe(
                          Effect.mapError((error) =>
                            error.code === "IsDirectory" || error.code === "NotDirectory" || error.code === "NotEmpty"
                              ? Status.EXIST
                              : failureForFs(error, operation.code)
                          )
                        )
                    }),
                    (change) => {
                      const sourceChange = Predicate.isTagged(change, "SameDirectory")
                        ? change.directory
                        : change.sourceDirectory

                      const destinationChange = Predicate.isTagged(change, "SameDirectory")
                        ? change.directory
                        : change.destinationDirectory

                      return encodeStatusBody(options.limits, [
                        writeChangeInfo(sourceChange),
                        writeChangeInfo(destinationChange)
                      ])
                    }
                  )
                }

                case "Link": {
                  if (current === undefined || saved === undefined) return Effect.succeed(noCurrent())

                  if (!options.writable) return rejectMutation([operation.value], "object", Status.SYMLINK)
                  const destination = current
                  const source = saved

                  return statusResult(
                    Effect.gen(function*() {
                      yield* requireDirectory(destination, Status.SYMLINK)
                      yield* validName(operation.value)

                      return yield* mapFs(export_.link(source, destination, operation.value))
                    }),
                    (result) => encodeStatusBody(options.limits, [writeChangeInfo(result.directory)])
                  )
                }

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

            function parentOf(
              reference: Vfs.ObjectReference,
              operation: number
            ): Effect.Effect<Vfs.ObjectReference, number> {
              // The root has no parent in this export (RFC 8881 Section 18.14.3).
              return export_.parent(reference).pipe(
                Effect.mapError((error) => failureForFs(error, operation)),
                Effect.filterOrFail((parent) => parent !== reference, () => Status.NOENT)
              )
            }

            function nameStatus(error: Vfs.VfsError | InvalidNameError, operation: number): number {
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

              return failureForFs(error, operation)
            }

            function isSpecialStateId(stateid: Uint8Array): boolean {
              return isAllZero(stateid) || isAllOnes(stateid) || isCurrentStateId(stateid)
            }

            function checkStateIdSequence(stateid: Uint8Array, open: OpenState | LockState): number {
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

            function checkLockStateId(stateid: Uint8Array, lock: LockState): number {
              const sequenceStatus = checkStateIdSequence(stateid, lock)

              if (sequenceStatus !== Status.OK) return sequenceStatus

              if (
                activeSession === undefined || current === undefined || lock.client !== activeSession.client ||
                lock.open.reference !== current
              ) {
                return Status.BAD_STATEID
              }

              return Status.OK
            }

            function advanceStateId(open: OpenState | LockState): void {
              open.sequence += 1
              open.id = makeStateId(
                options.generation,
                new DataView(open.id.buffer, open.id.byteOffset + 8, 8).getBigUint64(0),
                open.sequence
              )
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                if (!consumedSequence) rollbackSequence?.()
              })
            )
          )
        }
      )

    /**
     * Takes the next free backchannel slot. Section 2.10.6.1 requires slot state even for
     * callbacks, so a slot in flight is never reused for a second concurrent callback.
     */
    const takeCallbackSlot = (back: BackChannel): number | undefined => {
      const index = back.slots.findIndex((slot) => !slot.busy)

      if (index < 0) return undefined
      back.slots[index]!.busy = true

      return index
    }

    const probe = (session: SessionState): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        const back = session.back

        if (back === undefined) return false

        // The verdict is only published if the path has not been re-armed meanwhile, so a slow
        // probe cannot overwrite a newer one's result.
        const arming = back.arming
        const slot = takeCallbackSlot(back)

        if (slot === undefined) {
          // Every slot is in flight. This probe never ran, so it must not consume the arming:
          // otherwise a re-armed path would be left untested forever.
          back.probed = false

          return false
        }

        // Section 2.10.6.1.3: the slot's sequence ID advances only when the callback is
        // answered NFS4_OK. Advancing it on a timeout would leave the client expecting the
        // previous value and answering the next callback NFS4ERR_SEQ_MISORDERED forever.
        const sequence = nextSequenceId(back.slots[slot]!.sequence)

        // Section 20.9.3: csa_highest_slotid is the highest slot the server will use.
        // Section 18.46.3 has SEQUENCE report an unusable callback path. The slot is released
        // even if encoding the callback body fails before any bytes are sent.
        const accepted = yield* Effect.ensuring(
          Effect.gen(function*() {
            const encodedBody = yield* Effect.result(
              encodeCallbackSequence(session.id, sequence, slot, back.slots.length - 1, options.limits)
            )

            if (Result.isFailure(encodedBody)) return false

            return yield* callback(
              session,
              CB_COMPOUND_PROCEDURE,
              encodedBody.success,
              (reply) => callbackAccepted(reply, options.limits, session.id, slot, sequence)
            )
          }),
          Effect.sync(() => {
            back.slots[slot]!.busy = false
          })
        )

        // A re-arm while this probe was in flight means its verdict is about a path the client
        // has already replaced; the probe it triggered decides instead.
        if (back.arming !== arming) return accepted

        back.healthy = accepted

        if (accepted) back.slots[slot]!.sequence = sequence

        return accepted
      })

    return {
      compound: (call) =>
        stateGate.withPermit(
          // A mask rather than a blanket `uninterruptible`: the sweep and the replay-slot commit
          // stay atomic, while `executeCompound` reopens the window around each operation so a
          // compound stalled in the backing store cannot hold scope closure open indefinitely.
          Effect.gen(function*() {
            const activeCaller = options.callerFor === undefined ? undefined : yield* options.callerFor(call)

            if (activeCaller === null) return yield* new RpcPolicyDenied()

            const activeExport = activeCaller === undefined ? export_ : export_.withCaller(activeCaller)

            return yield* Effect.uninterruptibleMask((restore) =>
              sweepExpired.pipe(Effect.andThen(executeCompound(call, activeExport, activeCaller, restore)))
            )
          })
        ),
      callbackReply: (connection, message) =>
        Effect.sync(() => {
          if (message.length < 4) return
          const xid = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(0)
          const waiting = pendingCallbacks.get(xid)

          // The reply must arrive on the connection the callback went out on. Otherwise any peer
          // that guessed a live xid could answer another session's callback and make that
          // session's backchannel look healthy.
          if (waiting === undefined || waiting.carrier !== connection) return
          pendingCallbacks.delete(xid)
          Deferred.doneUnsafe(waiting.reply, Effect.succeed(message))
        }),
      probeBackChannel: (id) =>
        Effect.suspend(() => {
          const session = sessions.get(bytesKey(id))

          return session === undefined ? Effect.succeed(false) : probe(session)
        }),
      disconnect: (connection) =>
        // Deliberately outside `stateGate`. This runs from a connection finalizer, which
        // `Effect.ensuring` executes uninterruptibly, and `Semaphore.withPermits` waits via
        // `restore`, which returns to that enclosing uninterruptible status. Taking the gate here
        // would let one in-flight compound hold up every departing connection with no interrupt
        // path out of the wait. Safe without it: the body below is a single synchronous mutation,
        // so it can only interleave with a compound at that compound's own yield points, and both
        // of its effects are already tolerated there — `callback` snapshots the carriers before it
        // yields, and `back.arming` exists so a probe in flight discards its stale verdict.
        Effect.sync(() => {
          // Section 2.10.5: losing one connection does not end a session that others still
          // reach, and never ends the lease, which expires on its own schedule. Section 18.37.3
          // keeps the lease tied to the client ID even across an explicit DESTROY_SESSION, so a
          // client that never comes back is reclaimed by the sweeper above rather than here.
          for (const session of sessions.values()) {
            if (!session.connections.delete(connection) || session.back === undefined) continue

            let carries = false

            for (const direction of session.connections.values()) {
              if ((direction & CHANNEL_BACK) !== 0) carries = true
            }

            // A backchannel with no connection left cannot be reached, and a connection that
            // binds it later deserves a fresh probe rather than the old verdict.
            if (!carries) {
              session.back.healthy = false
              session.back.probed = false
              session.back.arming++
            }
          }
        })
    }
  })
}
