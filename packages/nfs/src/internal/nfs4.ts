import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { InvalidFilehandleError, InvalidNameError, type NfsExport, validateName } from "./export.js"
import type { CompoundCall } from "./rpc.js"
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
  EXPIRED: 10011,
  FHEXPIRED: 10014,
  RESOURCE: 10018,
  NOFILEHANDLE: 10020,
  MINOR_VERS_MISMATCH: 10021,
  STALE_CLIENTID: 10022,
  OLD_STATEID: 10024,
  BAD_STATEID: 10025,
  BAD_SEQID: 10026,
  NOT_SAME: 10027,
  ATTRNOTSUPP: 10032,
  BADXDR: 10036,
  OPENMODE: 10038,
  BADNAME: 10041,
  OP_ILLEGAL: 10044,
  BADSESSION: 10052,
  BADSLOT: 10053,
  COMPLETE_ALREADY: 10054,
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
  NOT_ONLY_OP: 10081
} as const

export const Operation = {
  ACCESS: 3,
  CLOSE: 4,
  CREATE: 6,
  GETATTR: 9,
  GETFH: 10,
  LINK: 11,
  LOOKUP: 15,
  LOOKUPP: 16,
  OPEN: 18,
  PUTFH: 22,
  PUTROOTFH: 24,
  READ: 25,
  READDIR: 26,
  READLINK: 27,
  REMOVE: 28,
  RENAME: 29,
  RESTOREFH: 31,
  SAVEFH: 32,
  SETATTR: 34,
  WRITE: 38,
  EXCHANGE_ID: 42,
  CREATE_SESSION: 43,
  DESTROY_SESSION: 44,
  SEQUENCE: 53,
  DESTROY_CLIENTID: 57,
  RECLAIM_COMPLETE: 58,
  ILLEGAL: 10044
} as const

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
  readonly generation: Uint8Array
  readonly now: () => number
  readonly limits: Nfs4Limits
}

export interface Nfs4Handler {
  readonly compound: (call: CompoundCall) => Effect.Effect<Uint8Array>
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
  | { readonly kind: "Unknown"; readonly code: number; readonly value: undefined }
type ResultPart = { readonly code: number; readonly status: number; readonly body?: Uint8Array }
type CurrentObject = Vfs.ObjectReference

interface ClientState {
  readonly id: bigint
  readonly owner: string
  readonly verifier: string
  readonly previous: ClientState | undefined
  sequence: number
  leaseExpiresAt: number
  reclaimed: boolean
  confirmed: boolean
  createSessionReplay: {
    readonly sequence: number
    readonly request: Uint8Array
    readonly credentials: string
    readonly status: number
    readonly body?: Uint8Array
    readonly retainedBytes: ByteSize.ByteSize
  } | undefined
}

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
}

interface OpenState {
  id: Uint8Array
  sequence: number
  readonly owner: string
  readonly client: ClientState
  readonly reference: Vfs.ObjectReference
  readonly file: Vfs.FileHandle
  readonly close: Effect.Effect<void>
}

const empty = new Uint8Array()

const assertOptions = (options: Nfs4Options): void => {
  if (!Number.isSafeInteger(options.leaseDurationSeconds) || options.leaseDurationSeconds <= 0) {
    throw new RangeError("leaseDurationSeconds must be a positive safe integer")
  }
  if (options.generation.length !== 16) throw new RangeError("generation must contain exactly 16 bytes")
  for (const [name, value] of Object.entries(options.limits)) {
    if (typeof value === "bigint") {
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
  credentials._tag === "None"
    ? "none"
    : `sys:${credentials.uid}:${credentials.gid}:${credentials.machineName}:${
      credentials.supplementaryGroups.join(",")
    }`

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

const readCallbackSecurity = (reader: Reader, limits: Nfs4Limits): number => {
  const flavor = reader.uint32()
  if (flavor === 0) return flavor
  if (flavor === 1) {
    reader.uint32()
    reader.string(limits.maxStringBytes)
    reader.uint32()
    reader.uint32()
    reader.array((item) => item.uint32(), limits.maxArrayElements)
    return flavor
  }
  if (flavor === 6) {
    reader.uint32()
    reader.opaque(limits.maxOpaqueBytes)
    reader.opaque(limits.maxOpaqueBytes)
    return flavor
  }
  throw new XdrDecodeError("Unsupported callback security flavor")
}

const writeChannelAttrs = (
  writer: Writer,
  attrs: ChannelAttrs
): void => {
  writer.uint32(attrs.headerPadding).uint32(attrs.maxRequest).uint32(attrs.maxResponse)
    .uint32(attrs.maxCachedResponse).uint32(attrs.maxOperations).uint32(attrs.maxRequests)
    .array(attrs.rdmaIrd, (item, value) => item.uint32(value))
}

const decodeOperation = (reader: Reader, limits: Nfs4Limits): ParsedOperation => {
  const code = reader.uint32()
  switch (code) {
    case Operation.ACCESS:
      return { kind: "Access", code, value: reader.uint32() }
    case Operation.CLOSE:
      return { kind: "Close", code, value: { sequence: reader.uint32(), stateid: reader.fixedOpaque(16) } }
    case Operation.CREATE: {
      const kind = reader.uint32()
      if (kind === 5) reader.string(limits.maxNameBytes)
      else if (kind === 3 || kind === 4) {
        reader.uint32()
        reader.uint32()
      }
      const name = reader.opaque(limits.maxNameBytes)
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
      return { kind: "Link", code, value: reader.opaque(limits.maxNameBytes) }
    case Operation.LOOKUP:
      return { kind: "Lookup", code, value: reader.opaque(limits.maxNameBytes) }
    case Operation.REMOVE:
      return { kind: "Remove", code, value: reader.opaque(limits.maxNameBytes) }
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
      if (claim === 0 || claim === 3) name = reader.opaque(limits.maxNameBytes)
      else if (claim === 1) reader.uint32()
      else if (claim === 2) {
        reader.fixedOpaque(16)
        name = reader.opaque(limits.maxNameBytes)
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
        value: { oldName: reader.opaque(limits.maxNameBytes), newName: reader.opaque(limits.maxNameBytes) }
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
      const protection = reader.uint32()
      if (protection === 1) {
        bitmap(reader, limits.maxBitmapWords)
        bitmap(reader, limits.maxBitmapWords)
      } else if (protection !== 0) {
        throw new XdrDecodeError("Unsupported state protection")
      }
      reader.array((item) => {
        item.string(limits.maxStringBytes)
        item.string(limits.maxStringBytes)
        item.uint64()
        item.uint32()
      }, limits.maxArrayElements)
      return { kind: "ExchangeId", code, value: { verifier, owner, flags, protection } }
    }
    case Operation.CREATE_SESSION: {
      const client = reader.uint64()
      const sequence = reader.uint32()
      const flags = reader.uint32()
      const fore = readChannelAttrs(reader)
      const back = readChannelAttrs(reader)
      reader.uint32()
      reader.array((item) => readCallbackSecurity(item, limits), limits.maxArrayElements)
      return { kind: "CreateSession", code, value: { client, sequence, flags, fore, back } }
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
    default:
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
  let unknown = false
  for (let index = 0; index < count; index++) {
    const operation = decodeOperation(reader, limits)
    operations.push(operation)
    if (!Object.values(Operation).includes(operation.code as never)) {
      unknown = true
      break
    }
  }
  if (!unknown) reader.finish()
  return { tag, minor, operations }
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
  19,
  20,
  29,
  30,
  31,
  33,
  35,
  36,
  37,
  45,
  47,
  52,
  53,
  55,
  75
]

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

const encodeAttributes = (
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
        values.boolean(true)
        break
      case 7:
        values.boolean(false)
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
  return encodeStatusBody((writer) => {
    writeBitmap(writer, wordsFor(requested))
    writer.opaque(values.bytes())
  })
}

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

const replayReplyBound = (
  operations: ReadonlyArray<ParsedOperation>,
  tagBytes: number
): number => {
  let bytes = 12 + tagBytes + (4 - tagBytes % 4) % 4
  for (const operation of operations) {
    if (operation.kind === "Read") {
      bytes += 32
    } else if (operation.kind === "Readdir") {
      bytes += 32
    } else if (operation.kind === "Getattr") {
      bytes += 32
    } else if (operation.kind === "Getfh") {
      bytes += 64
    } else if (operation.kind === "Readlink") {
      bytes += 32
    } else if (operation.kind === "Sequence") {
      bytes += 44
    } else {
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
          return Effect.succeed(encodeCompound(tag, [], Status.BADXDR))
        }
        if (parsed.minor !== 1) {
          return Effect.succeed(encodeCompound(parsed.tag, [], Status.MINOR_VERS_MISMATCH))
        }

        const misplacedSequence = parsed.operations.findIndex((operation) => operation.code === Operation.SEQUENCE)
        if (misplacedSequence > 0) {
          return Effect.succeed(
            encodeCompound(parsed.tag, [{ code: Operation.SEQUENCE, status: Status.SEQUENCE_POS }])
          )
        }

        const firstCode = parsed.operations[0]?.code
        const isSoleBootstrap = parsed.operations.length === 1 && (
          firstCode === Operation.EXCHANGE_ID || firstCode === Operation.CREATE_SESSION ||
          firstCode === Operation.DESTROY_SESSION || firstCode === Operation.DESTROY_CLIENTID
        )
        if (parsed.operations.length > 0 && firstCode !== Operation.SEQUENCE && !isSoleBootstrap) {
          if (firstCode === Operation.DESTROY_SESSION) {
            return Effect.succeed(
              encodeCompound(parsed.tag, [{ code: firstCode, status: Status.NOT_ONLY_OP }])
            )
          }
          return Effect.succeed(
            encodeCompound(parsed.tag, [{ code: firstCode!, status: Status.OP_NOT_IN_SESSION }])
          )
        }

        const first = parsed.operations[0]
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
            return Effect.succeed(new Uint8Array(slot.response))
          }
        }

        let rollbackSequence: (() => void) | undefined
        return Effect.gen(function*() {
          const parts: Array<ResultPart> = []
          let current: CurrentObject | undefined
          let saved: CurrentObject | undefined
          let currentStateid: Uint8Array | undefined
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
              return encodeCompound(parsed.tag, [{ code: Operation.SEQUENCE, status: Status.RESOURCE }])
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
              return encodeCompound(parsed.tag, [{ code: Operation.SEQUENCE, status: Status.RESOURCE }])
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

            switch (operation.kind) {
              case "ExchangeId": {
                const value = operation.value
                if ((value.flags & ~EXCHGID4_ALLOWED_ARGUMENT_FLAGS) !== 0) {
                  return Effect.succeed({ code: operation.code, status: Status.INVAL })
                }
                const owner = bytesKey(value.owner)
                const verifier = bytesKey(value.verifier)
                const updateConfirmed = (value.flags & 0x4000_0000) !== 0
                let client: ClientState | undefined
                if (updateConfirmed) {
                  const confirmed = [...clients.values()].find((candidate) =>
                    candidate.owner === owner && candidate.confirmed
                  )
                  if (confirmed === undefined) {
                    return Effect.succeed({ code: operation.code, status: Status.NOENT })
                  }
                  if (confirmed.verifier !== verifier) {
                    return Effect.succeed({ code: operation.code, status: Status.NOT_SAME })
                  }
                  client = confirmed
                } else {
                  client = [...clients.values()].find((candidate) =>
                    candidate.owner === owner && candidate.verifier === verifier
                  )
                }
                if (client === undefined) {
                  const currentClient = clientsByOwner.get(owner)
                  if (currentClient === undefined && clientsByOwner.size >= options.limits.maxClients) {
                    return Effect.succeed({ code: operation.code, status: Status.RESOURCE })
                  }
                  if (
                    currentClient?.confirmed === true &&
                    [...clients.values()].filter((candidate) =>
                        !candidate.confirmed && candidate.previous !== undefined
                      )
                        .length >= options.limits.maxPendingClientReplacements
                  ) {
                    return Effect.succeed({ code: operation.code, status: Status.RESOURCE })
                  }
                  const previous = currentClient?.confirmed === true ? currentClient : currentClient?.previous
                  if (currentClient !== undefined && !currentClient.confirmed) {
                    clients.delete(currentClient.id)
                  }
                  client = {
                    id: clientSerial++,
                    owner,
                    verifier,
                    previous,
                    sequence: 1,
                    leaseExpiresAt: options.now() + options.leaseDurationSeconds * 1000,
                    reclaimed: false,
                    confirmed: false,
                    createSessionReplay: undefined
                  }
                  clients.set(client.id, client)
                  clientsByOwner.set(owner, client)
                }
                const body = encodeStatusBody((writer) => {
                  const flags = EXCHGID4_FLAG_USE_NON_PNFS |
                    (client!.confirmed ? EXCHGID4_FLAG_CONFIRMED_R : 0)
                  writer.uint64(client!.id).uint32(client!.sequence).uint32(flags >>> 0).uint32(0)
                  writer.uint64(export_.fsid[0]).opaque(options.generation).opaque(options.generation)
                  writer.array([], () => undefined)
                })
                return Effect.succeed({ code: operation.code, status: Status.OK, body })
              }
              case "CreateSession": {
                const value = operation.value
                const client = clients.get(value.client)
                if (client === undefined) return Effect.succeed({ code: operation.code, status: Status.STALE_CLIENTID })
                const replay = client.createSessionReplay
                if (replay?.sequence === value.sequence) {
                  if (
                    sameRequest(replay.request, call.arguments) &&
                    replay.credentials === credentialsKey(call.credentials)
                  ) {
                    return Effect.succeed({
                      code: operation.code,
                      status: replay.status,
                      ...(replay.body === undefined ? {} : { body: new Uint8Array(replay.body) })
                    })
                  }
                  return Effect.succeed({ code: operation.code, status: Status.SEQ_MISORDERED })
                }
                if (value.sequence !== client.sequence) {
                  return Effect.succeed({ code: operation.code, status: Status.SEQ_MISORDERED })
                }
                const complete = (status: number, body?: Uint8Array): ResultPart => {
                  const previousRetainedBytes = client.createSessionReplay?.retainedBytes ?? ByteSize.bytes(0)
                  const retainedBytes = addBytes(
                    byteLength(call.arguments.length),
                    byteLength(body?.length ?? 0)
                  )
                  replayBytes = subtractBytes(replayBytes, previousRetainedBytes)
                  replayBytes = addBytes(replayBytes, retainedBytes)
                  client.sequence = nextSequenceId(client.sequence)
                  client.createSessionReplay = {
                    sequence: value.sequence,
                    request: new Uint8Array(call.arguments),
                    credentials: credentialsKey(call.credentials),
                    status,
                    retainedBytes,
                    ...(body === undefined ? {} : { body: new Uint8Array(body) })
                  }
                  return body === undefined
                    ? { code: operation.code, status }
                    : { code: operation.code, status, body }
                }
                return Effect.gen(function*() {
                  const previousRetainedBytes = client.createSessionReplay?.retainedBytes ?? ByteSize.bytes(0)
                  if (
                    addBytes(byteLength(call.arguments.length), ByteSize.bytes(80)) >
                      subtractBytes(options.limits.maxReplayBytes, subtractBytes(replayBytes, previousRetainedBytes))
                  ) {
                    return { code: operation.code, status: Status.RESOURCE }
                  }
                  if (client.previous !== undefined) {
                    const previousSessions = [...sessions.values()].filter((session) =>
                      session.client === client.previous
                    ).length
                    if (sessions.size - previousSessions >= options.limits.maxSessions) {
                      return complete(Status.RESOURCE)
                    }
                    yield* revokeClient(client.previous)
                    removeClientRecord(client.previous)
                  } else if (sessions.size >= options.limits.maxSessions) {
                    return complete(Status.RESOURCE)
                  }
                  const requestedSlots = Math.max(1, value.fore.maxRequests)
                  const slotCount = Math.min(requestedSlots, options.limits.maxSlotsPerSession)
                  const id = makeOpaqueId(options.generation, sessionSerial++)
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
                  sessions.set(bytesKey(id), {
                    id,
                    client,
                    fore,
                    slots: Array.from({ length: slotCount }, () => ({ sequence: 0 }))
                  })
                  client.confirmed = true
                  const body = encodeStatusBody((writer) => {
                    writer.fixedOpaque(id).uint32(value.sequence).uint32(0)
                    writeChannelAttrs(writer, fore)
                    writeChannelAttrs(writer, value.back)
                  })
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
                if (parsed.operations.length > session.fore.maxOperations) {
                  return Effect.succeed({ code: operation.code, status: Status.TOO_MANY_OPS })
                }
                const replyBound = replayReplyBound(parsed.operations, parsed.tag.length)
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
                  return Effect.succeed({ code: operation.code, status: Status.RESOURCE })
                }
                const previousSlot = {
                  sequence: slot.sequence,
                  response: slot.response,
                  request: slot.request,
                  credentials: slot.credentials,
                  retainedBytes: slot.retainedBytes
                }
                const previousReplayBytes = replayBytes
                rollbackSequence = () => {
                  replayBytes = previousReplayBytes
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
                releaseCreateSessionReplay(session.client)
                activeSession = session
                activeSlot = slot
                shouldCache = value.cache
                const body = encodeStatusBody((writer) => {
                  writer.fixedOpaque(session.id).uint32(value.sequence).uint32(value.slot)
                    .uint32(session.slots.length - 1).uint32(session.slots.length - 1).uint32(0)
                })
                return Effect.succeed({ code: operation.code, status: Status.OK, body })
              }
              case "ReclaimComplete": {
                if (activeSession === undefined) {
                  return Effect.succeed({ code: operation.code, status: Status.BADSESSION })
                }
                if (activeSession.client.reclaimed) {
                  return Effect.succeed({ code: operation.code, status: Status.COMPLETE_ALREADY })
                }
                activeSession.client.reclaimed = true
                return Effect.succeed({ code: operation.code, status: Status.OK })
              }
              case "DestroySession": {
                const key = bytesKey(operation.value)
                const session = sessions.get(key)
                if (session === undefined) {
                  return Effect.succeed({ code: operation.code, status: Status.BADSESSION })
                }
                if (
                  session === activeSession &&
                  parsed.operations[parsed.operations.length - 1] !== operation
                ) {
                  return Effect.succeed({ code: operation.code, status: Status.NOT_ONLY_OP })
                }
                for (const slot of session.slots) {
                  replayBytes = subtractBytes(replayBytes, slot.retainedBytes ?? ByteSize.bytes(0))
                }
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
                return statusResult(mapFs(export_.root), (reference) => {
                  current = reference
                  return undefined
                })
              case "Putfh":
                return export_.resolve(operation.value).pipe(
                  Effect.map((reference): ResultPart => {
                    current = reference
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
                  Effect.orElseSucceed(() => ({ code: operation.code, status: Status.RESOURCE }))
                )
              case "Savefh":
                if (current === undefined) return Effect.succeed(noCurrent())
                saved = current
                return Effect.succeed({ code: operation.code, status: Status.OK })
              case "Restorefh":
                if (saved === undefined) return Effect.succeed(noCurrent())
                current = saved
                return Effect.succeed({ code: operation.code, status: Status.OK })
              case "Lookup":
                return statusResult(
                  withCurrent((reference) =>
                    export_.lookup(reference, operation.value).pipe(
                      Effect.mapError((error) => error instanceof InvalidNameError ? Status.INVAL : failureForFs(error))
                    )
                  ),
                  (reference) => {
                    current = reference
                    return undefined
                  }
                )
              case "Lookupp":
                return statusResult(withCurrent((reference) => mapFs(export_.parent(reference))), (reference) => {
                  current = reference
                  return undefined
                })
              case "Getattr": {
                if (current === undefined) return Effect.succeed(noCurrent())
                const reference = current
                const requested = requestedAttributes(operation.value)
                const supportedRequested = requested.filter((attribute) => supportedAttributes.includes(attribute))
                const attributes = export_.handleFor(reference).pipe(
                  Effect.mapError(() => Status.RESOURCE),
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
              case "Access": {
                if (current === undefined) return Effect.succeed(noCurrent())
                const requested = operation.value
                const supported = requested & (1 | 2 | 32)
                return statusResult(
                  mapFs(export_.observeMetadata(current)),
                  () => new Writer().uint32(supported).uint32(supported).bytes()
                )
              }
              case "Readlink":
                return statusResult(
                  withCurrent((reference) =>
                    mapFs(export_.readLink(reference)).pipe(
                      Effect.filterOrFail(
                        (target) => byteLength(target.length) <= options.limits.maxStringBytes,
                        () => Status.RESOURCE
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
                          : yield* export_.handleFor(entry.reference).pipe(
                            Effect.mapError(() => Status.RESOURCE),
                            Effect.flatMap((handle) =>
                              mapFs(export_.observeMetadata(entry.reference)).pipe(
                                Effect.flatMap((metadata) =>
                                  requireAttributes(
                                    encodeAttributes(supportedRequested, metadata, handle, export_, options)
                                  )
                                )
                              )
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
                if (activeSession === undefined || current === undefined) {
                  return Effect.succeed({ code: operation.code, status: Status.BADSESSION })
                }
                const directory = current
                const value = operation.value
                if (value.client !== activeSession.client.id) {
                  return Effect.succeed({ code: operation.code, status: Status.STALE_CLIENTID })
                }
                if (value.openHow !== 0) return Effect.succeed({ code: operation.code, status: Status.ROFS })
                if (value.claim !== 0 && value.claim !== 4) {
                  return Effect.succeed({ code: operation.code, status: Status.NOTSUPP })
                }
                if (value.access === 0 || (value.access & ~3) !== 0) {
                  return Effect.succeed({ code: operation.code, status: Status.INVAL })
                }
                if ((value.access & 2) !== 0) {
                  return Effect.succeed({ code: operation.code, status: Status.ROFS })
                }
                if (value.deny !== 0) {
                  return Effect.succeed({ code: operation.code, status: Status.OPENMODE })
                }
                const target = value.claim === 4
                  ? Effect.succeed({ revision: 0n, reference: directory })
                  : mapFs(export_.observeDirectory(directory)).pipe(
                    Effect.flatMap((directoryObservation) =>
                      export_.lookup(directory, value.name).pipe(
                        Effect.mapError((error) =>
                          error instanceof InvalidNameError ? Status.INVAL : failureForFs(error)
                        ),
                        Effect.map((reference) => ({ revision: directoryObservation.revision, reference }))
                      )
                    )
                  )
                return target.pipe(
                  Effect.flatMap(({ revision, reference }) =>
                    Effect.uninterruptibleMask((restore) =>
                      Effect.suspend(() => {
                        const owner = bytesKey(value.owner)
                        const existing = [...opens.values()].find((open) =>
                          open.client === activeSession!.client && open.owner === owner && open.reference === reference
                        )
                        if (existing !== undefined) {
                          existing.sequence += 1
                          existing.id = makeStateId(
                            options.generation,
                            new DataView(existing.id.buffer, existing.id.byteOffset + 8, 8).getBigUint64(0),
                            existing.sequence
                          )
                          current = reference
                          return Effect.succeed(openResult(existing.id, revision, value.claim === 4))
                        }
                        if (opens.size >= options.limits.maxOpens) {
                          return Effect.succeed({ code: operation.code, status: Status.RESOURCE } satisfies ResultPart)
                        }
                        const serial = openSerial++
                        return restore(mapFs(export_.open(reference))).pipe(
                          Effect.map((opened): ResultPart => {
                            const id = makeStateId(options.generation, serial, 1)
                            opens.set(stateIdKey(id), {
                              id,
                              sequence: 1,
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
                    writer.uint32(0)
                  })
                  return { code: operation.code, status: Status.OK, body }
                }
              }
              case "Read": {
                const value = operation.value
                if (current === undefined) return Effect.succeed(noCurrent())
                if (byteLength(value.count) > options.limits.maxReadBytes) {
                  return Effect.succeed({ code: operation.code, status: Status.RESOURCE })
                }
                if (isAllZero(value.stateid) || isAllOnes(value.stateid)) {
                  const reference = current
                  return Effect.acquireUseRelease(
                    mapFs(export_.open(reference)),
                    (opened) => readFrom(opened.handle),
                    (opened) => opened.close
                  ).pipe(
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
              case "Close": {
                const value = operation.value
                const key = stateIdKey(value.stateid)
                const open = opens.get(key)
                if (open === undefined) return Effect.succeed({ code: operation.code, status: Status.BAD_STATEID })
                const suppliedSequence = stateIdSequence(value.stateid)
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
                const closedStateid = new Uint8Array(open.id)
                new DataView(closedStateid.buffer).setUint32(0, open.sequence + 1)
                return Effect.uninterruptible(open.close).pipe(
                  Effect.tap(() => Effect.sync(() => opens.delete(key))),
                  Effect.as({
                    code: operation.code,
                    status: Status.OK,
                    body: new Writer().fixedOpaque(closedStateid).bytes()
                  })
                )
              }
              case "Setattr":
              case "Write":
              case "Create":
              case "Remove":
              case "Rename":
              case "Link":
                return Effect.succeed({ code: operation.code, status: Status.ROFS })
              case "Unknown":
                return Effect.succeed({ code: Operation.ILLEGAL, status: Status.OP_ILLEGAL })
            }
          }
        }).pipe(
          Effect.onInterrupt(() => Effect.sync(() => rollbackSequence?.()))
        )
      }).pipe(Effect.orDie)

    return {
      compound: (call) =>
        stateGate.withPermit(
          Effect.uninterruptible(sweepExpired.pipe(Effect.andThen(executeCompound(call))))
        )
    }
  })
}
