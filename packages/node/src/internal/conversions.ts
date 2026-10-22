// Native Node consumers require Error, Date and fs constants at this conversion boundary.
/* eslint-disable effecttsgo/extends-native-error, effecttsgo/global-date, effecttsgo/node-builtin-import */
import type { OpenOptions } from "@effect-vfs/core/Caller"
import { type Metadata, type OwnerUpdate, type Times, typedMode } from "@effect-vfs/core/Metadata"
import { FsCode, VfsError } from "@effect-vfs/core/VfsError"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type { BigIntStats, Dirent, Stats } from "node:fs"
import { constants } from "node:fs"
import { constants as osConstants } from "node:os"

const isFailure = Schema.is(VfsError)

const isFsCode = Schema.is(FsCode)

const codes = {
  NotFound: "ENOENT",
  AlreadyExists: "EEXIST",
  NotEmpty: "ENOTEMPTY",
  NotDirectory: "ENOTDIR",
  AccessDenied: "EACCES",
  NotPermitted: "EPERM",
  InvalidHandle: "EBADF",
  ForeignHandle: "EBADF",
  InvalidReference: "EBADF",
  ForeignReference: "EBADF",
  StaleReference: "ESTALE",
  ClosedCaller: "EBADF",
  InvalidArgument: "EINVAL",
  InvalidPathEncoding: "EILSEQ",
  PathTooLong: "ENAMETOOLONG",
  NoSpace: "ENOSPC",
  IsDirectory: "EISDIR",
  FileTooLarge: "EFBIG",
  NoData: "ENXIO",
  SymlinkLoop: "ELOOP",
  UnrepresentableName: "EILSEQ",
  StorageRejected: "EIO",
  OutcomeUnknown: "EIO",
  VolumeUnavailable: "EIO",
  VolumeBusy: "EBUSY"
} as const satisfies Record<FsCode, keyof typeof osConstants.errno>

export class NodeError extends Error {
  readonly errno: number
  constructor(
    readonly code: keyof typeof osConstants.errno,
    readonly syscall: string,
    readonly path?: string,
    readonly dest?: string,
    cause?: unknown
  ) {
    super(`${code}: ${syscall}${path === undefined ? "" : ` '${path}'`}${dest === undefined ? "" : ` -> '${dest}'`}`, {
      cause
    })
    this.errno = -osConstants.errno[code]
  }
}

export const invoke = <A>(syscall: string, path: string | undefined, run: () => A, dest?: string): A => {
  try {
    return run()
  } catch (cause) {
    if (isFailure(cause) && isFsCode(cause.code)) {
      const code = codes[cause.code]
      throw new NodeError(code, syscall, path, dest, cause)
    }

    throw cause
  }
}

const Path = Schema.String.check(
  Schema.makeFilter((s) =>
    !s.includes("\0") && Buffer.from(s).toString("utf8") === s ? undefined : "unrepresentable text path"
  )
)

const validPath = Schema.is(Path)

export const pathOf = (path: string, syscall: string): string => {
  if (!validPath(path)) throw new NodeError("EINVAL", syscall)

  return path === "" ? "/" : path
}

export const textOf = (bytes: Uint8Array, syscall: string, path?: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (cause) {
    throw new NodeError("EILSEQ", syscall, path, undefined, cause)
  }
}

const stringFlags = new Map(Object.entries({
  r: constants.O_RDONLY,
  "r+": constants.O_RDWR,
  rs: constants.O_RDONLY | constants.O_SYNC,
  sr: constants.O_RDONLY | constants.O_SYNC,
  "rs+": constants.O_RDWR | constants.O_SYNC,
  "sr+": constants.O_RDWR | constants.O_SYNC,
  w: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
  "w+": constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC,
  wx: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL,
  xw: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL,
  "wx+": constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL,
  "xw+": constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL,
  a: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
  "a+": constants.O_RDWR | constants.O_CREAT | constants.O_APPEND,
  ax: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_EXCL,
  xa: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_EXCL,
  "ax+": constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_EXCL,
  "xa+": constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_EXCL,
  as: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_SYNC,
  sa: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_SYNC,
  "as+": constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_SYNC,
  "sa+": constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_SYNC
}))

const allowed = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_TRUNC |
  constants.O_APPEND | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_SYNC | constants.O_DSYNC

const Natural = Schema.is(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))

export const integer = (n: number, syscall: string, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (!Natural(n) || n > maximum) throw new NodeError("EINVAL", syscall)

  return n
}

export const ownerOf = (uid: number, gid: number, syscall: string): OwnerUpdate => {
  const owner: OwnerUpdate = {}
  const user = uid === -1 ? owner : { ...owner, uid: integer(uid, syscall) }

  return gid === -1 ? user : { ...user, gid: integer(gid, syscall) }
}

export const flagsOf = (flags: string | number, mode: number, path: string) => {
  const bits = Predicate.isString(flags) ? stringFlags.get(flags) : flags

  if (
    !Predicate.isNumber(bits) || !Number.isSafeInteger(bits) || bits < 0 || bits > 0x7fffffff ||
    (bits & ~allowed) !== 0 || (bits & 3) === 3
  ) throw new NodeError("EINVAL", "open", path)
  integer(mode, "open", 0o7777)
  const access = bits & 3
  const writable = access !== constants.O_RDONLY
  const create = (bits & constants.O_CREAT) !== 0
  const truncate = (bits & constants.O_TRUNC) !== 0
  const append = (bits & constants.O_APPEND) !== 0

  if (!writable && (truncate || append)) throw new NodeError("EINVAL", "open", path)

  const options: OpenOptions = {
    access: access === constants.O_RDONLY ? "read" : access === constants.O_WRONLY ? "write" : "readWrite",
    create: create ? (bits & constants.O_EXCL) !== 0 ? "exclusive" : "ifMissing" : "never",
    truncate,
    append
  }

  const chosen = create ? { ...options, mode } : options

  return {
    readable: access !== constants.O_WRONLY,
    writable,
    append,
    directory: (bits & constants.O_DIRECTORY) !== 0,
    noFollow: (bits & constants.O_NOFOLLOW) !== 0,
    options: chosen
  }
}

export type EncodingOptions =
  | BufferEncoding
  | { readonly encoding?: BufferEncoding | "buffer" | null | undefined }
  | null

export const encodingOf = (options?: EncodingOptions): BufferEncoding | undefined => {
  const value = Predicate.isString(options) ? options : options?.encoding

  if (value === undefined || value === null || value === "buffer") return undefined

  if (!Buffer.isEncoding(value)) throw new NodeError("EINVAL", "encoding")

  return value
}

export const encoded = (bytes: Uint8Array, options?: EncodingOptions): Buffer | string => {
  const data = Buffer.from(bytes)
  const encoding = encodingOf(options)

  return encoding === undefined ? data : data.toString(encoding)
}

export const dataOf = (data: string | Uint8Array, options?: EncodingOptions): Buffer => {
  const encoding = encodingOf(options)

  if (Predicate.isString(data)) return Buffer.from(data, encoding)

  if (!(data instanceof Uint8Array)) throw new NodeError("EINVAL", "write")

  return Buffer.from(data)
}

export const timesOf = (atime: number | string | Date, mtime: number | string | Date): Times => {
  const nanos = (value: number | string | Date): bigint => {
    const seconds = value instanceof Date ? value.getTime() / 1000 : Predicate.isString(value) ? Number(value) : value

    if (!Number.isFinite(seconds)) throw new NodeError("EINVAL", "utimes")

    // Node treats negative numbers as now, but preserves explicit Date and string values.
    if (Predicate.isNumber(value) && value < 0) return BigInt(Date.now()) * 1_000_000n

    return BigInt(Math.trunc(seconds * 1e9))
  }

  return {
    access: { kind: "value", nanoseconds: nanos(atime) },
    modification: { kind: "value", nanoseconds: nanos(mtime) }
  }
}

// Node 26 exposes Temporal; keep the declaration local until the configured TS lib includes it.
interface NativeInstant {
  readonly epochNanoseconds: bigint
  toString(): string
}

declare const Temporal: { readonly Instant: { readonly fromEpochNanoseconds: (value: bigint) => NativeInstant } }

class Kind {
  constructor(private readonly kind: Metadata["kind"]) {}
  isFile() {
    return this.kind === "file"
  }
  isDirectory() {
    return this.kind === "directory"
  }
  isSymbolicLink() {
    return this.kind === "symlink"
  }
  isBlockDevice() {
    return false
  }
  isCharacterDevice() {
    return false
  }
  isFIFO() {
    return false
  }
  isSocket() {
    return false
  }
}

class NumberStats extends Kind implements Stats {
  readonly #metadata: Metadata
  readonly dev: number
  readonly rdev: number
  readonly mode: number
  readonly ino: number
  readonly nlink: number
  readonly uid: number
  readonly gid: number
  readonly size: number
  readonly blksize: number
  readonly blocks: number
  readonly atimeMs: number
  readonly atime: Date
  get atimeInstant(): NativeInstant {
    return Temporal.Instant.fromEpochNanoseconds(this.#metadata.atimeNs)
  }
  readonly mtimeMs: number
  readonly mtime: Date
  get mtimeInstant(): NativeInstant {
    return Temporal.Instant.fromEpochNanoseconds(this.#metadata.mtimeNs)
  }
  readonly ctimeMs: number
  readonly ctime: Date
  get ctimeInstant(): NativeInstant {
    return Temporal.Instant.fromEpochNanoseconds(this.#metadata.ctimeNs)
  }
  readonly birthtimeMs: number
  readonly birthtime: Date
  get birthtimeInstant(): NativeInstant {
    return Temporal.Instant.fromEpochNanoseconds(this.#metadata.birthtimeNs)
  }
  constructor(metadata: Metadata) {
    super(metadata.kind)
    this.#metadata = metadata
    this.dev = Number(0n)
    this.rdev = Number(0n)
    this.mode = Number(BigInt(typedMode(metadata)))
    this.ino = Number(metadata.ino)
    this.nlink = Number(BigInt(metadata.nlink))
    this.uid = Number(BigInt(metadata.uid))
    this.gid = Number(BigInt(metadata.gid))
    this.size = Number(metadata.size)
    this.blksize = Number(4096n)
    this.blocks = Number((metadata.size + 511n) / 512n)
    this.atimeMs = Number(metadata.atimeNs) / 1e6
    this.atime = new Date(Number(metadata.atimeNs / 1000000n))
    this.mtimeMs = Number(metadata.mtimeNs) / 1e6
    this.mtime = new Date(Number(metadata.mtimeNs / 1000000n))
    this.ctimeMs = Number(metadata.ctimeNs) / 1e6
    this.ctime = new Date(Number(metadata.ctimeNs / 1000000n))
    this.birthtimeMs = Number(metadata.birthtimeNs) / 1e6
    this.birthtime = new Date(Number(metadata.birthtimeNs / 1000000n))
  }
}

class BigStats extends Kind implements BigIntStats {
  readonly #metadata: Metadata
  readonly dev: bigint
  readonly rdev: bigint
  readonly mode: bigint
  readonly ino: bigint
  readonly nlink: bigint
  readonly uid: bigint
  readonly gid: bigint
  readonly size: bigint
  readonly blksize: bigint
  readonly blocks: bigint
  readonly atimeMs: bigint
  readonly atime: Date
  get atimeInstant(): NativeInstant {
    return Temporal.Instant.fromEpochNanoseconds(this.#metadata.atimeNs)
  }
  readonly atimeNs: bigint
  readonly mtimeMs: bigint
  readonly mtime: Date
  get mtimeInstant(): NativeInstant {
    return Temporal.Instant.fromEpochNanoseconds(this.#metadata.mtimeNs)
  }
  readonly mtimeNs: bigint
  readonly ctimeMs: bigint
  readonly ctime: Date
  get ctimeInstant(): NativeInstant {
    return Temporal.Instant.fromEpochNanoseconds(this.#metadata.ctimeNs)
  }
  readonly ctimeNs: bigint
  readonly birthtimeMs: bigint
  readonly birthtime: Date
  get birthtimeInstant(): NativeInstant {
    return Temporal.Instant.fromEpochNanoseconds(this.#metadata.birthtimeNs)
  }
  readonly birthtimeNs: bigint
  constructor(metadata: Metadata) {
    super(metadata.kind)
    this.#metadata = metadata
    this.dev = 0n
    this.rdev = 0n
    this.mode = BigInt(typedMode(metadata))
    this.ino = metadata.ino
    this.nlink = BigInt(metadata.nlink)
    this.uid = BigInt(metadata.uid)
    this.gid = BigInt(metadata.gid)
    this.size = metadata.size
    this.blksize = 4096n
    this.blocks = (metadata.size + 511n) / 512n
    this.atimeMs = metadata.atimeNs / 1000000n
    this.atime = new Date(Number(metadata.atimeNs / 1000000n))
    this.atimeNs = metadata.atimeNs
    this.mtimeMs = metadata.mtimeNs / 1000000n
    this.mtime = new Date(Number(metadata.mtimeNs / 1000000n))
    this.mtimeNs = metadata.mtimeNs
    this.ctimeMs = metadata.ctimeNs / 1000000n
    this.ctime = new Date(Number(metadata.ctimeNs / 1000000n))
    this.ctimeNs = metadata.ctimeNs
    this.birthtimeMs = metadata.birthtimeNs / 1000000n
    this.birthtime = new Date(Number(metadata.birthtimeNs / 1000000n))
    this.birthtimeNs = metadata.birthtimeNs
  }
}

export const statsOf = (metadata: Metadata, options?: { readonly bigint?: boolean | undefined }): Stats | BigIntStats =>
  options?.bigint ? new BigStats(metadata) : new NumberStats(metadata)

export class Entry<N extends string | Buffer = string> extends Kind implements Dirent<N> {
  constructor(readonly name: N, readonly parentPath: string, kind: Metadata["kind"]) {
    super(kind)
  }
}
