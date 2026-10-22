import * as Arr from "effect/Array"
import * as Brand from "effect/Brand"
import * as ByteSize from "effect/ByteSize"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Equal from "effect/Equal"
import * as Exit from "effect/Exit"
import { dual } from "effect/Function"
import * as HashMap from "effect/HashMap"
import * as Match from "effect/Match"
import * as MutableRef from "effect/MutableRef"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Scheduler from "effect/Scheduler"
import type { SchedulerDispatcher } from "effect/Scheduler"
import * as Schema from "effect/Schema"
import type * as SchemaIssue from "effect/SchemaIssue"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import { DirectoryHandleId, FileHandleId, SeekMode } from "../FileHandle.js"
import type { BytePath } from "./bytePath.js"
import * as BytePathStorage from "./bytePath.js"

import { type Metadata, Mode, OwnerUpdate, Times, Timestamp, type TimeUpdate } from "../Metadata.js"
import { type ArgumentFailure, type FsCode, type FsFailure, make as makeError, VfsError } from "../VfsError.js"

/** Filesystem capability contracts owned by the engine; public modules are compatibility views. @internal */
export type PathInput = string | BytePath

/** @internal */
export interface EngineLimits {
  readonly maxBytes: ByteSize.ByteSize | undefined
  readonly maxFileBytes: ByteSize.ByteSize
  readonly maxEntries: number | undefined
  readonly maxPathBytes: ByteSize.ByteSize | undefined
  /** Waiting budget; at most this many plus one callers are admitted at once. */
  readonly maxPendingOperations: number
}

/** @internal */
export interface VolumeUsage {
  readonly usedBytes: bigint
  readonly entries: number
}

/** @internal */
export interface ObjectReference {
  readonly [ObjectReferenceId]: true
}

/** @internal */
export interface ObjectObservation<A> {
  readonly value: A
  readonly revision: bigint
}

/** @internal */
export interface DirectoryEntry {
  readonly name: Uint8Array
  readonly reference: ObjectReference
}

/** @internal */
export interface WalkEntry {
  readonly path: BytePath
  readonly name: Uint8Array
  readonly reference: ObjectReference
  readonly directory: ObjectReference
  readonly kind: Metadata["kind"]
  readonly depth: number
}

/** @internal */
export interface ReferenceEntryResult {
  readonly reference: ObjectReference
  readonly directory: DirectoryChange
}

/** @internal */
export interface DirectoryHandle {
  readonly [DirectoryHandleId]: true
  readonly stat: Effect.Effect<Metadata, FsFailure>
  readonly close: Effect.Effect<void, FsFailure>
}

/** @internal */
export interface OpenEntryResult {
  readonly handle: FileHandle
  readonly reference: ObjectReference
  readonly created: boolean
  readonly directory: DirectoryChange
}

/** @internal */
export interface ReadResult {
  readonly bytes: Uint8Array
  readonly eof: boolean
}

/** @internal */
export interface FileHandle {
  readonly [FileHandleId]: true
  readonly read: (maximumBytes: number) => Effect.Effect<Uint8Array, FsFailure>
  readonly pread: (maximumBytes: number, offset: bigint) => Effect.Effect<ReadResult, FsFailure>
  readonly write: (bytes: Uint8Array) => Effect.Effect<number, FsFailure>
  readonly pwrite: {
    (offset: bigint): (bytes: Uint8Array) => Effect.Effect<number, FsFailure>
    (bytes: Uint8Array, offset: bigint): Effect.Effect<number, FsFailure>
  }
  readonly seek: {
    (mode: SeekMode): (offset: bigint) => Effect.Effect<bigint, FsFailure>
    (offset: bigint, mode: SeekMode): Effect.Effect<bigint, FsFailure>
  }
  readonly truncate: (length: bigint) => Effect.Effect<void, FsFailure>
  readonly stat: Effect.Effect<Metadata, FsFailure>
  readonly sync: Effect.Effect<void, FsFailure>
  readonly close: Effect.Effect<void, FsFailure>
}

/** @internal */
export type WalkFailure = FsFailure | (VfsError & { readonly code: "LimitExceeded" })

/** Filesystem error helpers; image/codec helpers remain community-owned. @internal */
export namespace Errors {
  const encoder = new TextEncoder()

  // Omit invalid paths rather than attach a BytePath that breaks its invariant.
  /** @internal */
  export const errorPath = (input: PathInput): BytePath | undefined => {
    const bytes = Predicate.isString(input)
      ? encoder.encode(input)
      : BytePathStorage.isBytePath(input)
      ? BytePathStorage.getBytes(input)
      : undefined

    if (bytes === undefined || !BytePathStorage.isPathBytes(bytes)) return undefined

    return BytePathStorage.isBytePath(input) ? input : BytePathStorage.make(bytes)
  }

  const configurationField = (issue: SchemaIssue.Issue): string => {
    if (Predicate.isTagged("Pointer")(issue)) return issue.path.map(String).join(".")

    if (Predicate.isTagged("Composite")(issue)) return configurationField(issue.issues[0])

    if (Predicate.isTagged("Encoding")(issue)) return configurationField(issue.issue)

    return "options"
  }

  interface Details {
    readonly path?: PathInput
    readonly field?: string
    readonly cause?: unknown
  }

  const build = <C extends FsCode>(code: C, operation: string, details?: Details): VfsError & { readonly code: C } =>
    makeError({
      code,
      operation,
      field: details?.field,
      path: details?.path === undefined ? undefined : errorPath(details.path),
      cause: details?.cause
    })

  /** @internal */
  export const argumentFailure = (operation: string, field: string, cause?: unknown): ArgumentFailure =>
    build("InvalidArgument", operation, { field, cause })

  /** @internal */
  export const decodeConfiguration = <A, I>(
    schema: Schema.Codec<A, I>,
    value: typeof Schema.Unknown.Type,
    operation: string
  ): Result.Result<A, ArgumentFailure> =>
    Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(value).pipe(
      Result.mapError((error) => argumentFailure(operation, configurationField(error.issue), error))
    )

  /** @internal */
  export const fsFailure = (code: FsCode, operation: string, details?: Details): FsFailure =>
    build(code, operation, details)

  /** @internal */
  export interface OpContext {
    readonly operation: string
    readonly fail: (code: FsCode, details?: { readonly cause?: unknown; readonly field?: string }) => FsFailure
    readonly at: (path: PathInput) => OpContext
  }

  const makeOpContext = (operation: string, located?: PathInput): OpContext => ({
    operation,
    fail: (code, details) =>
      fsFailure(code, operation, located === undefined ? details : { ...details, path: located }),
    at: (path) =>
      makeOpContext(operation, Predicate.isString(path) || BytePathStorage.isBytePath(path) ? path : undefined)
  })

  /** @internal */
  export const OpContext = {
    make: (operation: string): OpContext => makeOpContext(operation)
  }
}

const { argumentFailure, decodeConfiguration, errorPath, fsFailure, OpContext } = Errors

type OpContext = Errors.OpContext

/** Byte-name rules and filesystem lookup preparation. @internal */
export namespace Paths {
  /** @internal */
  export const SLASH_HEX = "2f"
  /** @internal */
  export const DOT_HEX = "2e"
  /** @internal */
  export const DOT_DOT_HEX = "2e2e"
  /** @internal */
  export const SLASH_BYTE = 47
  const DOT_BYTE = 46
  /** @internal */
  export const NUL_BYTE = 0
  /** @internal */
  export const MAX_SYMLINK_TRAVERSALS = 40
  /** @internal */
  export const MAX_NAME_BYTES = 255

  /** @internal */
  export const isNameBytes = (name: Uint8Array): boolean =>
    name.length >= 1 && name.length <= MAX_NAME_BYTES && !name.includes(NUL_BYTE) && !name.includes(SLASH_BYTE) &&
    !(name.length === 1 && name[0] === DOT_BYTE) && !(name.length === 2 && name[0] === DOT_BYTE && name[1] === DOT_BYTE)

  /** @internal */
  export const ROOT_PATH = new Uint8Array([SLASH_BYTE])

  /** @internal */
  export const joinPath = (prefix: Uint8Array, name: Uint8Array): Uint8Array => {
    const separator = prefix.length === 0 || prefix[prefix.length - 1] === SLASH_BYTE ? 0 : 1
    const joined = new Uint8Array(prefix.length + separator + name.length)
    joined.set(prefix)

    if (separator === 1) joined[prefix.length] = SLASH_BYTE
    joined.set(name, prefix.length + separator)

    return joined
  }

  // A missing final component follows the same rejection path as "." and ".."; callers choose the POSIX error code.
  /** @internal */
  export const isDotComponent = (name: string | undefined): name is undefined | typeof DOT_HEX | typeof DOT_DOT_HEX =>
    name === undefined || name === DOT_HEX || name === DOT_DOT_HEX

  /** @internal */
  export const ownedPath = (bytes: Uint8Array): BytePath => BytePathStorage.make(bytes)

  /** @internal */
  export const strictString = (bytes: Uint8Array, operation: string) =>
    Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      catch: () => fsFailure("UnrepresentableName", operation)
    })

  /** @internal */
  export const nameBytes = (name: string): Uint8Array => Result.getOrThrow(Hex.decode(name))

  // Constructing a view detects detached buffers, including empty ones.
  const attachedBuffer = (bytes: Uint8Array): boolean => {
    try {
      const probe = new Uint8Array(bytes.buffer, bytes.byteOffset, 0)

      return probe.byteLength === 0
    } catch (error) {
      if (error instanceof TypeError) return false
      throw error
    }
  }

  // Reject shared or detached buffers before copying; Buffer subclasses remain valid.
  /** @internal */
  export const isAttachedBytes = (bytes: Uint8Array): boolean =>
    Predicate.isUint8Array(bytes) && bytes.buffer instanceof ArrayBuffer && attachedBuffer(bytes)

  /** @internal */
  export const pathFromBytes = Effect.fnUntraced(function*(bytes: Uint8Array) {
    if (!isAttachedBytes(bytes)) return yield* fsFailure("InvalidArgument", "pathFromBytes")
    const owned = new Uint8Array(bytes)

    if (owned.length === 0 || owned.includes(0)) {
      return yield* fsFailure("InvalidArgument", "pathFromBytes")
    }

    return BytePathStorage.make(owned)
  })

  /** @internal */
  export const pathToBytes = Effect.fnUntraced(function*(path: BytePath) {
    const bytes = BytePathStorage.getBytes(path)

    if (bytes === undefined) return yield* fsFailure("InvalidArgument", "pathToBytes")

    return new Uint8Array(bytes)
  })

  /** @internal */
  export interface PreparedPath {
    readonly input: PathInput
    readonly absolute: boolean
    readonly trailingSlash: boolean
    readonly bytes: Uint8Array
    readonly suffixes: ReadonlyArray<Uint8Array>
    readonly components: ReadonlyArray<string>
  }

  // String.prototype.isWellFormed requires ES2024; this package targets ES2023.
  /** @internal */
  export const isWellFormed = (value: string): boolean => {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)

      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++index)

        if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      } else if (code >= 0xdc00 && code <= 0xdfff) return false
    }

    return true
  }

  const UTF8_ENCODER = new TextEncoder()

  /** @internal */
  export const inputBytes = (input: PathInput): Result.Result<Uint8Array, "InvalidPathEncoding" | "InvalidArgument"> =>
    Predicate.isString(input)
      ? isWellFormed(input) ? Result.succeed(UTF8_ENCODER.encode(input)) : Result.fail("InvalidPathEncoding")
      : Result.fromNullishOr(BytePathStorage.getBytes(input), () => "InvalidArgument" as const)

  /** @internal */
  export const preparePath = (
    input: PathInput,
    operation: string,
    maxPathBytes: ByteSize.ByteSize | undefined
  ): Result.Result<PreparedPath, FsFailure> => {
    const encoded = inputBytes(input)

    if (Result.isFailure(encoded)) {
      return Result.fail(
        encoded.failure === "InvalidPathEncoding"
          ? fsFailure("InvalidPathEncoding", operation, { path: input })
          : fsFailure("InvalidArgument", operation)
      )
    }

    const bytes = encoded.success

    if (bytes.length === 0) return Result.fail(fsFailure("NotFound", operation, { path: input }))

    if (bytes.includes(0)) return Result.fail(fsFailure("InvalidArgument", operation, { path: input }))

    if (maxPathBytes !== undefined && ByteSize.isGreaterThan(ByteSize.bytes(bytes.length), maxPathBytes)) {
      return Result.fail(fsFailure("PathTooLong", operation, { path: input }))
    }

    const components: Array<string> = []
    const suffixes: Array<Uint8Array> = []
    let start = 0

    for (let index = 0; index <= bytes.length; index++) {
      if (index !== bytes.length && bytes[index] !== SLASH_BYTE) continue

      if (index > start) {
        if (index - start > MAX_NAME_BYTES) {
          return Result.fail(fsFailure("PathTooLong", operation, { path: input }))
        }

        components.push(Hex.encode(bytes.subarray(start, index)))
        suffixes.push(bytes.subarray(index))
      }

      start = index + 1
    }

    return Result.succeed({
      input,
      absolute: bytes[0] === SLASH_BYTE,
      trailingSlash: bytes.at(-1) === SLASH_BYTE,
      bytes,
      suffixes,
      components
    })
  }
}

const {
  DOT_DOT_HEX,
  DOT_HEX,
  inputBytes,
  isAttachedBytes,
  isDotComponent,
  isWellFormed,
  joinPath,
  MAX_NAME_BYTES,
  MAX_SYMLINK_TRAVERSALS,
  nameBytes,
  ownedPath,
  preparePath,
  SLASH_BYTE,
  SLASH_HEX
} = Paths

type PreparedPath = Paths.PreparedPath

/** @internal */
export interface VolumeTestSeams {
  readonly afterSubscribe: Effect.Effect<void>
  readonly betweenSnapshotAndSummary: Effect.Effect<void>
  // Runs outside the volume gate before each entry is removed recursively.
  readonly beforeTreeRemoval: Effect.Effect<void>
}

/**
 * Read in the caller's fiber, so a test supplies it with `withVolumeTestSeams` on the call under test.
 *
 * @internal
 */
export const VolumeTestSeams: Context.Reference<VolumeTestSeams> = Context.Reference<VolumeTestSeams>(
  "@effect-vfs/core/VolumeTestSeams",
  {
    defaultValue: () => ({
      afterSubscribe: Effect.void,
      betweenSnapshotAndSummary: Effect.void,
      beforeTreeRemoval: Effect.void
    })
  }
)

/** @internal */
export const withVolumeTestSeams = (seams: Partial<VolumeTestSeams>) =>
  Effect.updateService(VolumeTestSeams, (current) => ({
    afterSubscribe: seams.afterSubscribe ?? current.afterSubscribe,
    betweenSnapshotAndSummary: seams.betweenSnapshotAndSummary ?? current.betweenSnapshotAndSummary,
    beforeTreeRemoval: seams.beforeTreeRemoval ?? current.beforeTreeRemoval
  }))

/** @internal */
interface Turnstile {
  readonly withTurn: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

interface Ticket {
  readonly dispatcher: SchedulerDispatcher
  granted: boolean
  wake: (() => void) | undefined
}

// A Semaphore can let a newcomer overtake a scheduled waiter. Transfer ownership before scheduling the oldest waiter.
/** @internal */
const makeTurnstile = (): Turnstile => {
  let held = false
  const waiting: Array<Ticket> = []

  const release = () => {
    const next = waiting.shift()

    if (next === undefined) {
      held = false

      return
    }

    next.granted = true
    next.dispatcher.scheduleTask(() => next.wake?.(), 0)
  }

  const waitFor = (ticket: Ticket) =>
    Effect.callback<void>((resume) => {
      if (ticket.granted) return resume(Effect.void)
      ticket.wake = () => resume(Effect.void)
    })

  return {
    // Check ticket ownership after interruption so a granted turn is released rather than stranded.
    withTurn: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.withFiber((fiber) => {
          const run = Effect.ensuring(restore(effect), Effect.sync(release))

          if (!held) {
            held = true

            return run
          }

          const ticket: Ticket = { dispatcher: fiber.currentDispatcher, granted: false, wake: undefined }
          waiting.push(ticket)

          return Effect.flatMap(Effect.exit(restore(waitFor(ticket))), (waited): Effect.Effect<A, E, R> => {
            if (Exit.isSuccess(waited)) return run

            if (ticket.granted) release()
            else waiting.splice(waiting.indexOf(ticket), 1)

            return Effect.failCause(waited.cause)
          })
        })
      )
  }
}

type CommitOutcome = "committed" | "rejected" | "unknown" | {
  readonly _tag: "Rejected"
  readonly cause: Cause.Cause<never>
}

/** Private addressing; the public Target module is a compatibility view. @internal */
export namespace Address {
  /**
   * How a caller names what it operates on. A `Target` is a path, an object
   * reference, or an open handle; an `Entry` is a child of a directory target
   * called `name`. Every verb takes one or the other, so the three addressing
   * modes share one body and one option vocabulary.
   *
   * @since 0.6.0
   */

  /**
   * A target: a path resolved from the caller's working directory or a base
   * handle, an object reference, or an open handle.
   *
   * @category models
   * @since 0.6.0
   */
  export type Target = Data.TaggedEnum<{
    readonly Path: {
      readonly path: PathInput
      /** A live directory handle from the same volume that a relative path starts from. */
      readonly relativeTo?: DirectoryHandle
      /** Whether a final symbolic link is followed. Defaults to `true`. */
      readonly followFinalSymlink?: boolean
    }
    readonly Reference: { readonly reference: ObjectReference }
    readonly Handle: { readonly handle: FileHandle | DirectoryHandle }
  }>

  const isFileHandle = (value: unknown): value is FileHandle =>
    Predicate.hasProperty(FileHandleId)(value) && value[FileHandleId] === true

  const isDirectoryHandle = (value: unknown): value is DirectoryHandle =>
    Predicate.hasProperty(DirectoryHandleId)(value) && value[DirectoryHandleId] === true

  const enumeration = Data.taggedEnum<Target>()

  /**
   * Whether a value is a `Target`.
   *
   * @category predicates
   * @since 0.6.0
   */
  export const isTarget = (value: unknown): value is Target =>
    Predicate.isTagged("Path")(value) || Predicate.isTagged("Reference")(value) || Predicate.isTagged("Handle")(value)

  /**
   * Anything a verb accepts where it takes a target: a `Target`, or the bare
   * path, reference, or handle it would wrap.
   *
   * @category models
   * @since 0.6.0
   */
  export type TargetInput = Target | PathInput | ObjectReference | FileHandle | DirectoryHandle

  /**
   * Constructors and matchers for `Target`, plus `of`, which wraps a bare path,
   * reference, or handle.
   *
   * @category constructors
   * @since 0.6.0
   */
  export const Target: typeof enumeration & { readonly of: (input: TargetInput) => Target } = {
    Path: enumeration.Path,
    Reference: enumeration.Reference,
    Handle: enumeration.Handle,
    $is: enumeration.$is,
    $match: enumeration.$match,
    // A string or byte path is a path and a handle is a handle; anything else is taken for a reference, so a forged
    // token reaches the registry and is reported as one.
    of: (input) => {
      if (isTarget(input)) return input

      if (isFileHandle(input) || isDirectoryHandle(input)) return enumeration.Handle({ handle: input })

      if (Predicate.isString(input) || BytePathStorage.isBytePath(input)) return enumeration.Path({ path: input })

      return enumeration.Reference({ reference: input })
    }
  }

  /**
   * A directory entry name as bytes or as a string encoded as UTF-8: one to 255
   * bytes with no NUL and no slash. `.` and `..` are well formed but reserved.
   *
   * @category models
   * @since 0.6.0
   */
  export type NameInput = string | Uint8Array

  /**
   * Schema for a well-formed entry name, as bytes.
   *
   * @category schemas
   * @since 0.6.0
   */
  export const Name = Schema.Uint8Array.check(
    Schema.makeFilter((bytes) =>
      bytes.length === 0
        ? "must not be empty"
        : bytes.length > 255
        ? "must be at most 255 bytes"
        : bytes.includes(0)
        ? "must not contain NUL"
        : bytes.includes(0x2f)
        ? "must not contain a slash"
        : undefined
    )
  )

  /**
   * A well-formed entry name, as bytes.
   *
   * @category models
   * @since 0.6.0
   */
  export type Name = typeof Name.Type

  /**
   * A child of a directory target, called `name`.
   *
   * @category models
   * @since 0.6.0
   */
  export interface Entry {
    readonly directory: Target
    readonly name: NameInput
  }

  /**
   * Anything a verb accepts where it takes an entry: an `Entry`, or a path (bare
   * or as a path target with a base) whose final component is the name and
   * whose prefix is the directory.
   *
   * @category models
   * @since 0.6.0
   */
  export type EntryInput = Entry | PathInput | PathTarget

  /**
   * The path variant of `Target`.
   *
   * @category models
   * @since 0.6.0
   */
  export type PathTarget = Extract<Target, { readonly _tag: "Path" }>

  /**
   * Whether a value is an `Entry`.
   *
   * @category predicates
   * @since 0.6.0
   */
  export const isEntry = (value: unknown): value is Entry =>
    Predicate.hasProperty(value, "directory") && Predicate.hasProperty(value, "name") && isTarget(value.directory)

  /**
   * Names a child of a directory. The directory may be given bare.
   *
   * @example
   * ```ts
   * import { Entry, Target } from "@effect-vfs/core/Target"
   *
   * const explicit = Entry(Target.Path({ path: "/var" }), "log")
   * const bare = Entry("/var", "log")
   * ```
   *
   * @category constructors
   * @since 0.6.0
   */
  export const Entry: {
    (name: NameInput): (directory: TargetInput) => Entry
    (directory: TargetInput, name: NameInput): Entry
  } = dual(2, (directory: TargetInput, name: NameInput): Entry => ({ directory: Target.of(directory), name }))

  /**
   * Whether a path input is a byte path rather than a string.
   *
   * @category predicates
   * @since 0.6.0
   */
  export const isBytePathInput = (input: PathInput): boolean => BytePathStorage.isBytePath(input)
}

const isTarget = Address.isTarget

const Target = Address.Target

const isEntry = Address.isEntry

type Target = Address.Target

type TargetInput = Address.TargetInput

type NameInput = Address.NameInput

type Entry = Address.Entry

type EntryInput = Address.EntryInput

/**
 * Brand key that marks an object reference.
 *
 * @category type IDs
 * @since 0.6.0
 */
export const ObjectReferenceId: unique symbol = Symbol.for("@effect-vfs/core/ObjectReference")

/**
 * Brand key that marks an object reference.
 *
 * @category type IDs
 * @since 0.6.0
 */
export type ObjectReferenceId = typeof ObjectReferenceId

/**
 * Schema for a caller's credentials. `privileged` is explicit; uid zero alone
 * grants nothing.
 *
 * @category schemas
 * @since 0.6.0
 */
export const Identity = Schema.Struct({
  uid: Schema.Natural,
  gid: Schema.Natural,
  groups: Schema.Array(Schema.Natural),
  privileged: Schema.Boolean
})

/**
 * A caller's credentials.
 *
 * @category models
 * @since 0.6.0
 */
export type Identity = typeof Identity.Type

/**
 * Schema for the options of a root caller.
 *
 * @category schemas
 * @since 0.6.0
 */
export const RootCallerOptions = Schema.Struct({
  identity: Schema.optionalKey(Identity),
  umask: Schema.optionalKey(Schema.Natural.check(Schema.isLessThanOrEqualTo(0o777)))
})

/**
 * Options of a root caller.
 *
 * @category models
 * @since 0.6.0
 */
export type RootCallerOptions = typeof RootCallerOptions.Type

/**
 * Schema for the options of `open` on a target: the access mode, whether a
 * missing file is created, the creation mode, and append and truncate flags.
 *
 * @category schemas
 * @since 0.6.0
 */
export const OpenOptions = Schema.Struct({
  access: Schema.Literals(["read", "write", "readWrite"]),
  create: Schema.optionalKey(Schema.Literals(["never", "ifMissing", "exclusive"])),
  mode: Schema.optionalKey(Mode),
  append: Schema.optionalKey(Schema.Boolean),
  truncate: Schema.optionalKey(Schema.Boolean)
})

/**
 * Options of `open` on a target.
 *
 * @category models
 * @since 0.6.0
 */
export type OpenOptions = typeof OpenOptions.Type

/**
 * Schema for the options of `writeFile`: the open options plus whether a
 * final symbolic link is replaced or followed and the mode the file ends with.
 *
 * @category schemas
 * @since 0.6.0
 */
export const WriteFileOptions = Schema.Struct({
  ...OpenOptions.fields,
  followFinalSymlink: Schema.optionalKey(Schema.Boolean),
  replaceFinalSymlink: Schema.optionalKey(Schema.Boolean),
  finalMode: Schema.optionalKey(Mode)
})

/**
 * Options of `writeFile`.
 *
 * @category models
 * @since 0.6.0
 */
export type WriteFileOptions = typeof WriteFileOptions.Type

/**
 * Schema for a directory's revision before and after a change.
 *
 * @category schemas
 * @since 0.6.0
 */
export const DirectoryChange = Schema.Struct({
  before: Schema.BigInt,
  after: Schema.BigInt
})

/**
 * A directory's revision before and after a change.
 *
 * @category models
 * @since 0.6.0
 */
export type DirectoryChange = typeof DirectoryChange.Type

/**
 * Schema for the result of `rename`.
 *
 * @category schemas
 * @since 0.6.0
 */
export const RenameReferenceResult = Schema.TaggedUnion({
  SameDirectory: { directory: DirectoryChange },
  DifferentDirectories: {
    sourceDirectory: DirectoryChange,
    destinationDirectory: DirectoryChange
  }
})

/**
 * The result of `rename`.
 *
 * @category models
 * @since 0.6.0
 */
export type RenameReferenceResult = typeof RenameReferenceResult.Type

/**
 * Schema for the options of `mkdir`. `exactMode` skips the caller's umask for
 * an explicit creation mode; permission policy still applies. `recursive`
 * creates every missing directory on the path in one change, as `mkdir -p`
 * does, and succeeds when the final directory already exists; the mode
 * applies to every directory it creates and the times to the final one.
 *
 * @category schemas
 * @since 0.6.0
 */
export const MkdirOptions = Schema.Struct({
  mode: Schema.optionalKey(Mode),
  exactMode: Schema.optionalKey(Schema.Boolean),
  times: Schema.optionalKey(Times),
  recursive: Schema.optionalKey(Schema.Boolean)
})

/**
 * Options of `mkdir`.
 *
 * @category models
 * @since 0.6.0
 */
export type MkdirOptions = typeof MkdirOptions.Type

/**
 * Schema for the options of `walk`: the order entries arrive in and the
 * optional bounds on how deep, how many, and how many bytes the walk may
 * reach. `order` defaults to `"pre"`, each directory before its entries; a
 * `"post"` walk reports each directory after them. Every bound defaults to
 * unbounded, and a walk that would pass one fails with `LimitExceeded` naming
 * the bound in `field`.
 *
 * @category schemas
 * @since 0.6.0
 */
export const WalkOptions = Schema.Struct({
  order: Schema.optionalKey(Schema.Literals(["pre", "post"])),
  maxDepth: Schema.optionalKey(Schema.Natural),
  maxEntries: Schema.optionalKey(Schema.Natural),
  maxBytes: Schema.optionalKey(Schema.ByteSize)
})

/**
 * Options of `walk`.
 *
 * @category models
 * @since 0.6.0
 */
export type WalkOptions = typeof WalkOptions.Type

/**
 * Schema for the options of `remove`. `recursive` removes a directory and
 * everything under it; `force` succeeds when the target itself is missing.
 * `expected` pins object identity at each coordinated removal stage. A replacement fails `VolumeBusy`.
 *
 * @category schemas
 * @since 0.6.0
 */
export const RemoveOptions = Schema.Struct({
  recursive: Schema.optionalKey(Schema.Boolean),
  force: Schema.optionalKey(Schema.Boolean),
  expected: Schema.optionalKey(Schema.suspend(() => ObjectReferenceSchema))
})

/**
 * Options of `remove`.
 *
 * @category models
 * @since 0.6.0
 */
export type RemoveOptions = typeof RemoveOptions.Type

/**
 * Schema for the options of `symlink`.
 *
 * @category schemas
 * @since 0.6.0
 */
export const SymlinkOptions = Schema.Struct({
  times: Schema.optionalKey(Times)
})

/**
 * Options of `symlink`.
 *
 * @category models
 * @since 0.6.0
 */
export type SymlinkOptions = typeof SymlinkOptions.Type

/**
 * Schema for the attributes `setattr` changes together: a regular file's
 * size, the permission mode, the owner, and the access and modification
 * times. An omitted attribute keeps its current value. `expected` pins the
 * target's revision the caller last observed, checked inside the same change,
 * and fails as `StaleReference` naming `expected` when the target has moved
 * on, so a change decided from that observation never applies to a newer one.
 *
 * @category schemas
 * @since 0.6.0
 */
export const SetattrOptions = Schema.Struct({
  size: Schema.optionalKey(Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  mode: Schema.optionalKey(Mode),
  owner: Schema.optionalKey(OwnerUpdate),
  times: Schema.optionalKey(Times),
  expected: Schema.optionalKey(Schema.Struct({ revision: Schema.BigInt }))
})

/**
 * Attributes of `setattr`.
 *
 * @category models
 * @since 0.6.0
 */
export type SetattrOptions = typeof SetattrOptions.Type

/**
 * Schema for an object reference: any value carrying the reference brand. Whether the volume issued it is checked
 * where it is used.
 *
 * @internal
 */
export const ObjectReferenceSchema = Schema.declare<ObjectReference>((input): input is ObjectReference =>
  Predicate.hasProperty(ObjectReferenceId)(input) && input[ObjectReferenceId] === true
)

/**
 * Schema for the options of `open` on an entry, a lookup-or-create-and-open in
 * one gate hold. `expected` pins the child the caller last observed under the
 * name (or `null` for none) and fails as `VolumeBusy` when another has
 * appeared; `expectedChild` pins its revision and times as well and fails as
 * `StaleReference` when they moved.
 *
 * @category schemas
 * @since 0.6.0
 */
export const OpenEntryOptions = Schema.Struct({
  ...OpenOptions.fields,
  followFinalSymlink: Schema.optionalKey(Schema.Boolean),
  times: Schema.optionalKey(Times),
  initialSize: Schema.optionalKey(Schema.BigInt),
  exactMode: Schema.optionalKey(Schema.Boolean),
  owner: Schema.optionalKey(OwnerUpdate),
  expected: Schema.optionalKey(Schema.NullOr(ObjectReferenceSchema)),
  expectedChild: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    reference: ObjectReferenceSchema,
    revision: Schema.BigInt,
    atimeNs: Timestamp,
    mtimeNs: Timestamp
  })))
})

/**
 * Options of `open` on an entry.
 *
 * @category models
 * @since 0.6.0
 */
export type OpenEntryOptions = typeof OpenEntryOptions.Type

/** State shared with community codecs through the legacy volumeState view. @internal */
export namespace State {
  // An inode number: monotonic within a volume, never reused, and persisted by the snapshot and the live image. A
  // safe-integer bound keeps allocation exact; public metadata reports the number as a bigint.
  /** @internal */
  export type Ino = number & Brand.Brand<"@effect-vfs/core/Ino">

  /** @internal */
  export const Ino = Brand.nominal<Ino>()

  /** @internal */
  export const ROOT_INO = Ino(1)

  // The largest inode number a value holds. The allocator resumes one above it and must stay exactly representable,
  // since the inode table is keyed by a number.
  /** @internal */
  export const MAX_INO = Number.MAX_SAFE_INTEGER - 1

  // File sizes fit an unsigned 32-bit count in the volume and its public options.
  /** @internal */
  export const MAX_FILE_BYTES = 0xffffffff

  // Nodes walked between yields. Whole-tree reads are one synchronous tick otherwise, which
  // starves the event loop and leaves nothing for interruption to act on.
  /** @internal */
  export const WALK_YIELD_INTERVAL = 128

  /** @internal */
  export interface Link {
    readonly parent: Ino
    readonly name: string
  }

  /** @internal */
  export type NodeMetadata = Omit<Metadata, "revision">

  /** @internal */
  export interface Directory {
    readonly kind: "directory"
    readonly ino: Ino
    // Directories have one name; a detached directory keeps its last one and reads as unnamed through nlink 0.
    readonly parent: Ino
    readonly name: string
    readonly entries: ReadonlyMap<string, Ino>
    readonly metadata: NodeMetadata
    readonly revision: bigint
  }

  /** @internal */
  export interface RegularFile {
    readonly kind: "file"
    readonly ino: Ino
    readonly data: Uint8Array
    readonly links: ReadonlyArray<Link>
    readonly metadata: NodeMetadata
    readonly revision: bigint
  }

  /** @internal */
  export interface SymbolicLink {
    readonly kind: "symlink"
    readonly ino: Ino
    readonly target: Uint8Array
    readonly links: ReadonlyArray<Link>
    readonly metadata: NodeMetadata
    readonly revision: bigint
  }

  /** @internal */
  export type Node = Directory | RegularFile | SymbolicLink

  /** @internal */
  export interface VolumeState {
    readonly inodes: HashMap.HashMap<Ino, Node>
    // Handles holding a file open; an unlinked file stays in the table, and in the live image, while any does.
    readonly open: ReadonlyMap<Ino, number>
    readonly nextInode: Ino
    readonly revision: bigint
    readonly entries: number
    readonly usedBytes: bigint
  }

  /** @internal */
  export const getNode = (state: VolumeState, ino: Ino): Node | undefined =>
    Option.getOrUndefined(HashMap.get(state.inodes, ino))

  // Only filesystem-owned records enter this boundary. Identity equality keeps a metadata update from hashing
  // shared file bytes or directory contents; nested payloads and public metadata retain their value semantics.
  /** @internal */
  export const setNode = (inodes: HashMap.HashMap<Ino, Node>, node: Node): HashMap.HashMap<Ino, Node> =>
    HashMap.set(inodes, node.ino, Equal.byReferenceUnsafe(node))

  /** @internal */
  export const byIno = Order.mapInput(Order.Number, (node: Node) => node.ino)

  /** @internal */
  export const byEntryName = Order.mapInput(Order.String, ([name]: readonly [string, Ino]) => name)

  const inNameOrder = (entries: ReadonlyMap<string, Ino>) => {
    let previous: string | undefined

    for (const name of entries.keys()) {
      if (previous !== undefined && previous > name) return false
      previous = name
    }

    return true
  }

  export const inEntryOrder = (directory: Directory): Directory =>
    inNameOrder(directory.entries)
      ? directory
      : { ...directory, entries: new Map([...directory.entries].sort(byEntryName)) }

  /** @internal */
  export const payloadOf = (node: Node): Uint8Array | undefined =>
    node.kind === "file" ? node.data : node.kind === "symlink" ? node.target : undefined

  /** @internal */
  export const directoryMetadata = (
    ino: bigint,
    uid: number,
    gid: number,
    mode: number,
    now: bigint
  ): NodeMetadata => ({
    kind: "directory",
    ino,
    uid,
    gid,
    mode,
    nlink: 2,
    size: 0n,
    atimeNs: now,
    mtimeNs: now,
    ctimeNs: now,
    birthtimeNs: now
  })

  /** @internal */
  export const pathOf = (get: (ino: Ino) => Node | undefined, ino: Ino): string | undefined => {
    const names: Array<string> = []
    let node = get(ino)

    if (node?.kind !== "directory" || node.metadata.nlink === 0) return undefined

    while (node.ino !== ROOT_INO) {
      names.push(node.name)
      const parent = get(node.parent)

      if (parent?.kind !== "directory" || parent.metadata.nlink === 0) return undefined
      node = parent
    }

    return SLASH_HEX + names.reverse().join(SLASH_HEX)
  }

  /** @internal */
  export const entryPath = (prefix: string, name: string) =>
    ownedPath(nameBytes(prefix + (prefix === SLASH_HEX ? "" : SLASH_HEX) + name))

  /** @internal */
  export const emptyRoot = (now: bigint): Directory => ({
    kind: "directory",
    ino: ROOT_INO,
    parent: ROOT_INO,
    name: "",
    entries: new Map(),
    metadata: directoryMetadata(BigInt(ROOT_INO), 0, 0, 0o755, now),
    revision: 1n
  })

  /** @internal */
  export const emptyState = (now: bigint): VolumeState => ({
    inodes: setNode(HashMap.empty<Ino, Node>(), emptyRoot(now)),
    open: new Map(),
    nextInode: Ino(2),
    revision: 1n,
    entries: 0,
    usedBytes: 0n
  })
}

const Ino = State.Ino

const ROOT_INO = State.ROOT_INO
const MAX_FILE_BYTES = State.MAX_FILE_BYTES
const WALK_YIELD_INTERVAL = State.WALK_YIELD_INTERVAL

const { entryPath, pathOf } = State

const getNode = State.getNode

const setNode = State.setNode

const byEntryName = State.byEntryName

const directoryMetadata = State.directoryMetadata

const emptyState = State.emptyState

type Ino = State.Ino

type Link = State.Link

type NodeMetadata = State.NodeMetadata

type Directory = State.Directory

type RegularFile = State.RegularFile

type SymbolicLink = State.SymbolicLink

type Node = State.Node

type VolumeState = State.VolumeState

/** Persistent name/slot representation belongs to this engine. @internal */
namespace DirectoryEntries {
  interface Entry {
    readonly name: string
    readonly ino: Ino
    readonly index: number
  }

  // Name lookup and insertion order share immutable trees. Deleted slots are compacted once they outnumber live entries.
  class DirectoryEntries implements ReadonlyMap<string, Ino> {
    readonly [Symbol.toStringTag] = "Map"

    constructor(
      readonly names: HashMap.HashMap<string, Entry>,
      readonly slots: HashMap.HashMap<number, Entry>,
      readonly length: number
    ) {}

    get size(): number {
      return HashMap.size(this.names)
    }

    get(name: string): Ino | undefined {
      const slot = HashMap.get(this.names, name)

      return Option.isSome(slot) ? slot.value.ino : undefined
    }

    has(name: string): boolean {
      return HashMap.has(this.names, name)
    }

    *entries(): IterableIterator<[string, Ino]> {
      for (let index = 0; index < this.length; index++) {
        const entry = Option.getOrUndefined(HashMap.get(this.slots, index))

        if (entry !== undefined) yield [entry.name, entry.ino]
      }
    }

    *keys(): IterableIterator<string> {
      for (const [name] of this) yield name
    }

    *values(): IterableIterator<Ino> {
      for (const [, ino] of this) yield ino
    }

    [Symbol.iterator](): IterableIterator<[string, Ino]> {
      return this.entries()
    }

    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- ReadonlyMap forwards the opaque callback receiver without inspecting it.
    forEach(callback: (value: Ino, key: string, map: ReadonlyMap<string, Ino>) => void, thisArg?: unknown): void {
      for (const [name, ino] of this) callback.call(thisArg, ino, name, this)
    }
  }

  const fromEntries = (entries: ReadonlyMap<string, Ino>): DirectoryEntries => {
    const slots = HashMap.beginMutation(HashMap.empty<number, Entry>())
    let length = 0

    const names = HashMap.mutate(HashMap.empty<string, Entry>(), (mutable) => {
      for (const [name, ino] of entries) {
        const entry = { name, ino, index: length }
        HashMap.set(mutable, name, entry)
        HashMap.set(slots, length, entry)
        length++
      }
    })

    return new DirectoryEntries(names, HashMap.endMutation(slots), length)
  }

  /** @internal */
  export const set = (entries: ReadonlyMap<string, Ino>, name: string, ino: Ino): ReadonlyMap<string, Ino> => {
    const current = entries instanceof DirectoryEntries ? entries : fromEntries(entries)
    const existing = HashMap.get(current.names, name)
    const index = Option.isSome(existing) ? existing.value.index : current.length

    const entry = { name, ino, index }

    return new DirectoryEntries(
      HashMap.set(current.names, name, entry),
      HashMap.set(current.slots, index, entry),
      Option.isSome(existing) ? current.length : current.length + 1
    )
  }

  /** @internal */
  export const remove = (entries: ReadonlyMap<string, Ino>, name: string): ReadonlyMap<string, Ino> => {
    const current = entries instanceof DirectoryEntries ? entries : fromEntries(entries)
    const existing = HashMap.get(current.names, name)

    if (Option.isNone(existing)) return current

    const removed = new DirectoryEntries(
      HashMap.remove(current.names, name),
      HashMap.remove(current.slots, existing.value.index),
      current.length
    )

    return removed.length > removed.size * 2 ? fromEntries(removed) : removed
  }

  // Full directory observations already materialize every entry. Populate indices once instead of hashing every
  // slot lookup; lazy iterators above keep their incremental traversal for bounded snapshot/search consumers.
  /** @internal */
  export const toArray = (entries: ReadonlyMap<string, Ino>): Array<[string, Ino]> => {
    // Larger logical indices are not array elements; retain the incremental fallback for that domain.
    if (!(entries instanceof DirectoryEntries) || entries.length > 0xffffffff) return Array.from(entries)
    const ordered: Array<[string, Ino] | undefined> = []
    HashMap.forEach(entries.slots, (entry) => {
      ordered[entry.index] = [entry.name, entry.ino]
    })

    return ordered.filter((entry) => entry !== undefined)
  }
}

/** @internal */
export namespace TokenRegistry {
  /** @internal */
  export type HandleLifecycle =
    | { readonly kind: "acquiring" }
    | { readonly kind: "open"; readonly ino: Ino }
    // Cleanup ran before acquisition published. A late publication still needs a release.
    | { readonly kind: "releasedPendingCommit"; readonly ino: Ino | undefined }
    | { readonly kind: "closed" }

  /** @internal */
  export interface HandleReference {
    readonly volume: symbol
    lifecycle: HandleLifecycle
    namespaceRoots?: ReadonlyArray<Ino> | undefined
    boundaries?: ReadonlyArray<ReadonlyArray<Ino>> | undefined
    authority?: ((node: Node, op: OpContext) => Effect.Effect<void, FsFailure>) | undefined
    scope: Scope.Closeable | undefined
  }

  /** @internal */
  export interface FileReference extends HandleReference {
    offset: bigint
    readonly access: "read" | "write" | "readWrite"
    readonly append: boolean
  }

  /** @internal */
  export type DirectoryReference = HandleReference

  /** @internal */
  export type Token = ObjectReference | FileHandle | DirectoryHandle

  interface ReferenceState {
    readonly volume: symbol
    readonly ino: Ino
  }

  // Shared across volumes so a genuine token from another registry is distinguishable from a forgery.
  const references = new WeakMap<object, ReferenceState>()

  const files = new WeakMap<object, FileReference>()

  const directories = new WeakMap<object, DirectoryReference>()

  /** @internal */
  export type Resolution =
    | { readonly kind: "unknown" }
    | { readonly kind: "foreign" }
    | { readonly kind: "stale" }
    | { readonly kind: "live"; readonly node: Node }

  /** @internal */
  export const inode = (reference: HandleReference): Ino | undefined =>
    reference.lifecycle.kind === "open" || reference.lifecycle.kind === "releasedPendingCommit"
      ? reference.lifecycle.ino
      : undefined

  /** @internal */
  export const isOpen = (reference: HandleReference): boolean => reference.lifecycle.kind === "open"

  /** @internal */
  export const publish = (reference: HandleReference, ino: Ino): void => {
    reference.lifecycle = reference.lifecycle.kind === "releasedPendingCommit" || reference.lifecycle.kind === "closed"
      ? { kind: "releasedPendingCommit", ino }
      : { kind: "open", ino }
  }

  /** @internal */
  export const released = (reference: HandleReference): void => {
    reference.lifecycle = reference.lifecycle.kind === "acquiring" ||
        (reference.lifecycle.kind === "releasedPendingCommit" && reference.lifecycle.ino === undefined)
      ? { kind: "releasedPendingCommit", ino: undefined }
      : { kind: "closed" }
  }

  // A release callback changes the engine's draft; publication may be immediate cleanup or after installation.
  /** @internal */
  export const release = Effect.fnUntraced(function*<E, R>(
    reference: HandleReference,
    releaseInode: (ino: Ino) => Effect.Effect<void, E, R>,
    afterRelease: (action: () => void) => Effect.Effect<void, never, R>
  ) {
    const ino = inode(reference)

    yield* afterRelease(() => released(reference))

    if (ino !== undefined) yield* releaseInode(ino)
  })

  /** @internal */
  export const closeReleasedScope = (reference: HandleReference) =>
    Effect.suspend(() =>
      isOpen(reference) || reference.scope === undefined ? Effect.void : Scope.close(reference.scope, Exit.void)
    )

  // The inode, rather than the open tag, decides whether a rerun must release a late publication.
  /** @internal */
  export const finalize = (
    reference: HandleReference,
    close: Effect.Effect<unknown, FsFailure>,
    fallback: Effect.Effect<void>
  ) =>
    Effect.uninterruptible(Effect.suspend(() => {
      if (inode(reference) === undefined) {
        // Check and mark together: acquisition can publish between separate Effect steps.
        released(reference)

        return Effect.void
      }

      return Effect.ignore(close).pipe(
        Effect.andThen(Effect.suspend(() => inode(reference) === undefined ? Effect.void : fallback))
      )
    }))

  // Register before waiting: a closed scope runs its finalizer immediately, and engine permits are not reentrant.
  /** @internal */
  export const acquire = Effect.fnUntraced(function*<A, E, R, ReleaseR, CoordinateR>(
    reference: HandleReference,
    coordinate: (acquire: Effect.Effect<A, E, R | ReleaseR>) => Effect.Effect<A, E | FsFailure, CoordinateR>,
    acquisition: Effect.Effect<A, E, R>,
    releaseAcquired: () => Effect.Effect<void, never, ReleaseR>,
    finalizer: Effect.Effect<void>
  ) {
    const scope = yield* Scope.fork(yield* Effect.scope)
    reference.scope = scope
    yield* Scope.addFinalizer(scope, finalizer)
    const closed = () => Predicate.isTagged(scope.state, "Closed")

    return yield* coordinate(
      Effect.suspend(() => closed() ? Effect.interrupt : acquisition).pipe(
        Effect.tap(() =>
          Effect.suspend(() => closed() ? Effect.andThen(releaseAcquired(), Effect.interrupt) : Effect.void)
        )
      )
    ).pipe(
      Effect.tap(() => Effect.suspend(() => closed() ? Effect.interrupt : Effect.void)),
      Effect.onError(() => Effect.andThen(finalizer, Scope.close(scope, Exit.void))),
      Effect.onError(() =>
        Effect.sync(() => {
          if (reference.lifecycle.kind === "releasedPendingCommit" && reference.lifecycle.ino === undefined) {
            reference.lifecycle = { kind: "closed" }
          }
        })
      )
    )
  })

  /** @internal */
  export const nodeOrFail = (result: Resolution, addressing: "reference" | "handle", op: OpContext) => {
    switch (result.kind) {
      case "live":
        return Effect.succeed(result.node)
      case "unknown":
        return Effect.fail(op.fail(addressing === "reference" ? "InvalidReference" : "InvalidHandle"))
      case "foreign":
        return Effect.fail(op.fail(addressing === "reference" ? "ForeignReference" : "ForeignHandle"))
      case "stale":
        return Effect.fail(op.fail(addressing === "reference" ? "StaleReference" : "InvalidHandle"))
    }
  }

  /** @internal */
  export const make = (volume: symbol, get: (ino: Ino) => Effect.Effect<Node | undefined>) => {
    const tokens = new Map<Ino, ObjectReference>()

    const resolveInode = (ino: Ino): Effect.Effect<Resolution> =>
      Effect.map(
        get(ino),
        (node): Resolution =>
          node === undefined || (node.kind === "directory" && node.metadata.nlink === 0)
            ? { kind: "stale" }
            : { kind: "live", node }
      )

    const resolveReference = (token: Token): Effect.Effect<Resolution> =>
      Effect.suspend(() => {
        const known = Predicate.isObject(token) ? references.get(token) : undefined

        if (known === undefined) return Effect.succeed({ kind: "unknown" } as const)

        if (known.volume !== volume) return Effect.succeed({ kind: "foreign" } as const)

        return resolveInode(known.ino)
      })

    const resolveHandle = (token: Token, directoryOnly = false): Effect.Effect<Resolution> =>
      Effect.suspend(() => {
        const known = Predicate.isObject(token)
          ? directories.get(token) ?? (directoryOnly ? undefined : files.get(token))
          : undefined

        if (known === undefined) return Effect.succeed({ kind: "unknown" } as const)

        if (known.volume !== volume) return Effect.succeed({ kind: "foreign" } as const)

        if (!isOpen(known)) return Effect.succeed({ kind: "stale" } as const)
        const ino = inode(known)

        return ino === undefined
          ? Effect.succeed({ kind: "stale" } as const)
          : Effect.map(get(ino), (node): Resolution => node === undefined ? { kind: "stale" } : { kind: "live", node })
      })

    return {
      referenceIdentity: (token: ObjectReference, op: OpContext): Effect.Effect<Ino, FsFailure> => {
        const known = Predicate.isObject(token) ? references.get(token) : undefined

        if (known === undefined) return Effect.fail(op.fail("InvalidReference"))

        if (known.volume !== volume) return Effect.fail(op.fail("ForeignReference"))

        return Effect.succeed(known.ino)
      },
      handleBoundaries: (token: Token) => (files.get(token) ?? directories.get(token))?.boundaries ?? [],
      authorizeHandle: (token: Token, node: Node, op: OpContext) => {
        const reference = files.get(token) ?? directories.get(token)

        return reference?.authority?.(node, op) ?? Effect.void
      },
      resolve: (token: Token, addressing: "reference" | "handle" | "directory") =>
        addressing === "reference" ? resolveReference(token) : resolveHandle(token, addressing === "directory"),
      resolveInode,
      referenceFor: (ino: Ino): ObjectReference => {
        const existing = tokens.get(ino)

        if (existing !== undefined) return existing
        const reference = Object.freeze({ [ObjectReferenceId]: true as const })
        references.set(reference, { volume, ino })
        tokens.set(ino, reference)

        return reference
      },
      forget: (ino: Ino) => tokens.delete(ino),
      file: (access: FileReference["access"], append: boolean): FileReference => ({
        volume,
        lifecycle: { kind: "acquiring" },
        scope: undefined,
        offset: 0n,
        access,
        append
      }),
      directory: (ino?: Ino): DirectoryReference => ({
        volume,
        lifecycle: ino === undefined ? { kind: "acquiring" } : { kind: "open", ino },
        scope: undefined
      }),
      registerFile: (handle: FileHandle, reference: FileReference) => files.set(handle, reference),
      registerDirectory: (handle: DirectoryHandle, reference: DirectoryReference) => directories.set(handle, reference)
    }
  }

  /** @internal */
  export type TokenRegistry = ReturnType<typeof make>
}

// Only engine-owned sections set this reference; cooperative callers keep explicit walk yields.
const SyncSection = Context.Reference<boolean>("@effect-vfs/core/SyncSection", { defaultValue: () => false })

/** @internal */
namespace Confinement {
  /** @internal */
  export const make = (view: Effect.Effect<(ino: Ino) => Node | undefined>, roots: ReadonlyArray<Ino>) => {
    const descends = Effect.fnUntraced(function*(get: (ino: Ino) => Node | undefined, ino: Ino, root: Ino) {
      let node = get(ino)
      let steps = 0

      while (node?.kind === "directory" && node.metadata.nlink > 0) {
        if (node.ino === root) return true

        if (node.ino === ROOT_INO) return false
        const parent = get(node.parent)

        if (parent?.kind !== "directory" || parent.entries.get(node.name) !== node.ino) return false
        node = parent

        if (++steps % WALK_YIELD_INTERVAL === 0 && !(yield* SyncSection)) yield* Effect.yieldNow
      }

      return false
    })

    const aliveIn = Effect.fnUntraced(function*(get: (ino: Ino) => Node | undefined, op: OpContext, handle: boolean) {
      for (let index = 0; index < roots.length; index++) {
        const root = roots[index]!
        const node = get(root)

        if (node?.kind !== "directory" || node.metadata.nlink === 0) {
          return yield* op.fail(handle ? "InvalidHandle" : "ClosedCaller")
        }

        if (index > 0 && !(yield* descends(get, root, roots[index - 1]!))) return yield* op.fail("AccessDenied")
      }
    })

    const containsIn = Effect.fnUntraced(function*(get: (ino: Ino) => Node | undefined, node: Node) {
      const root = roots.at(-1)

      if (root === undefined) return true

      if (node.kind === "directory") return yield* descends(get, node.ino, root)

      for (const link of node.links) {
        const parent = get(link.parent)

        if (
          parent?.kind === "directory" && parent.entries.get(link.name) === node.ino &&
          (yield* descends(get, parent.ino, root))
        ) return true
      }

      return false
    })

    const alive = (op: OpContext, handle: boolean = false) => Effect.flatMap(view, (get) => aliveIn(get, op, handle))

    const contains = (node: Node) => Effect.flatMap(view, (get) => containsIn(get, node))

    const check = Effect.fnUntraced(
      function*(node: Node, op: OpContext, handle: boolean = false): Effect.fn.Return<void, FsFailure> {
        // Share the current lookup within authorization, never its result between operations.
        const get = yield* view
        yield* aliveIn(get, op, handle)

        if (!(yield* containsIn(get, node))) return yield* op.fail("AccessDenied")
      }
    )

    const path = Effect.fnUntraced(function*(ino: Ino) {
      const names: Array<string> = []
      const get = yield* view
      let node = get(ino)
      let steps = 0

      if (node?.kind !== "directory" || node.metadata.nlink === 0) return undefined
      const root = roots.at(-1) ?? ROOT_INO

      while (node.ino !== root) {
        if (node.ino === ROOT_INO) return undefined
        names.push(node.name)
        const parent: Node | undefined = get(node.parent)

        if (parent?.kind !== "directory" || parent.metadata.nlink === 0 || parent.entries.get(node.name) !== node.ino) {
          return undefined
        }

        node = parent

        if (++steps % WALK_YIELD_INTERVAL === 0 && !(yield* SyncSection)) yield* Effect.yieldNow
      }

      return "2f" + names.reverse().join("2f")
    })

    return { roots, root: roots.at(-1) ?? ROOT_INO, alive, contains, check, path }
  }

  /** @internal */
  export type Confinement = ReturnType<typeof make>
}

/** @internal */
export namespace Resolution {
  /** @internal */
  export type PreparedEntry =
    | { readonly kind: "path"; readonly path: PreparedPath; readonly base: DirectoryHandle | undefined }
    | { readonly kind: "entry"; readonly directory: Target; readonly name: string }

  /** @internal */
  export interface NodeMode<R = never> {
    readonly kind: "Node"
    readonly followFinalSymlink?: boolean
    readonly final?: boolean
    readonly createMissing?: (parent: Directory, name: string, final: boolean) => Effect.Effect<Directory, FsFailure, R>
  }

  /** @internal */
  export interface ParentMode {
    readonly kind: "Parent"
  }

  /** @internal */
  export interface OrCreateMode<R = never> {
    readonly kind: "OrCreate"
    readonly create: "never" | "ifMissing" | "exclusive"
    readonly finalSymlink: "follow" | "preserve"
    // Entry writeFile historically checks exclusivity after following the link; open checks the direct entry.
    readonly entryExclusive?: "afterSymlink"
    readonly beforeFollow?: (parent: Directory, child: Node | undefined) => Effect.Effect<void, FsFailure, R>
  }

  type WalkMode<R> = NodeMode<R> | ParentMode | OrCreateMode<R>

  /** @internal */
  export type NodeResult =
    | { readonly kind: "node"; readonly node: Node; readonly op: OpContext }
    | {
      readonly kind: "entry"
      readonly node: Node
      readonly parent: Directory
      readonly name: string
      readonly op: OpContext
    }

  interface MissingResult {
    readonly kind: "missing"
    readonly parent: Directory
    readonly name: string
    readonly op: OpContext
  }

  /** @internal */
  export interface ParentResult {
    readonly kind: "parent"
    readonly parent: Ino
    readonly name: string | undefined
    readonly trailingSlash: boolean
    readonly addressing: "path" | "entry"
    readonly op: OpContext
  }

  interface CreateEntry {
    readonly parent: Directory
    readonly name: string
    readonly trailingSlash: boolean
    readonly addressing: "path" | "entry"
    readonly op: OpContext
    // Conditional entry opens report the original directory's revisions when a link resolves to an existing file.
    readonly origin: { readonly parent: Directory; readonly name: string }
  }

  /** @internal */
  export type CreateResult =
    | (CreateEntry & { readonly kind: "existing"; readonly node: Node })
    | (CreateEntry & { readonly kind: "missing" })

  const encoder = new TextEncoder()

  const EMPTY_AUTHORITIES: ReadonlyArray<Confinement.Confinement> = []

  /** @internal */
  export const inGroup = (identity: Identity, gid: number) => identity.gid === gid || identity.groups.includes(gid)

  /** @internal */
  export const permitted = (node: Node, identity: Identity) => {
    const shift = identity.uid === node.metadata.uid ? 6 : inGroup(identity, node.metadata.gid) ? 3 : 0

    return (node.metadata.mode >> shift) & 0o7
  }

  /** @internal */
  export const authorize = (node: Node, identity: Identity, bits: number, op: OpContext) =>
    identity.privileged || (permitted(node, identity) & bits) === bits
      ? Effect.void
      : Effect.fail(op.fail("AccessDenied"))

  /** @internal */
  export const entryName = (input: NameInput, op: OpContext): Result.Result<string, FsFailure> => {
    if (Predicate.isString(input) && !isWellFormed(input)) return Result.fail(op.fail("InvalidPathEncoding"))
    const bytes = Predicate.isString(input) ? encoder.encode(input) : input

    if (
      !isAttachedBytes(bytes) || bytes.length === 0 || bytes.length > MAX_NAME_BYTES || bytes.includes(0) ||
      bytes.includes(SLASH_BYTE)
    ) return Result.fail(op.fail("InvalidArgument"))

    return Result.succeed(Hex.encode(new Uint8Array(bytes)))
  }

  /** @internal */
  export const make = ({ caller, get, identity, maxPathBytes, registry, confinement, additional, authorityView }: {
    readonly additional?: ReadonlyArray<Confinement.Confinement> | undefined
    readonly authorityView: Effect.Effect<(ino: Ino) => Node | undefined>
    readonly confinement?: Confinement.Confinement | undefined
    readonly caller: TokenRegistry.DirectoryReference
    readonly get: (ino: Ino) => Effect.Effect<Node | undefined>
    readonly identity: Identity
    readonly maxPathBytes: ByteSize.ByteSize | undefined
    readonly registry: TokenRegistry.TokenRegistry
  }) => {
    const visibleRoot = confinement?.root ?? ROOT_INO
    const prepare = (input: PathInput, op: OpContext) => preparePath(input, op.operation, maxPathBytes)

    const prepareEntry = (input: EntryInput, op: OpContext): Result.Result<PreparedEntry, FsFailure> =>
      isEntry(input)
        ? Result.map(
          entryName(input.name, op),
          (name): PreparedEntry => ({ kind: "entry", directory: input.directory, name })
        )
        : isTarget(input)
        ? Result.map(prepare(input.path, op), (path): PreparedEntry => ({ kind: "path", path, base: input.relativeTo }))
        : Result.map(prepare(input, op), (path): PreparedEntry => ({ kind: "path", path, base: undefined }))

    const nodeAt = Effect.fnUntraced(function*(lookup: (ino: Ino) => Node | undefined, ino: Ino) {
      const node = lookup(ino)

      return node === undefined ? yield* Effect.die("Inode left the table during resolution") : node
    })

    const directoryAt = Effect.fnUntraced(function*(lookup: (ino: Ino) => Node | undefined, ino: Ino) {
      const node = yield* nodeAt(lookup, ino)

      return node.kind !== "directory" ? yield* Effect.die("Directory left the table during resolution") : node
    })

    const callerDirectory = Effect.fnUntraced(function*(lookup: (ino: Ino) => Node | undefined, op: OpContext) {
      const ino = TokenRegistry.inode(caller)
      const node = ino === undefined ? undefined : lookup(ino)

      return node?.kind !== "directory" ? yield* op.fail("ClosedCaller") : node
    })

    const walk = Effect.fnUntraced(function*<R = never>(
      path: PreparedPath,
      base: DirectoryHandle | FileHandle | undefined,
      op: OpContext,
      mode: WalkMode<R>,
      referencedBase?: Directory
    ) {
      const pathOp = op.at(path.input)

      const baseAuthorities = base === undefined
        ? EMPTY_AUTHORITIES
        : registry.handleBoundaries(base).map((roots) => Confinement.make(authorityView, roots))

      const authorizeDirectory = baseAuthorities.length === 0 ? authorize : Effect.fnUntraced(function*(
        node: Node,
        callerIdentity: Identity,
        bits: number,
        context: OpContext
      ) {
        for (const authority of baseAuthorities) yield* authority.check(node, context, true)
        yield* authorize(node, callerIdentity, bits, context)
      })

      const parentOnly = mode.kind === "Parent"
      const allowMissing = mode.kind === "OrCreate" && mode.create !== "never"

      const followFinalSymlink = mode.kind === "Node"
        ? mode.followFinalSymlink !== false
        : mode.kind === "Parent" || mode.finalSymlink === "follow"

      const createMissing = mode.kind === "Node" ? mode.createMissing : undefined

      if (!TokenRegistry.isOpen(caller)) {
        return yield* pathOp.fail("ClosedCaller")
      }

      if (additional !== undefined && additional.length > 0) {
        for (const authority of additional) yield* authority.alive(pathOp)
      }

      if (confinement !== undefined) yield* confinement.alive(pathOp)

      if (
        path.absolute && base !== undefined &&
        (confinement !== undefined || (additional?.length ?? 0) > 0 || baseAuthorities.length > 0)
      ) {
        const node = yield* TokenRegistry.nodeOrFail(yield* registry.resolve(base, "directory"), "handle", pathOp)
        yield* registry.authorizeHandle(base, node, pathOp)

        if (confinement !== undefined) yield* confinement.check(node, pathOp)

        if (additional !== undefined && additional.length > 0) {
          for (const authority of additional) yield* authority.check(node, pathOp)
        }
      }

      // Reads remain live so recursive creation can revisit nodes added earlier in this walk.
      const lookup = yield* authorityView
      let current: Node = path.absolute ? (yield* nodeAt(lookup, visibleRoot)) : yield* callerDirectory(lookup, pathOp)

      if (!path.absolute && referencedBase !== undefined) {
        current = referencedBase
        yield* authorize(current, identity, 0o1, op)
      } else if (!path.absolute && base !== undefined) {
        const directory = yield* TokenRegistry.nodeOrFail(yield* registry.resolve(base, "directory"), "handle", pathOp)

        if (directory.kind !== "directory") return yield* pathOp.fail("InvalidHandle")
        yield* registry.authorizeHandle(base, directory, pathOp)
        current = directory
        yield* authorize(current, identity, 0o1, pathOp)
      }

      if (confinement !== undefined) yield* confinement.check(current, pathOp)

      if (additional !== undefined && additional.length > 0) {
        for (const authority of additional) yield* authority.check(current, pathOp)
      }

      if (current.metadata.nlink === 0) {
        return yield* pathOp.fail("NotFound")
      }

      let work = path
      let parent: Directory | undefined
      let name: string | undefined
      let traversals = 0
      // Leading components that came from a symbolic link's target. Only the components the caller wrote are
      // created, so a dangling link stays missing, as it does for mkdir -p.
      let linked = 0

      for (let index = 0; index < work.components.length - (parentOnly ? 1 : 0); index++) {
        if (current.kind !== "directory") {
          return yield* pathOp.fail("NotDirectory")
        }

        yield* authorizeDirectory(current, identity, 0o1, pathOp)
        const component = work.components[index]

        if (component === undefined) break

        if (component === DOT_HEX) continue

        if (component === DOT_DOT_HEX) {
          current = yield* directoryAt(
            lookup,
            confinement !== undefined && current.ino === visibleRoot ? current.ino : current.parent
          )
          parent = undefined
          name = undefined
          continue
        }

        parent = current
        name = component
        const childIno = current.entries.get(component)
        const child = childIno === undefined ? undefined : lookup(childIno)

        if (child === undefined) {
          if (allowMissing && index === work.components.length - 1) {
            return { kind: "missing" as const, parent, name, op: pathOp }
          }

          if (createMissing !== undefined && index >= linked) {
            current = yield* createMissing(current, component, index === work.components.length - 1)
            continue
          }

          return yield* pathOp.fail("NotFound")
        }

        if (
          child.kind === "symlink" && (followFinalSymlink || index < work.components.length - 1 || work.trailingSlash)
        ) {
          if (child.target.length === 0) {
            return yield* pathOp.fail("NotFound")
          }

          if (++traversals > MAX_SYMLINK_TRAVERSALS) {
            return yield* pathOp.fail("SymlinkLoop")
          }

          const suffix = work.suffixes[index] ?? new Uint8Array(0)
          const remaining = work.components.length - index - 1

          if (
            maxPathBytes !== undefined &&
            ByteSize.isGreaterThan(ByteSize.bytes(child.target.length + suffix.length), maxPathBytes)
          ) {
            return yield* pathOp.fail("PathTooLong")
          }

          const expansion = new Uint8Array(child.target.length + suffix.length)
          expansion.set(child.target)
          expansion.set(suffix, child.target.length)
          const expanded = preparePath(ownedPath(expansion), op.operation, maxPathBytes)

          // The expansion is synthetic: its per-component limits are the caller's to hear about,
          // but the path in the error has to be the one the caller passed in, so the
          // expansion's own failure is not kept as the cause.
          if (Result.isFailure(expanded)) {
            return yield* pathOp.fail(expanded.failure.code)
          }

          work = expanded.success
          linked = work.components.length - remaining + Math.max(0, linked - index - 1)

          if (work.absolute) current = yield* nodeAt(lookup, visibleRoot)
          index = -1
        } else current = child
      }

      if (baseAuthorities.length > 0) {
        for (const authority of baseAuthorities) yield* authority.check(current, pathOp, true)
      }

      if (!parentOnly && work.trailingSlash && current.kind !== "directory") {
        return yield* pathOp.fail("NotDirectory")
      }

      return parent === undefined || name === undefined
        ? { kind: "node" as const, node: current, op: pathOp }
        : { kind: "entry" as const, node: current, parent, name, op: pathOp }
    })

    const resolveNode = Effect.fnUntraced(
      function*<R = never>(
        target: Target,
        mode: NodeMode<R>,
        op: OpContext
      ): Effect.fn.Return<NodeResult, FsFailure, R> {
        if (Predicate.isTagged(target, "Path")) {
          const path = yield* Effect.fromResult(prepare(target.path, op))

          const result = yield* walk(path, target.relativeTo, op, {
            ...mode,
            followFinalSymlink: mode.final === true
              ? mode.followFinalSymlink ?? true
              : target.followFinalSymlink ?? mode.followFinalSymlink ?? true
          })

          return result.kind === "missing" ? yield* result.op.fail("NotFound") : result
        }

        if (!TokenRegistry.isOpen(caller)) return yield* op.fail("ClosedCaller")

        const node = yield* TokenRegistry.nodeOrFail(
          yield* (Predicate.isTagged(target, "Reference")
            ? registry.resolve(target.reference, "reference")
            : registry.resolve(target.handle, "handle")),
          Predicate.isTagged(target, "Reference") ? "reference" : "handle",
          op
        )

        if (!Predicate.isTagged(target, "Reference")) yield* registry.authorizeHandle(target.handle, node, op)

        if (confinement !== undefined) yield* confinement.check(node, op)

        if (additional !== undefined && additional.length > 0) {
          for (const authority of additional) yield* authority.check(node, op)
        }

        return { kind: "node", node, op }
      }
    )

    const directory = Effect.fnUntraced(function*(target: Target, op: OpContext) {
      const resolved = yield* resolveNode(target, { kind: "Node" }, op)

      if (resolved.node.kind !== "directory") return yield* resolved.op.fail("NotDirectory")

      return { node: resolved.node, op: resolved.op }
    })

    const entryDirectory = Effect.fnUntraced(function*(target: Target, op: OpContext) {
      const resolved = yield* directory(target, op)

      if (resolved.node.metadata.nlink === 0) return yield* resolved.op.fail("NotFound")

      return resolved
    })

    const parent = Effect.fnUntraced(
      function*(prepared: PreparedEntry, op: OpContext): Effect.fn.Return<ParentResult, FsFailure> {
        if (prepared.kind === "entry") {
          const resolved = yield* entryDirectory(prepared.directory, op)

          return {
            kind: "parent",
            parent: resolved.node.ino,
            name: prepared.name,
            trailingSlash: false,
            addressing: "entry",
            op
          }
        }

        const resolved = yield* walk(prepared.path, prepared.base, op, { kind: "Parent" })

        if (resolved.kind === "missing") return yield* resolved.op.fail("NotFound")

        if (resolved.node.kind !== "directory") return yield* resolved.op.fail("NotDirectory")

        return {
          kind: "parent",
          parent: resolved.node.ino,
          name: prepared.path.components.at(-1),
          trailingSlash: prepared.path.trailingSlash,
          addressing: "path",
          op: resolved.op
        }
      }
    )

    const creationResult = (
      result: NodeResult | MissingResult,
      trailingSlash: boolean,
      addressing: "path" | "entry",
      op: OpContext,
      origin?: CreateEntry["origin"]
    ): Effect.Effect<CreateResult, FsFailure> => {
      if (result.kind === "node") return Effect.fail(op.fail("IsDirectory"))

      const entry = {
        parent: result.parent,
        name: result.name,
        trailingSlash,
        addressing,
        op,
        origin: origin ?? { parent: result.parent, name: result.name }
      }

      return Effect.succeed(
        result.kind === "missing" ? { ...entry, kind: "missing" } : { ...entry, kind: "existing", node: result.node }
      )
    }

    const orCreate = Effect.fnUntraced(
      function*<R = never>(
        prepared: PreparedEntry,
        mode: OrCreateMode<R>,
        op: OpContext
      ): Effect.fn.Return<CreateResult, FsFailure, R> {
        if (prepared.kind === "path") {
          const pathOp = op.at(prepared.path.input)

          if (mode.create === "exclusive") {
            const exists = yield* Effect.result(
              walk(prepared.path, prepared.base, op, { kind: "Node", followFinalSymlink: false })
            )

            if (Result.isSuccess(exists)) return yield* pathOp.fail("AlreadyExists")

            if (exists.failure.code !== "NotFound") return yield* exists.failure
          }

          return yield* creationResult(
            yield* walk(prepared.path, prepared.base, op, mode),
            prepared.path.trailingSlash,
            "path",
            pathOp
          )
        }

        const { node: parent } = yield* entryDirectory(prepared.directory, op)

        if (isDotComponent(prepared.name)) return yield* op.fail("InvalidArgument")
        yield* authorize(parent, identity, 0o1, op)
        const directIno = parent.entries.get(prepared.name)
        const direct = directIno === undefined ? undefined : yield* get(directIno)

        if (mode.beforeFollow !== undefined) yield* mode.beforeFollow(parent, direct)

        if (mode.create === "exclusive" && mode.entryExclusive !== "afterSymlink" && direct !== undefined) {
          return yield* op.fail("AlreadyExists")
        }

        let result: NodeResult | MissingResult = direct === undefined
          ? { kind: "missing", parent, name: prepared.name, op }
          : { kind: "entry", node: direct, parent, name: prepared.name, op }

        if (direct?.kind === "symlink" && mode.finalSymlink === "follow") {
          const path = yield* Effect.fromResult(
            preparePath(ownedPath(nameBytes(prepared.name)), op.operation, undefined)
          )

          // Following an entry link must retain the directory capability's boundaries.
          const base = Predicate.isTagged(prepared.directory, "Handle")
            ? prepared.directory.handle
            : Predicate.isTagged(prepared.directory, "Path")
            ? prepared.directory.relativeTo
            : undefined

          result = yield* walk(path, base, op, mode, parent)

          // Entry writeFile rejects a followed directory before checking exclusive creation.
          if (
            mode.create === "exclusive" && mode.entryExclusive === "afterSymlink" &&
            (result.kind === "node" || (result.kind === "entry" && result.node.kind === "directory"))
          ) {
            return yield* op.fail("IsDirectory")
          }
        }

        if (result.kind === "missing" && mode.create === "never") return yield* op.fail("NotFound")

        if (mode.create === "exclusive" && mode.entryExclusive === "afterSymlink" && result.kind !== "missing") {
          return yield* op.fail("AlreadyExists")
        }

        return yield* creationResult(result, false, "entry", op, { parent, name: prepared.name })
      }
    )

    function resolve<R = never>(
      target: Target,
      mode: NodeMode<R>,
      op: OpContext
    ): Effect.Effect<NodeResult, FsFailure, R>
    function resolve(prepared: PreparedEntry, mode: ParentMode, op: OpContext): Effect.Effect<ParentResult, FsFailure>
    function resolve<R = never>(
      prepared: PreparedEntry,
      mode: OrCreateMode<R>,
      op: OpContext
    ): Effect.Effect<CreateResult, FsFailure, R>
    function resolve<R>(
      input: Target | PreparedEntry,
      mode: WalkMode<R>,
      op: OpContext
    ): Effect.Effect<NodeResult | ParentResult | CreateResult, FsFailure, R> {
      if (isTarget(input)) {
        return mode.kind === "Node"
          ? resolveNode(input, mode, op)
          : Effect.die("A node target requires Node resolution")
      }

      return mode.kind === "Parent"
        ? parent(input, op)
        : mode.kind === "OrCreate"
        ? orCreate(input, mode, op)
        : Effect.die("An entry requires Parent or OrCreate resolution")
    }

    return { prepare, prepareEntry, resolve, directory, entryDirectory }
  }
}

/** @internal */
export interface EngineOptions {
  readonly execution?: "cooperative" | "sync" | undefined
  readonly limits?: BasicLimits | undefined
  readonly initialTime?: bigint | undefined
  readonly initialState?: VolumeState | undefined
  readonly commitProvider?: CommitProvider<VolumeState> | undefined
  readonly installed?: ((events: () => Iterable<WatchEvent>, installation: Installation) => void) | undefined
}

/** @internal */
export const BasicLimits = Schema.Struct({
  maxEntries: Schema.optional(Schema.Natural),
  maxBytes: Schema.optional(Schema.ByteSize),
  maxFileBytes: Schema.optional(
    Schema.ByteSize.check(
      Schema.makeFilter((size) =>
        ByteSize.toBigInt(size) <= BigInt(MAX_FILE_BYTES) ? undefined : "file limit is too large"
      )
    )
  ),
  maxPathBytes: Schema.optional(
    Schema.ByteSize.check(
      Schema.makeFilter((size) => ByteSize.toBigInt(size) >= 1n ? undefined : "path limit must be positive")
    )
  ),
  maxPendingOperations: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))
})

/** @internal */
export type BasicLimits = typeof BasicLimits.Type

const readLimits = (options: BasicLimits | undefined) =>
  Result.map(
    decodeConfiguration(BasicLimits, options ?? {}, "make"),
    (value) =>
      Object.freeze({
        ...value,
        maxEntries: value.maxEntries,
        maxBytes: value.maxBytes,
        maxPathBytes: value.maxPathBytes,
        maxFileBytes: value.maxFileBytes ?? ByteSize.bytes(MAX_FILE_BYTES),
        maxPendingOperations: value.maxPendingOperations ?? 64
      })
  )

/** @internal */
export interface Rename {
  readonly ino: Ino
  readonly from: Link
  readonly to: Link
}

/** @internal */
export interface Installation {
  readonly before: VolumeState
  readonly after: VolumeState
  readonly renames?: ReadonlyArray<Rename>
}

/** @internal */
export interface WatchEvent {
  readonly change: { readonly _tag: "Create" | "Update" | "Remove"; readonly path: BytePath }
  readonly parent: Ino
  readonly ino: Ino
  readonly name?: string
}

/** @internal */
export interface WatchTarget {
  readonly roots: ReadonlyArray<Ino>
  readonly additionalRoots: ReadonlyArray<ReadonlyArray<Ino>>
  readonly target: Ino
  readonly recursive: boolean
  readonly selected?: Link
}

/** @internal */
export interface EngineOperations {
  readonly limits: EngineLimits
  readonly root: Effect.Effect<ObjectReference, FsFailure>
  readonly lookup: (entry: EntryInput) => Effect.Effect<ObjectReference, FsFailure>
  readonly parent: (directory: TargetInput) => Effect.Effect<ObjectReference, FsFailure>
  readonly stat: (target: TargetInput) => Effect.Effect<Metadata, FsFailure>
  readonly readDirectory: (
    directory: TargetInput
  ) => Effect.Effect<ObjectObservation<ReadonlyArray<DirectoryEntry>>, FsFailure>
  readonly walk: (directory: TargetInput, options?: WalkOptions) => Stream.Stream<WalkEntry, WalkFailure>
  readonly readLink: (target: TargetInput) => Effect.Effect<Uint8Array, FsFailure>
  readonly realPath: (target: TargetInput) => Effect.Effect<BytePath, FsFailure>
  readonly access: (target: TargetInput, bits?: number) => Effect.Effect<number, FsFailure>
  readonly readFile: (target: TargetInput) => Effect.Effect<Uint8Array, FsFailure>
  readonly writeFile: {
    (bytes: Uint8Array, options: WriteFileOptions): (entry: EntryInput) => Effect.Effect<ObjectReference, FsFailure>
    (entry: EntryInput, bytes: Uint8Array, options: WriteFileOptions): Effect.Effect<ObjectReference, FsFailure>
  }
  readonly open: {
    (target: Target | PathInput | ObjectReference | FileHandle, options: OpenOptions): Effect.Effect<
      FileHandle,
      FsFailure,
      Scope.Scope
    >
    (entry: Entry, options: OpenEntryOptions): Effect.Effect<OpenEntryResult, FsFailure, Scope.Scope>
  }
  readonly mkdir: (entry: EntryInput, options?: MkdirOptions) => Effect.Effect<ReferenceEntryResult, FsFailure>
  readonly symlink: (
    target: PathInput,
    entry: EntryInput,
    options?: SymlinkOptions
  ) => Effect.Effect<ReferenceEntryResult, FsFailure>
  readonly link: {
    (entry: EntryInput): (source: TargetInput) => Effect.Effect<ReferenceEntryResult, FsFailure>
    (source: TargetInput, entry: EntryInput): Effect.Effect<ReferenceEntryResult, FsFailure>
  }
  readonly unlink: (entry: EntryInput) => Effect.Effect<DirectoryChange, FsFailure>
  readonly rmdir: (entry: EntryInput) => Effect.Effect<DirectoryChange, FsFailure>
  readonly remove: {
    (entry: EntryInput, options?: RemoveOptions & { readonly force?: false }): Effect.Effect<DirectoryChange, FsFailure>
    (entry: EntryInput, options: RemoveOptions): Effect.Effect<DirectoryChange | undefined, FsFailure>
  }
  readonly rename: {
    (to: EntryInput): (from: EntryInput) => Effect.Effect<RenameReferenceResult, FsFailure>
    (from: EntryInput, to: EntryInput): Effect.Effect<RenameReferenceResult, FsFailure>
  }
  readonly chmod: {
    (mode: number): (target: TargetInput) => Effect.Effect<void, FsFailure>
    (target: TargetInput, mode: number): Effect.Effect<void, FsFailure>
  }
  readonly chown: {
    (owner: OwnerUpdate): (target: TargetInput) => Effect.Effect<void, FsFailure>
    (target: TargetInput, owner: OwnerUpdate): Effect.Effect<void, FsFailure>
  }
  readonly utimes: {
    (times: Times): (target: TargetInput) => Effect.Effect<void, FsFailure>
    (target: TargetInput, times: Times): Effect.Effect<void, FsFailure>
  }
  readonly truncate: {
    (length: bigint): (target: TargetInput) => Effect.Effect<void, FsFailure>
    (target: TargetInput, length: bigint): Effect.Effect<void, FsFailure>
  }
  readonly setattr: {
    (attributes: SetattrOptions): (target: TargetInput) => Effect.Effect<void, FsFailure>
    (target: TargetInput, attributes: SetattrOptions): Effect.Effect<void, FsFailure>
  }
  readonly openDirectory: (directory: TargetInput) => Effect.Effect<DirectoryHandle, FsFailure, Scope.Scope>
}

/** @internal */
export interface EngineContext {
  readonly operations: EngineOperations
  readonly selectWatch: (
    input: TargetInput,
    options: { readonly recursive?: boolean | undefined; readonly alias?: "all" | "resolved" | undefined }
  ) => Effect.Effect<WatchTarget, FsFailure>
  readonly withRoot: (input: TargetInput) => Effect.Effect<EngineContext, FsFailure, Scope.Scope>
  readonly withDirectory: (input: TargetInput) => Effect.Effect<EngineContext, FsFailure, Scope.Scope>
}

type DirectoryReference = TokenRegistry.DirectoryReference

type FileReference = TokenRegistry.FileReference

type PreparedEntry = Resolution.PreparedEntry

const EXECUTE = 0o1
const WRITE = 0o2
const READ = 0o4
const ANY_EXECUTE = 0o111
const SET_ID_BITS = 0o6000
const STICKY_BIT = 0o1000
const RELATIME_INTERVAL_NS = 86_400_000_000_000n // relatime, as Linux mounts by default: a read refreshes an access time at least this old, 24 hours.

/** @internal */
export interface CommitProvider<State> {
  readonly mode: "memory" | "durable"
  readonly commit: (candidate: State) => Effect.Effect<CommitOutcome, FsFailure & { readonly code: "StorageRejected" }>
  readonly shutdown: Effect.Effect<void>
}

/** @internal */
export const memoryCommitProvider: CommitProvider<VolumeState> = Object.freeze({
  mode: "memory",
  commit: () => Effect.succeed("committed" as const),
  shutdown: Effect.void
})

interface ClassifiedCommit {
  readonly cause?: Cause.Cause<never>
  readonly available: boolean
  readonly failure: FsFailure | undefined
}

// An unknown commit outcome stops the volume; definite rejection stops it only during cleanup.
const offerCommit = <State>(
  provider: CommitProvider<State>,
  operation: string,
  candidate: State,
  cleanup: boolean
): Effect.Effect<ClassifiedCommit> =>
  Effect.map(
    Effect.exit(Effect.suspend(() => provider.commit(candidate))),
    (committed): ClassifiedCommit => {
      if (Exit.isSuccess(committed) && Predicate.isTagged("Rejected")(committed.value)) {
        return { available: !cleanup, failure: undefined, cause: committed.value.cause }
      }

      // TODO(#186): Preserve the cause of a provider defect or interruption.
      if (Exit.isFailure(committed)) {
        if (Cause.hasDies(committed.cause) || Cause.hasInterrupts(committed.cause)) {
          return { available: false, failure: fsFailure("OutcomeUnknown", operation) }
        }

        const failure = Cause.findErrorOption(committed.cause)

        return Option.isSome(failure)
          ? { available: !cleanup, failure: failure.value }
          : { available: false, failure: fsFailure("OutcomeUnknown", operation) }
      }

      if (committed.value === "rejected") {
        return { available: !cleanup, failure: fsFailure("StorageRejected", operation) }
      }

      if (committed.value === "unknown") {
        return { available: false, failure: fsFailure("OutcomeUnknown", operation) }
      }

      return { available: true, failure: undefined }
    }
  )

const WALK_CHUNK_ENTRIES = 128
const MAX_FILE_OFFSET = 0x7fffffffffffffffn

const isMode = Schema.is(Mode)

const isNatural = Schema.is(Schema.Natural)

const isLength = Schema.is(SetattrOptions.fields.size.schema)

const inGroup = Resolution.inGroup

const isTimestamp = Schema.is(Timestamp)

const isSeekMode = Schema.is(SeekMode)

const decodeOwnerUpdate = Schema.decodeEffect(OwnerUpdate, { onExcessProperty: "error" })

const decodeTimes = Schema.decodeEffect(Times, { onExcessProperty: "error" })

const decodeExpected = Schema.decodeEffect(SetattrOptions.fields.expected.schema, { onExcessProperty: "error" })

const SETATTR_FIELDS: ReadonlyArray<string> = Object.keys(SetattrOptions.fields)

type Attributes = { readonly [K in keyof SetattrOptions]?: SetattrOptions[K] | undefined }

const timeAt = (update: TimeUpdate | undefined, value: bigint, now: bigint) =>
  update === undefined ? value : Match.value(update).pipe(
    Match.discriminator("kind")("omit", () => value),
    Match.discriminator("kind")("now", () => now),
    Match.discriminator("kind")("value", ({ nanoseconds }) => nanoseconds),
    Match.exhaustive
  )

const decodeWriteFileOptions = Schema.decodeEffect(WriteFileOptions, { onExcessProperty: "error" })

const decodeOpenOptions = Schema.decodeEffect(OpenOptions, { onExcessProperty: "error" })

const decodeMkdirOptions = Schema.decodeEffect(MkdirOptions, { onExcessProperty: "error" })

const decodeSymlinkOptions = Schema.decodeEffect(SymlinkOptions, { onExcessProperty: "error" })

const decodeWalkOptions = Schema.decodeEffect(WalkOptions, { onExcessProperty: "error" })

const decodeRemoveOptions = Schema.decodeEffect(RemoveOptions, { onExcessProperty: "error" })

const decodeOpenEntryOptions = Schema.decodeEffect(OpenEntryOptions, { onExcessProperty: "error" })

type OpenRequest = Omit<OpenEntryOptions, "append" | "followFinalSymlink" | "expectedChild" | "expected">

// Whether a read at `now` refreshes a node's access time: when it is not newer than the last modification or
// status change, or when it is at least a day old. A time already equal to `now` is never refreshed, as Linux
// skips it, so reads at one instant (a frozen or coarse clock) store nothing.
const accessDue = (metadata: NodeMetadata, now: bigint) =>
  now !== metadata.atimeNs && (
    metadata.atimeNs <= metadata.mtimeNs || metadata.atimeNs <= metadata.ctimeNs ||
    now - metadata.atimeNs >= RELATIME_INTERVAL_NS
  )

interface Access {
  readonly node: Node
  readonly now: bigint
}

interface Accessed<A> {
  readonly value: A
  readonly access: Access | undefined
}

const refreshDue = <A>(read: Accessed<A>): read is Accessed<A> & { readonly access: Access } =>
  read.access !== undefined && accessDue(read.access.node.metadata, read.access.now)

interface WalkFrame {
  readonly ino: Ino
  readonly kind: Node["kind"]
  readonly name: Uint8Array
  readonly key: string
  readonly path: Uint8Array
  readonly parent: Ino
  readonly up: WalkFrame | undefined
  readonly depth: number
  readonly bytes: bigint
  readonly reference: ObjectReference
  readonly directory: ObjectReference
  readonly listed: boolean
}

interface WalkPlan<E = never> {
  readonly order: "pre" | "post"
  readonly limit: (
    frame: WalkFrame,
    progress: { readonly entries: number; readonly bytes: bigint },
    phase: "entry" | "directory"
  ) => E | undefined
}

interface ResolvedEntry {
  readonly parent: Ino
  readonly name: string | undefined
  readonly trailingSlash: boolean
  readonly addressing: "path" | "entry"
  readonly op: OpContext
}

interface ResolvedNode {
  readonly ino: Ino
  readonly op: OpContext
}

// One change gets one draft service. Its MutableRef contains the candidate and all
// actions that may become visible only after the candidate is installed.
interface DraftState {
  readonly pending: Map<Ino, Node | undefined>
  readonly opens: ReadonlyMap<Ino, number> | undefined
  readonly nextInode: Ino
  readonly changed: boolean
  readonly finished: VolumeState | undefined
  readonly entries: number
  readonly usedBytes: bigint
  readonly renames: Array<Rename>
  readonly events: Array<(installed: VolumeState) => Iterable<WatchEvent>>
  readonly after: Array<() => void>
  readonly removed: Array<Ino>
}

interface DraftOperations {
  readonly revision: bigint
  readonly lookup: (ino: Ino) => Node | undefined
  readonly get: (ino: Ino) => Effect.Effect<Node | undefined>
  readonly put: (node: Node) => Effect.Effect<void>
  readonly putQuiet: (node: Node) => Effect.Effect<void>
  readonly unchanged: Effect.Effect<boolean>
  readonly remove: (ino: Ino) => Effect.Effect<void>
  readonly allocate: Effect.Effect<Ino>
  readonly canAllocate: Effect.Effect<boolean>
  readonly openCount: (ino: Ino) => Effect.Effect<number>
  readonly retain: (ino: Ino) => Effect.Effect<void>
  readonly release: (ino: Ino) => Effect.Effect<number>
  readonly entries: Effect.Effect<number>
  readonly addEntries: (amount: number) => Effect.Effect<void>
  readonly usedBytes: Effect.Effect<bigint>
  readonly addUsedBytes: (amount: bigint) => Effect.Effect<void>
  readonly rename: (rename: Rename) => Effect.Effect<void>
  readonly publish: (event: (installed: VolumeState) => Iterable<WatchEvent>) => Effect.Effect<void>
  readonly afterInstall: (action: () => void) => Effect.Effect<void>
  readonly finish: Effect.Effect<VolumeState>
  readonly actions: Effect.Effect<Pick<DraftState, "events" | "after" | "removed" | "renames">>
}

class Draft extends Context.Service<Draft, DraftOperations>()("@effect-vfs/core/internal/virtualFileSystem/Draft", {
  make: Effect.fnUntraced(function*(base: VolumeState) {
    const revision = base.revision + 1n

    const cell = MutableRef.make<DraftState>({
      pending: new Map(),
      opens: undefined,
      nextInode: base.nextInode,
      changed: false,
      finished: undefined,
      entries: base.entries,
      usedBytes: base.usedBytes,
      renames: [],
      events: [],
      after: [],
      removed: []
    })

    const lookup = (ino: Ino) => {
      const draft = MutableRef.get(cell)

      return draft.pending.has(ino) ? draft.pending.get(ino) : getNode(base, ino)
    }

    const get = (ino: Ino) => Effect.sync(() => lookup(ino))

    const openCount = (ino: Ino) => Effect.sync(() => MutableRef.get(cell).opens?.get(ino) ?? base.open.get(ino) ?? 0)

    const put = (node: Node, changed: boolean) =>
      Effect.sync(() => {
        MutableRef.update(cell, (draft) => {
          // This map belongs only to this transition. Copying it on every inode write makes recursive changes quadratic.
          draft.pending.set(node.ino, changed ? { ...node, revision } : node)

          return { ...draft, changed: draft.changed || changed }
        })
      })

    return {
      revision,
      lookup,
      get,
      put: (node: Node) => put(node, true),
      putQuiet: (node: Node) => put(node, false),
      unchanged: Effect.sync(() => {
        const draft = MutableRef.get(cell)

        return draft.pending.size === 0 && draft.opens === undefined && draft.nextInode === base.nextInode &&
          draft.entries === base.entries && draft.usedBytes === base.usedBytes
      }),
      remove: (ino: Ino) =>
        Effect.sync(() => {
          const draft = MutableRef.get(cell)
          draft.pending.set(ino, undefined)
          draft.removed.push(ino)
        }),
      allocate: Effect.sync(() => {
        const next = MutableRef.get(cell).nextInode
        MutableRef.update(cell, (draft) => ({ ...draft, nextInode: Ino(next + 1) }))

        return next
      }),
      canAllocate: Effect.sync(() => MutableRef.get(cell).nextInode < Number.MAX_SAFE_INTEGER),
      openCount,
      retain: (ino: Ino) =>
        Effect.sync(() => {
          const count = MutableRef.get(cell).opens?.get(ino) ?? base.open.get(ino) ?? 0
          MutableRef.update(cell, (draft) => ({ ...draft, opens: new Map(draft.opens).set(ino, count + 1) }))
        }),
      release: (ino: Ino) =>
        Effect.sync(() => {
          const count = (MutableRef.get(cell).opens?.get(ino) ?? base.open.get(ino) ?? 0) - 1
          MutableRef.update(cell, (draft) => ({ ...draft, opens: new Map(draft.opens).set(ino, Math.max(0, count)) }))

          return count
        }),
      entries: Effect.sync(() => MutableRef.get(cell).entries),
      addEntries: (amount: number) =>
        Effect.sync(() => {
          MutableRef.update(cell, (draft) => ({ ...draft, entries: draft.entries + amount }))
        }),
      usedBytes: Effect.sync(() => MutableRef.get(cell).usedBytes),
      addUsedBytes: (amount: bigint) =>
        Effect.sync(() => {
          MutableRef.update(cell, (draft) => ({ ...draft, usedBytes: draft.usedBytes + amount }))
        }),
      rename: (rename: Rename) =>
        Effect.sync(() => {
          MutableRef.get(cell).renames.push(rename)
        }),
      publish: (event: (installed: VolumeState) => Iterable<WatchEvent>) =>
        Effect.sync(() => {
          MutableRef.get(cell).events.push(event)
        }),
      afterInstall: (action: () => void) =>
        Effect.sync(() => {
          MutableRef.get(cell).after.push(action)
        }),
      finish: Effect.sync(() => {
        const draft = MutableRef.get(cell)

        if (draft.finished !== undefined) return draft.finished

        const inodes = HashMap.mutate(base.inodes, (mutable) => {
          for (const [ino, node] of draft.pending) {
            if (node === undefined) HashMap.remove(mutable, ino)
            else setNode(mutable, node)
          }
        })

        let open = base.open

        if (draft.opens !== undefined) {
          const next = new Map(base.open)

          for (const [ino, count] of draft.opens) {
            if (count > 0) next.set(ino, count)
            else next.delete(ino)
          }

          open = next
        }

        const finished: VolumeState = {
          inodes,
          open,
          nextInode: draft.nextInode,
          revision: draft.changed ? revision : base.revision,
          entries: draft.entries,
          usedBytes: draft.usedBytes
        }

        MutableRef.update(cell, (current) => ({ ...current, finished }))

        return finished
      }),
      actions: Effect.sync(() => {
        const { events, after, removed, renames } = MutableRef.get(cell)

        return { events, after, removed, renames }
      })
    }
  })
}) {}

const withMetadata = (node: Node): Metadata => ({ ...node.metadata, revision: node.revision })

const withEntries = (directory: Directory, entries: ReadonlyMap<string, Ino>): Directory => ({ ...directory, entries })

const withoutLink = (links: ReadonlyArray<Link>, parent: Ino, name: string): ReadonlyArray<Link> => {
  const index = links.findIndex((link) => link.parent === parent && link.name === name)

  return index < 0 ? links : [...links.slice(0, index), ...links.slice(index + 1)]
}

/** @internal */
export const makeEngine = Effect.fnUntraced(
  function*(options: EngineOptions = {}) {
    const services = yield* Effect.context()
    const dieInvariant = (message: string): never => Effect.runSyncWith(services)(Effect.die(message))
    const limits = yield* Effect.fromResult(readLimits(options.limits))
    const commitProvider = options.commitProvider ?? memoryCommitProvider
    const execution = options.execution ?? "cooperative"

    if (
      (execution !== "cooperative" && execution !== "sync") ||
      (execution === "sync" && commitProvider !== memoryCommitProvider)
    ) {
      return yield* argumentFailure("make", "execution")
    }

    const synchronous = execution === "sync"
    const clock = yield* Clock.clockWith(Effect.succeed)
    const initialTime = options.initialTime ?? clock.currentTimeNanosUnsafe()

    if (!isTimestamp(initialTime)) {
      return yield* argumentFailure("make", "clock.currentTimeNanos")
    }

    const timestamp = (op: OpContext) =>
      Effect.suspend(() => {
        const now = clock.currentTimeNanosUnsafe()

        return isTimestamp(now)
          ? Effect.succeed(now)
          : Effect.fail(op.fail("InvalidArgument"))
      })

    const volumeIdentity = Symbol()
    const directoryHolds = new Map<Ino, number>()

    const maxPendingOperations = limits.maxPendingOperations
    const permits = maxPendingOperations + 1

    // The gate hands permits to whichever waiter it can satisfy, so a change waiting for every permit would be
    // overtaken by each later observation. A change holds a turnstile while it gathers the permits, and an
    // observation passes the turnstile before it takes one, so observations that arrive after a change wait
    // behind it. The turnstile goes to its waiters in arrival order, even to one that arrives while a finished
    // change is still releasing. Both waits stay interruptible, and every permit is taken and released by
    // `withPermits`.
    const cooperative = synchronous ? undefined : {
      gate: Semaphore.makeUnsafe(permits),
      turnstile: makeTurnstile()
    }

    let active = false
    const pending = new Map<TokenRegistry.HandleReference, Effect.Effect<void>>()

    const preflight = (op: OpContext): Effect.Effect<void, FsFailure> =>
      synchronous
        ? Effect.suspend(() => {
          if (active) return Effect.fail(op.fail("VolumeBusy"))

          return Effect.flatMap(VolumeTestSeams, (seams) =>
            Object.values(seams).some((effect) => effect !== Effect.void)
              ? Effect.fail(op.fail("InvalidArgument", { field: "testSeams" }))
              : Effect.void)
        })
        : Effect.void

    const drain = Effect.gen(function*() {
      let failure = Cause.empty

      while (pending.size > 0) {
        const releases = Array.from(pending.values())
        pending.clear()

        for (const release of releases) {
          const exit = yield* Effect.exit(release)

          if (Exit.isFailure(exit)) failure = Cause.combine(failure, exit.cause)
        }
      }

      if (failure.reasons.length > 0) return yield* Effect.failCause(failure)
    })

    const inSyncSection = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | FsFailure, R> =>
      Effect.provideService(
        Effect.provideService(
          Effect.uninterruptible(Effect.suspend((): Effect.Effect<A, E | FsFailure, R> => {
            if (active) return Effect.fail(fsFailure("VolumeBusy", "coordinate"))
            active = true

            return Effect.ensuring(
              effect,
              Effect.ensuring(
                drain,
                Effect.sync(() => {
                  active = false
                })
              )
            )
          })),
          Scheduler.PreventSchedulerYield,
          true
        ),
        SyncSection,
        true
      )

    const observing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      cooperative === undefined
        ? inSyncSection(effect)
        : Effect.andThen(cooperative.turnstile.withTurn(Effect.void), cooperative.gate.withPermits(1)(effect))

    const changing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      cooperative === undefined
        ? inSyncSection(effect)
        : cooperative.turnstile.withTurn(cooperative.gate.withPermits(permits)(effect))

    const admission = yield* Semaphore.make(permits)

    const admit = <A, E, R>(op: OpContext, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | FsFailure, R> =>
      Effect.andThen(
        preflight(op),
        admission.withPermitsIfAvailable(1)(effect).pipe(
          Effect.flatMap(Option.match({
            onNone: () => op.fail("VolumeBusy"),
            onSome: Effect.succeed
          }))
        )
      )

    const finalizeOwned = (
      reference: TokenRegistry.HandleReference,
      release: () => Effect.Effect<void, FsFailure>,
      ordinary: Effect.Effect<void>
    ) =>
      synchronous
        ? Effect.uninterruptible(Effect.suspend(() => {
          if (!active) return ordinary
          reference.lifecycle = { kind: "releasedPendingCommit", ino: TokenRegistry.inode(reference) }
          pending.set(reference, Effect.orDie(Effect.suspend(release)))

          return Effect.void
        }))
        : ordinary

    let state = emptyState(initialTime)
    const maxFileBytes = Number(ByteSize.toBigInt(limits.maxFileBytes))

    if (options.initialState !== undefined) state = options.initialState

    const view = (ino: Ino): Effect.Effect<Node | undefined> =>
      Effect.flatMap(
        Effect.serviceOption(Draft),
        (draft) => Option.isSome(draft) ? draft.value.get(ino) : Effect.sync(() => getNode(state, ino))
      )

    // Select the operation's namespace at execution time; never retain it across operations.
    const authorityView = Effect.map(
      Effect.serviceOption(Draft),
      (draft) => Option.isSome(draft) ? draft.value.lookup : (ino: Ino) => getNode(state, ino)
    )

    const registry = TokenRegistry.make(volumeIdentity, view)
    const referenceFor = registry.referenceFor
    const makeFileReference = registry.file
    const makeDirectoryReference = registry.directory

    let available = true

    const checkAvailable = (operation: string) =>
      Effect.suspend(() => available ? Effect.void : Effect.fail(fsFailure("VolumeUnavailable", operation)))

    const install = Effect.fnUntraced(function*(finished: DraftOperations) {
      const before = state
      state = yield* finished.finish
      const actions = yield* finished.actions

      for (const ino of actions.removed) registry.forget(ino)

      for (const apply of actions.after) apply()

      const after = state

      options.installed?.(() => actions.events.flatMap((events) => Array.from(events(after))), {
        before,
        after,
        renames: actions.renames
      })
    })

    const transition = Effect.fnUntraced(function*<A, E, R>(change: Effect.Effect<A, E, R>) {
      const current = yield* Draft.make(state)
      const value = yield* Effect.provideService(change, Draft, current)

      return [value, current] as const
    })

    // Cleanup releases local ownership even when storage refuses; that divergence disables the volume.
    const committed = Effect.fnUntraced(function*(
      op: OpContext,
      finished: DraftOperations,
      cleanup: boolean
    ) {
      if ((yield* finished.unchanged) || (cleanup && !available)) return yield* install(finished)
      const next = yield* finished.finish
      const answer = yield* offerCommit(commitProvider, op.operation, next, cleanup)

      if (!answer.available) available = false

      if (answer.cause !== undefined) {
        if (cleanup) yield* install(finished)

        return yield* Effect.failCause(answer.cause)
      }

      if (answer.failure !== undefined) {
        if (cleanup) yield* install(finished)

        return yield* answer.failure
      }

      yield* install(finished)
    })

    const applyCleanup = Effect.fnUntraced(function*(
      change: (draft: DraftOperations) => Effect.Effect<void, never, Draft>
    ) {
      const current = yield* Draft.make(state)
      yield* Effect.provideService(change(current), Draft, current)
      yield* committed(OpContext.make("close"), current, true)
    })

    const annotateFailure = (error: VfsError) =>
      Effect.annotateCurrentSpan({ operation: error.operation, code: error.code })

    // Permit waits stay interruptible. Memory transitions are masked; durable transitions remain
    // interruptible until the candidate is ready. Every provider commit and installation is masked.
    const coordinated = <A, E, R>(
      op: OpContext,
      effect: Effect.Effect<A, E, R>,
      cleanup = false
    ) =>
      admit(
        op,
        changing(Effect.uninterruptibleMask((restore) => {
          const staged = transition(Effect.andThen(checkAvailable(op.operation), effect))

          return Effect.flatMap(
            commitProvider.mode === "memory" ? staged : restore(staged),
            ([value, finished]) => Effect.as(committed(op, finished, cleanup), value)
          )
        }))
      ).pipe(Effect.tapError((error) => Schema.is(VfsError)(error) ? annotateFailure(error) : Effect.void))

    const coordinatedRead = <A, E, R>(op: OpContext, effect: Effect.Effect<A, E, R>) =>
      admit(op, observing(Effect.andThen(checkAvailable(op.operation), effect))).pipe(
        Effect.tapError((error) => Schema.is(VfsError)(error) ? annotateFailure(error) : Effect.void)
      )

    const refreshAccess = Effect.fnUntraced(function*<A>(read: Accessed<A>) {
      if (refreshDue(read)) {
        const { node, now } = read.access
        const draft = yield* Draft
        yield* draft.putQuiet({ ...node, metadata: { ...node.metadata, atimeNs: now } })
      }

      return read.value
    })

    // A read that may refresh an access time. It observes under one permit, so reads run beside each other, and
    // only when the access time is due does it run again as a change. The change repeats every check and the rule,
    // since another read may have refreshed the time meanwhile, and its result is the one returned.
    const accessing = <A, E, R>(op: OpContext, read: Effect.Effect<Accessed<A>, E, R>) =>
      Effect.flatMap(
        coordinatedRead(op, read),
        (observed) =>
          refreshDue(observed)
            ? coordinated(op, Effect.flatMap(read, refreshAccess))
            : Effect.succeed(observed.value)
      )

    const coordinatedCleanup = <A, E, R>(effect: Effect.Effect<A, E, R>) => changing(Effect.uninterruptible(effect))

    const shutdown = commitProvider.mode === "memory" ? commitProvider.shutdown : changing(Effect.uninterruptible(
      Effect.andThen(
        Effect.sync(() => {
          available = false
        }),
        commitProvider.shutdown
      )
    )).pipe(Effect.orDie)

    const pathOfCurrent = Effect.fnUntraced(function*(ino: Ino) {
      const names: Array<string> = []
      const first = yield* view(ino)

      if (first?.kind !== "directory" || first.metadata.nlink === 0) return undefined
      let node: Directory = first

      while (node.ino !== ROOT_INO) {
        names.push(node.name)
        const parent: Node | undefined = yield* view(node.parent)

        if (parent?.kind !== "directory" || parent.metadata.nlink === 0) return undefined
        node = parent
      }

      return SLASH_HEX + names.reverse().join(SLASH_HEX)
    })

    const publishEntry = Effect.fnUntraced(
      function*(_tag: "Create" | "Update" | "Remove", parent: Ino, name: string, ino: Ino) {
        if (options.installed === undefined) return
        const before = state
        const draft = yield* Draft
        yield* draft.publish((installed) => {
          const prefix = pathOf((at) => getNode(installed, at), parent) ?? pathOf((at) => getNode(before, at), parent)

          return prefix === undefined ? [] : [{ change: { _tag, path: entryPath(prefix, name) }, parent, ino, name }]
        })
      }
    )

    const publishNode = Effect.fnUntraced(function*(ino: Ino) {
      if (options.installed === undefined) return
      const draft = yield* Draft
      const target = yield* draft.get(ino)

      if (target === undefined) return

      if (target.kind === "directory") {
        yield* draft.publish((installed) => {
          const directory = getNode(installed, ino)
          const path = pathOf((at) => getNode(installed, at), ino)

          return path === undefined || directory?.kind !== "directory"
            ? []
            : [{ change: { _tag: "Update" as const, path: ownedPath(nameBytes(path)) }, parent: directory.parent, ino }]
        })

        return
      }

      const links = target.links
      yield* draft.publish((installed) => {
        const events: Array<WatchEvent> = []

        for (const link of links) {
          const prefix = pathOf((at) => getNode(installed, at), link.parent)

          if (prefix !== undefined) {
            events.push({
              change: { _tag: "Update" as const, path: entryPath(prefix, link.name) },
              parent: link.parent,
              ino
            })
          }
        }

        return events
      })
    })

    const holdDirectory = (ino: Ino) => {
      directoryHolds.set(ino, (directoryHolds.get(ino) ?? 0) + 1)
    }

    const unholdDirectory = Effect.fnUntraced(function*(ino: Ino) {
      const count = (directoryHolds.get(ino) ?? 1) - 1

      if (count > 0) {
        directoryHolds.set(ino, count)

        return
      }

      directoryHolds.delete(ino)
      const node = getNode(state, ino)

      if (node?.kind === "directory" && node.metadata.nlink === 0) {
        yield* applyCleanup((d) => d.remove(ino))
      }
    })

    const releaseDirectory = (reference: DirectoryReference) =>
      TokenRegistry.release(reference, unholdDirectory, (action) => Effect.sync(action))

    const finalizeDirectory = (reference: DirectoryReference) => {
      const close = coordinatedCleanup(releaseDirectory(reference))

      return finalizeOwned(
        reference,
        () => releaseDirectory(reference),
        TokenRegistry.finalize(reference, close, Effect.ignore(close))
      )
    }

    const closeReleasedScope = TokenRegistry.closeReleasedScope

    const permitted = Resolution.permitted
    const authorize = Resolution.authorize

    const reclaim = Effect.fnUntraced(function*(d: DraftOperations, ino: Ino) {
      const node = yield* d.get(ino)

      if (node === undefined) return

      if (node.kind === "file") {
        if (node.links.length > 0 || (yield* d.openCount(ino)) > 0) return
        yield* d.addUsedBytes(-BigInt(node.data.length))
      } else if (node.kind === "symlink") {
        if (node.links.length > 0) return
        yield* d.addUsedBytes(-BigInt(node.target.length))
      } else if (node.metadata.nlink > 0 || directoryHolds.has(ino)) return
      yield* d.remove(ino)
    })

    const atEntryLimit = Effect.gen(function*() {
      const draft = yield* Draft

      return limits.maxEntries !== undefined && (yield* draft.entries) >= limits.maxEntries
    })

    const reserveEntry = Effect.fnUntraced(function*(op: OpContext) {
      const draft = yield* Draft

      if ((yield* atEntryLimit) || !(yield* draft.canAllocate)) return yield* op.fail("NoSpace")
    })

    const reserveInode = (op: OpContext) =>
      Effect.flatMap(
        Draft,
        (draft) =>
          Effect.flatMap(draft.canAllocate, (available) => available ? Effect.void : Effect.fail(op.fail("NoSpace")))
      )

    const reserveBytes = Effect.fnUntraced(function*(op: OpContext, bytes: bigint) {
      if (limits.maxBytes === undefined) return
      const draft = yield* Draft

      if (bytes > ByteSize.toBigInt(limits.maxBytes) - (yield* draft.usedBytes)) {
        return yield* op.fail("NoSpace")
      }
    })

    const attach = Effect.fnUntraced(function*(parent: Directory, name: string, child: Node, now: bigint) {
      const d = yield* Draft
      yield* d.put(withEntries(
        {
          ...parent,
          metadata: {
            ...parent.metadata,
            nlink: parent.metadata.nlink + (child.kind === "directory" ? 1 : 0),
            mtimeNs: now,
            ctimeNs: now
          }
        },
        DirectoryEntries.set(parent.entries, name, child.ino)
      ))

      if (child.kind === "directory") yield* d.put({ ...child, parent: parent.ino, name })
      else {
        yield* d.put({
          ...child,
          links: [...child.links, { parent: parent.ino, name }],
          metadata: { ...child.metadata, nlink: child.links.length + 1, ctimeNs: now }
        })
      }
    })

    const detach = Effect.fnUntraced(function*(child: Node, parent: Ino, name: string, now: bigint) {
      const d = yield* Draft

      if (child.kind === "directory") {
        yield* d.put({ ...child, metadata: { ...child.metadata, nlink: 0, ctimeNs: now } })
      } else {
        const links = withoutLink(child.links, parent, name)
        yield* d.put({ ...child, links, metadata: { ...child.metadata, nlink: links.length, ctimeNs: now } })
      }

      yield* reclaim(d, child.ino)
    })

    const releaseFileInode = Effect.fnUntraced(function*(ino: Ino) {
      const d = yield* Draft
      yield* d.release(ino)
      yield* reclaim(d, ino)
    })

    const releaseFile = (ref: FileReference) =>
      TokenRegistry.release(ref, releaseFileInode, (action) => Effect.sync(action))

    const releaseOpenFile = (ref: FileReference) =>
      Effect.ignore(
        coordinatedCleanup(Effect.suspend(() =>
          TokenRegistry.inode(ref) === undefined ? Effect.void : applyCleanup(() => releaseFile(ref))
        ))
      )

    // Admission refusal leaves the handle open. Every admitted close shares the registry release,
    // and a storage failure still completes cleanup while only explicit close reports the failure.
    const closeFile = (ref: FileReference, op: OpContext, check: Effect.Effect<unknown, FsFailure>) =>
      coordinated(
        op,
        Effect.andThen(
          check,
          TokenRegistry.release(
            ref,
            releaseFileInode,
            (action) => Effect.flatMap(Draft, (draft) => draft.afterInstall(action))
          )
        ),
        true
      ).pipe(Effect.tapError((error) => error.code === "VolumeBusy" ? Effect.void : releaseOpenFile(ref)))

    const finalizeFile = (ref: FileReference) =>
      finalizeOwned(
        ref,
        () => applyCleanup(() => releaseFile(ref)),
        TokenRegistry.finalize(ref, closeFile(ref, OpContext.make("close"), Effect.void), releaseOpenFile(ref))
      )

    const acquireHandle = TokenRegistry.acquire

    const bindFile = (ref: FileReference, ino: Ino) =>
      Effect.flatMap(Draft, (draft) => draft.afterInstall(() => TokenRegistry.publish(ref, ino)))

    const replaceContent = Effect.fnUntraced(function*(
      file: RegularFile,
      data: Uint8Array,
      now: bigint,
      publish = true
    ) {
      const d = yield* Draft
      yield* d.addUsedBytes(BigInt(data.length - file.data.length))
      yield* d.put({
        ...file,
        data,
        metadata: {
          ...file.metadata,
          size: BigInt(data.length),
          mode: file.metadata.mode & ~SET_ID_BITS,
          mtimeNs: now,
          ctimeNs: now
        }
      })

      if (publish) yield* publishNode(file.ino)
    })

    const resizeAt = Effect.fnUntraced(function*(file: RegularFile, length: bigint, now: bigint, op: OpContext) {
      if (length > BigInt(maxFileBytes)) return yield* op.fail("FileTooLarge")
      const size = Number(length)

      yield* reserveBytes(op, BigInt(size - file.data.length))

      const data = new Uint8Array(size)
      data.set(file.data.subarray(0, size))
      yield* replaceContent(file, data, now, false)
    })

    const resize = Effect.fnUntraced(function*(file: RegularFile, length: bigint, op: OpContext) {
      if (!isLength(length)) return yield* op.fail("InvalidArgument")

      yield* resizeAt(file, length, yield* timestamp(op), op)
      yield* publishNode(file.ino)
    })

    const fileHandle = (ref: FileReference): FileHandle => {
      const get = Effect.fnUntraced(function*(op: OpContext, access?: "read" | "write", cleanup = false) {
        const ino = TokenRegistry.inode(ref)
        const node = ino === undefined ? undefined : yield* view(ino)

        if (
          (!cleanup && !TokenRegistry.isOpen(ref)) || node?.kind !== "file" ||
          (access === "read" && ref.access === "write") ||
          (access === "write" && ref.access === "read")
        ) return yield* op.fail("InvalidHandle")

        if (!cleanup && ref.authority !== undefined) yield* ref.authority(node, op)

        return node
      })

      const read = (maximum: number, position?: bigint) => {
        const op = OpContext.make(position === undefined ? "read" : "pread")
        const readOp = OpContext.make("read")

        const body = Effect.gen(function*() {
          const file = yield* get(op, "read")

          if (!isNatural(maximum)) return yield* readOp.fail("InvalidArgument")
          const offset = position ?? ref.offset

          if (!Predicate.isBigInt(offset) || offset < 0n || offset > MAX_FILE_OFFSET) {
            return yield* readOp.fail("InvalidArgument")
          }

          const start = Number(offset > file.metadata.size ? file.metadata.size : offset)
          const data = file.data.slice(start, start + Math.min(maximum, file.data.length - start))
          const eof = start + data.length >= file.data.length

          const access = maximum > 0 ? { node: file, now: yield* timestamp(readOp) } : undefined

          return { value: { bytes: data, eof, next: offset + BigInt(data.length) }, access }
        })

        // A positioned read runs beside other reads. A cursor read stays a change, since two reads beside each
        // other would start at the same offset.
        if (position !== undefined) return Effect.map(accessing(op, body), ({ bytes, eof }) => ({ bytes, eof }))

        return coordinated(
          op,
          Effect.gen(function*() {
            const { bytes, eof, next } = yield* refreshAccess(yield* body)
            const draft = yield* Draft
            yield* draft.afterInstall(() => {
              ref.offset = next
            })

            return { bytes, eof }
          })
        )
      }

      const write = Effect.fnUntraced(function*(input: Uint8Array, position?: bigint) {
        const op = OpContext.make(position === undefined ? "write" : "pwrite")
        const writeOp = OpContext.make("write")

        if (!isAttachedBytes(input)) return yield* writeOp.fail("InvalidArgument")

        const bytes = new Uint8Array(input)

        return yield* coordinated(
          op,
          Effect.gen(function*() {
            const file = yield* get(op, "write")
            const offset = position ?? (ref.append ? file.metadata.size : ref.offset)

            if (!Predicate.isBigInt(offset) || offset < 0n || offset > MAX_FILE_OFFSET) {
              return yield* writeOp.fail("InvalidArgument")
            }

            if (bytes.length === 0) {
              return 0
            }

            if (offset >= BigInt(maxFileBytes)) return yield* writeOp.fail("FileTooLarge")
            const start = Number(offset)

            const draft = yield* Draft

            const free = limits.maxBytes === undefined
              ? BigInt(maxFileBytes)
              : ByteSize.toBigInt(limits.maxBytes) - (yield* draft.usedBytes)

            const maximumEnd = BigInt(file.data.length) + free
            const end = Number(BigInt(maxFileBytes) < maximumEnd ? BigInt(maxFileBytes) : maximumEnd)
            const count = Math.min(bytes.length, Math.max(0, end - start))

            if (count === 0) return yield* writeOp.fail("NoSpace")
            const size = Math.max(file.data.length, start + count)
            // Always detach before mutation. A same-sized write is the critical
            // case: the current payload may belong to the base or a prior capture.
            const data = new Uint8Array(size)
            data.set(file.data)
            const now = yield* timestamp(writeOp)
            data.set(bytes.subarray(0, count), start)
            yield* replaceContent(file, data, now)

            if (position === undefined) {
              const next = offset + BigInt(count)
              yield* draft.afterInstall(() => {
                ref.offset = next
              })
            }

            return count
          })
        )
      })

      const statOp = OpContext.make("stat")
      const syncOp = OpContext.make("sync")
      const closeOp = OpContext.make("close")

      const handle: FileHandle = Object.freeze({
        [FileHandleId]: true as const,
        read: Effect.fnUntraced(function*(maximum: number) {
          return (yield* read(maximum)).bytes
        }),
        pread: Effect.fnUntraced(function*(maximum: number, offset: bigint) {
          return yield* read(maximum, offset)
        }),
        write: Effect.fnUntraced(function*(bytes: Uint8Array) {
          return yield* write(bytes)
        }),
        pwrite: dual(
          2,
          Effect.fnUntraced(function*(bytes: Uint8Array, offset: bigint) {
            return yield* write(bytes, offset)
          })
        ),
        seek: dual(
          2,
          Effect.fnUntraced(function*(offset: bigint, mode: SeekMode) {
            const op = OpContext.make("seek")

            return yield* coordinatedRead(
              op,
              Effect.uninterruptible(Effect.gen(function*() {
                const file = yield* get(op)

                if (!Predicate.isBigInt(offset) || !isSeekMode(mode)) {
                  return yield* op.fail("InvalidArgument")
                }

                let next = mode === "current"
                  ? ref.offset + offset
                  : mode === "end"
                  ? file.metadata.size + offset
                  : offset

                if (next < 0n || next > MAX_FILE_OFFSET) {
                  return yield* op.fail("InvalidArgument")
                }

                if (mode === "data" || mode === "hole") {
                  if (offset >= file.metadata.size) return yield* op.fail("NoData")

                  if (mode === "hole") next = file.metadata.size
                }

                ref.offset = next

                return next
              }))
            )
          })
        ),
        truncate: Effect.fnUntraced(function*(length: bigint) {
          const op = OpContext.make("truncate")

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              yield* resize(yield* get(op, "write"), length, op)
            })
          )
        }),
        stat: coordinatedRead(
          statOp,
          Effect.map(Effect.suspend(() => get(statOp)), withMetadata)
        ),
        sync: coordinatedRead(syncOp, Effect.suspend(() => Effect.asVoid(get(syncOp)))),
        close: closeFile(ref, closeOp, Effect.suspend(() => get(closeOp, undefined, true))).pipe(
          Effect.ensuring(closeReleasedScope(ref))
        )
      })

      registry.registerFile(handle, ref)

      return handle
    }

    const createContext = (
      reference: DirectoryReference,
      identity: Identity,
      umask: number,
      roots: ReadonlyArray<Ino> = [],
      inherited: ReadonlyArray<ReadonlyArray<Ino>> = []
    ): EngineContext => {
      const boundary = roots.length === 0 ? undefined : Confinement.make(authorityView, roots)
      inherited = inherited.filter((chain, index) =>
        !((chain.length <= roots.length && chain.every((ino, at) => roots[at] === ino)) ||
          inherited.slice(0, index).some((other) =>
            other.length === chain.length && chain.every((ino, at) => other[at] === ino)
          ))
      )
      const additional = inherited.map((chain) => Confinement.make(authorityView, chain))

      const checkAuthority = Effect.fnUntraced(function*(node: Node, op: OpContext) {
        if (boundary !== undefined) yield* boundary.check(node, op)

        for (const authority of additional) yield* authority.check(node, op)
      })

      const inheritedFor = (target: Target) =>
        Target.$is("Handle")(target)
          ? registry.handleBoundaries(target.handle)
          : Target.$is("Path")(target) && target.relativeTo !== undefined
          ? registry.handleBoundaries(target.relativeTo)
          : []

      const boundariesFor = (
        target?: Target
      ) => [...(roots.length > 0 ? [roots] : []), ...inherited, ...(target === undefined ? [] : inheritedFor(target))]

      const assignAuthority = (ref: FileReference | DirectoryReference, target?: Target) => {
        const chains = boundariesFor(target).filter((chain, index, all) =>
          !all.some((other, at) =>
            at !== index && other.length >= chain.length && chain.every((ino, offset) => other[offset] === ino) &&
            (other.length > chain.length || at < index)
          )
        )

        if (chains.length === 0) return
        ref.boundaries = chains
        const authorities = chains.map((chain) => Confinement.make(authorityView, chain))
        ref.authority = Effect.fnUntraced(function*(node: Node, op: OpContext) {
          for (const authority of authorities) yield* authority.check(node, op, true)
        })
      }

      const callerPath = boundary?.path ?? pathOfCurrent

      const resolver = Resolution.make({
        caller: reference,
        confinement: boundary,
        additional: additional.length === 0 ? undefined : additional,
        get: view,
        authorityView,
        identity,
        maxPathBytes: limits.maxPathBytes,
        registry
      })

      const prepare = resolver.prepare
      const prepareEntry = resolver.prepareEntry
      const entryName = Resolution.entryName

      const resolveTarget = (
        target: Target,
        op: OpContext,
        options?: Omit<Resolution.NodeMode, "kind" | "createMissing">
      ) => resolver.resolve(target, { kind: "Node", ...options }, op)

      const resolveDirectory = resolver.directory

      const resolveEntry = (prepared: PreparedEntry, op: OpContext) =>
        resolver.resolve(prepared, { kind: "Parent" }, op)

      const referencedNode = (target: ObjectReference, op: OpContext) =>
        Effect.map(resolveTarget(Target.Reference({ reference: target }), op), (resolved) => resolved.node)

      const directoryNow = Effect.fnUntraced(function*(ino: Ino) {
        const node = yield* view(ino)

        if (node?.kind !== "directory") {
          return dieInvariant("Directory left the inode table during a transition")
        }

        return node
      })

      const nodeNow = Effect.fnUntraced(function*(ino: Ino) {
        const node = yield* view(ino)

        if (node === undefined) return dieInvariant("Inode left the table during a transition")

        return node
      })

      const creationTimes = (times: Times | undefined, now: bigint) => ({
        atimeNs: times?.access.kind === "value" ? times.access.nanoseconds : now,
        mtimeNs: times?.modification.kind === "value" ? times.modification.nanoseconds : now
      })

      const newDirectory = Effect.fnUntraced(function*(parent: Directory, mode: number, now: bigint, times?: Times) {
        const draft = yield* Draft
        const ino = yield* draft.allocate

        return {
          kind: "directory",
          ino,
          parent: parent.ino,
          name: "",
          entries: new Map(),
          metadata: {
            ...directoryMetadata(BigInt(ino), identity.uid, parent.metadata.gid, mode, now),
            ...creationTimes(times, now)
          },
          revision: 0n
        } satisfies Directory
      })

      const newFile = Effect.fnUntraced(function*(
        parent: Directory,
        data: RegularFile["data"],
        mode: number,
        now: bigint,
        owner?: OwnerUpdate,
        times?: Times
      ) {
        const draft = yield* Draft
        const ino = yield* draft.allocate

        return {
          kind: "file",
          ino,
          data,
          links: [],
          metadata: {
            ...directoryMetadata(
              BigInt(ino),
              owner?.uid ?? identity.uid,
              owner?.gid ?? parent.metadata.gid,
              mode,
              now
            ),
            ...creationTimes(times, now),
            kind: "file",
            size: BigInt(data.length),
            nlink: 0
          },
          revision: 0n
        } satisfies RegularFile
      })

      const newSymlink = Effect.fnUntraced(
        function*(parent: Directory, target: Uint8Array, now: bigint, times?: Times) {
          const draft = yield* Draft
          const ino = yield* draft.allocate

          return {
            kind: "symlink",
            ino,
            target,
            links: [],
            metadata: {
              ...directoryMetadata(BigInt(ino), identity.uid, parent.metadata.gid, 0o777, now),
              ...creationTimes(times, now),
              kind: "symlink",
              nlink: 0,
              size: BigInt(target.length)
            },
            revision: 0n
          } satisfies SymbolicLink
        }
      )

      const grantedMode = (metadata: Pick<Metadata, "kind" | "gid">, mode: number) =>
        !identity.privileged && metadata.kind === "file" && !inGroup(identity, metadata.gid) ? mode & ~0o2000 : mode

      const permittedMode = (metadata: Pick<Metadata, "kind" | "uid" | "gid">, mode: number, op: OpContext) =>
        !identity.privileged && identity.uid !== metadata.uid
          ? Effect.fail(op.fail("NotPermitted"))
          : Effect.succeed(grantedMode(metadata, mode))

      // Changes the attributes one change at a time would, as one change: one draft, one revision, one event.
      // Every check runs against the node before any attribute applies, ownership (NotPermitted) before
      // permission (AccessDenied), so the first failure leaves everything unchanged. The attributes apply as
      // size, owner, mode, then times, the POSIX composition of chown then chmod, so a requested mode wins over
      // the set-ID clearing that a resize or an owner change triggers; an adapter owns any protocol-specific
      // sanitising of the mode, as NFS SETATTR does after knfsd. The attributes arrive validated; an owner with
      // neither id still checks ownership, and times that omit both are no change and check nothing. An expected
      // revision is checked first, against the target as the change finds it, so a caller that decided the
      // attributes from an earlier observation learns the target moved instead of applying them to a newer state.
      const changeAttributes = (
        resolve: () => Effect.Effect<ResolvedNode, FsFailure>,
        attributes: Attributes,
        op: OpContext
      ) => {
        const { size, mode } = attributes
        const expected = attributes.expected?.revision
        const owner = attributes.owner === undefined ? undefined : { ...attributes.owner }

        const times = attributes.times === undefined
          ? undefined
          : { access: { ...attributes.times.access }, modification: { ...attributes.times.modification } }

        const timed = times !== undefined && (times.access.kind !== "omit" || times.modification.kind !== "omit")
        const bothNow = times?.access.kind === "now" && times.modification.kind === "now"
        const resolving = resolve()

        return coordinated(
          op,
          Effect.gen(function*() {
            const resolved = yield* resolving
            const node = yield* nodeNow(resolved.ino)

            if (expected !== undefined && node.revision !== expected) {
              return yield* resolved.op.fail("StaleReference", { field: "expected" })
            }

            if (size !== undefined && node.kind === "symlink") return yield* resolved.op.fail("SymlinkLoop")

            if (size !== undefined && node.kind !== "file") return yield* resolved.op.fail("IsDirectory")
            const owns = identity.privileged || identity.uid === node.metadata.uid

            if (
              (mode !== undefined && !owns) ||
              (owner !== undefined && !identity.privileged && (!owns ||
                (owner.uid !== undefined && owner.uid !== node.metadata.uid) ||
                (owner.gid !== undefined && !inGroup(identity, owner.gid)))) ||
              // POSIX grants write access only when both times are UTIME_NOW; every other combination that
              // changes a time, mixed ones included, needs ownership.
              (timed && !owns && !bothNow)
            ) {
              return yield* resolved.op.fail("NotPermitted")
            }

            if (size !== undefined || (timed && !owns)) yield* authorize(node, identity, WRITE, resolved.op)
            const chowned = owner?.uid !== undefined || owner?.gid !== undefined

            if (size === undefined && !chowned && mode === undefined && !timed) return
            const now = yield* timestamp(op)

            if (size !== undefined && node.kind === "file") yield* resizeAt(node, size, now, op)
            const sized = yield* nodeNow(resolved.ino)
            const gid = owner?.gid ?? sized.metadata.gid
            const cleared = chowned && sized.kind === "file" ? sized.metadata.mode & ~SET_ID_BITS : sized.metadata.mode

            if (chowned || mode !== undefined || timed) {
              yield* (yield* Draft).put({
                ...sized,
                metadata: {
                  ...sized.metadata,
                  uid: owner?.uid ?? sized.metadata.uid,
                  gid,
                  mode: mode === undefined ? cleared : grantedMode({ kind: sized.kind, gid }, mode),
                  atimeNs: timeAt(times?.access, sized.metadata.atimeNs, now),
                  mtimeNs: timeAt(times?.modification, sized.metadata.mtimeNs, now),
                  ctimeNs: now
                }
              })
            }

            yield* publishNode(node.ino)
          })
        )
      }

      const authorizeRemoval = (parent: Directory, child: Node, op: OpContext) =>
        (parent.metadata.mode & STICKY_BIT) !== 0 && !identity.privileged &&
          identity.uid !== parent.metadata.uid && identity.uid !== child.metadata.uid
          ? Effect.fail(op.fail("NotPermitted"))
          : Effect.void

      const claimName = Effect.fnUntraced(function*(
        entry: ResolvedEntry,
        trailingSlash: "allowed" | "rejected" = "allowed"
      ) {
        const parent = yield* directoryNow(entry.parent)

        if (
          boundary !== undefined && parent.ino === boundary.root &&
          (entry.name === undefined || isDotComponent(entry.name))
        ) return yield* entry.op.fail("NotPermitted")

        if (isDotComponent(entry.name)) {
          return yield* entry.op.fail(entry.addressing === "entry" ? "InvalidArgument" : "AlreadyExists")
        }

        yield* authorize(parent, identity, EXECUTE, entry.op)

        if (parent.entries.has(entry.name)) return yield* entry.op.fail("AlreadyExists")

        if (trailingSlash === "rejected" && entry.trailingSlash) return yield* entry.op.fail("NotFound")
        yield* authorize(parent, identity, WRITE, entry.op)

        return entry.name
      })

      const makeDirectory = Effect.fnUntraced(function*(
        entry: ResolvedEntry,
        request: {
          readonly mode: number
          readonly exactMode?: boolean | undefined
          readonly times?: Times | undefined
        },
        op: OpContext
      ) {
        const name = yield* claimName(entry)

        yield* reserveEntry(entry.op)
        const parent = yield* directoryNow(entry.parent)
        const before = parent.revision
        const now = yield* timestamp(op)

        const mode = request.exactMode
          ? yield* permittedMode({ kind: "directory", uid: identity.uid, gid: parent.metadata.gid }, request.mode, op)
          : (request.mode & 0o777 & ~umask) | (request.mode & STICKY_BIT)

        const child = yield* newDirectory(parent, mode, now, request.times)

        yield* attach(parent, name, child, now)
        const draft = yield* Draft
        yield* draft.addEntries(1)
        yield* publishEntry("Create", parent.ino, name, child.ino)

        return { child: child.ino, directory: { before, after: draft.revision } }
      })

      // Creates every missing directory a path names in the running transition, so a failure anywhere discards
      // them all. The mode applies to each directory created and the times to the one in the final position. An
      // entry names one child, created unless it is already a directory. The result names the directory the path
      // ends on and its parent's revision before and after the call, so a final directory that already exists is
      // no change, while a path that leaves a directory it created, such as `new/..`, reports the creation.
      const makeDirectories = Effect.fnUntraced(function*(
        prepared: PreparedEntry,
        request: {
          readonly mode: number
          readonly exactMode?: boolean | undefined
          readonly times?: Times | undefined
        },
        op: OpContext
      ) {
        let node: Node | undefined
        let entryOp = op
        const revisionsBefore = new Map<Ino, bigint>()

        if (prepared.kind === "entry") {
          const entry = yield* resolveEntry(prepared, op)
          const made = yield* Effect.result(makeDirectory(entry, request, op))

          if (Result.isSuccess(made)) return made.success

          const existingIno = entry.name === undefined
            ? undefined
            : (yield* directoryNow(entry.parent)).entries.get(entry.name)

          node = existingIno === undefined ? undefined : (yield* view(existingIno))

          if (made.failure.code !== "AlreadyExists" || node?.kind !== "directory") return yield* made.failure
        } else {
          entryOp = op.at(prepared.path.input)

          const resolved = yield* resolver.resolve(
            Target.Path(
              prepared.base === undefined
                ? { path: prepared.path.input }
                : { path: prepared.path.input, relativeTo: prepared.base }
            ),
            {
              kind: "Node",
              createMissing: (parent, name, final) =>
                Effect.flatMap(
                  makeDirectory(
                    { parent: parent.ino, name, trailingSlash: false, addressing: "path", op: entryOp },
                    final ? request : { mode: request.mode, exactMode: request.exactMode },
                    op
                  ),
                  (made) => {
                    if (!revisionsBefore.has(parent.ino)) revisionsBefore.set(parent.ino, made.directory.before)

                    return directoryNow(made.child)
                  }
                )
            },
            op
          )

          node = resolved.node
        }

        if (node?.kind !== "directory") return yield* entryOp.fail("AlreadyExists")
        const after = (yield* directoryNow(node.parent)).revision

        return { child: node.ino, directory: { before: revisionsBefore.get(node.parent) ?? after, after } }
      })

      const linkNode = Effect.fnUntraced(
        function*(node: Exclude<Node, Directory>, entry: ResolvedEntry, op: OpContext) {
          const name = yield* claimName(entry, "rejected")
          yield* reserveEntry(entry.op)
          const parent = yield* directoryNow(entry.parent)
          const before = parent.revision
          const now = yield* timestamp(op)
          yield* attach(parent, name, node, now)
          const draft = yield* Draft
          yield* draft.addEntries(1)
          yield* publishEntry("Create", parent.ino, name, node.ino)

          return { before, after: draft.revision }
        }
      )

      const makeSymlink = Effect.fnUntraced(function*(
        entry: ResolvedEntry,
        target: Uint8Array,
        times: Times | undefined,
        op: OpContext
      ) {
        const name = yield* claimName(entry, "rejected")
        yield* reserveEntry(entry.op)
        yield* reserveBytes(entry.op, BigInt(target.length))
        const parent = yield* directoryNow(entry.parent)
        const before = parent.revision
        const now = yield* timestamp(op)
        const child = yield* newSymlink(parent, target, now, times)

        yield* attach(parent, name, child, now)
        const draft = yield* Draft
        yield* draft.addEntries(1)
        yield* draft.addUsedBytes(BigInt(target.length))
        yield* publishEntry("Create", parent.ino, name, child.ino)

        return { child: child.ino, directory: { before, after: draft.revision } }
      })

      const removeChild = Effect.fnUntraced(function*(parent: Directory, name: string, child: Node, op: OpContext) {
        const before = parent.revision
        const now = yield* timestamp(op)
        const d = yield* Draft
        yield* d.put(withEntries(
          {
            ...parent,
            metadata: {
              ...parent.metadata,
              nlink: parent.metadata.nlink - (child.kind === "directory" ? 1 : 0),
              mtimeNs: now,
              ctimeNs: now
            }
          },
          DirectoryEntries.remove(parent.entries, name)
        ))
        yield* publishEntry("Remove", parent.ino, name, child.ino)
        yield* detach(child, parent.ino, name, now)
        yield* d.addEntries(-1)

        return { before, after: d.revision }
      })

      // Authorizes removing from the entry's directory and returns the named child. Only a path can name a dot
      // entry, and each verb reports it with its own code. Search permission comes before the lookup and write
      // permission after it, as on Linux; `beforeWrite` holds the verb's own checks that Linux makes in between.
      const protectsRoot = (parent: Directory, name: string | undefined) =>
        boundary !== undefined &&
        ((parent.ino === boundary.root && (name === undefined || isDotComponent(name))) ||
          (name === "2e2e" && parent.parent === boundary.root))

      const removalTarget = Effect.fnUntraced(function*(
        entry: ResolvedEntry,
        dotNameCode: "IsDirectory" | "InvalidArgument",
        beforeWrite?: (child: Node) => FsFailure | undefined
      ) {
        const parent = yield* directoryNow(entry.parent)

        if (
          protectsRoot(parent, entry.name)
        ) return yield* entry.op.fail("NotPermitted")

        if (isDotComponent(entry.name)) {
          return yield* entry.op.fail(entry.addressing === "entry" ? "InvalidArgument" : dotNameCode)
        }

        yield* authorize(parent, identity, EXECUTE, entry.op)
        const childIno = parent.entries.get(entry.name)
        const child = childIno === undefined ? undefined : (yield* view(childIno))

        if (child === undefined) return yield* entry.op.fail("NotFound")

        if (child.ino === boundary?.root) return yield* entry.op.fail("NotPermitted")
        const rejected = beforeWrite?.(child)

        if (rejected !== undefined) return yield* rejected
        yield* authorize(parent, identity, WRITE, entry.op)

        return { parent, name: entry.name, child }
      })

      const removeEntry = Effect.fnUntraced(function*(entry: ResolvedEntry, op: OpContext) {
        const { child, name, parent } = yield* removalTarget(
          entry,
          "InvalidArgument",
          (found) => entry.trailingSlash && found.kind !== "directory" ? entry.op.fail("NotDirectory") : undefined
        )

        yield* authorizeRemoval(parent, child, entry.op)

        if (child.kind === "directory" && child.entries.size > 0) return yield* entry.op.fail("NotEmpty")

        return yield* removeChild(parent, name, child, op)
      })

      const unlinkEntry = Effect.fnUntraced(function*(entry: ResolvedEntry, op: OpContext) {
        const { child, name, parent } = yield* removalTarget(
          entry,
          "IsDirectory",
          (found) =>
            !entry.trailingSlash
              ? undefined
              : entry.op.fail(found.kind === "directory" ? "IsDirectory" : "NotDirectory")
        )

        if (child.kind === "directory") return yield* entry.op.fail("IsDirectory")
        yield* authorizeRemoval(parent, child, entry.op)

        return yield* removeChild(parent, name, child, op)
      })

      const rmdirEntry = Effect.fnUntraced(function*(entry: ResolvedEntry, op: OpContext) {
        const { child, name, parent } = yield* removalTarget(entry, "InvalidArgument")
        yield* authorizeRemoval(parent, child, entry.op)

        if (child.kind !== "directory") return yield* entry.op.fail("NotDirectory")

        if (child.entries.size > 0) return yield* entry.op.fail("NotEmpty")

        return yield* removeChild(parent, name, child, op)
      })

      const renameEntry = Effect.fnUntraced(
        function*(source: ResolvedEntry, destination: ResolvedEntry, op: OpContext) {
          const sourceDirectory = yield* directoryNow(source.parent)
          const destinationDirectory = yield* directoryNow(destination.parent)
          const sameDirectory = source.parent === destination.parent
          const sourceName = source.name
          const destinationName = destination.name

          if (
            protectsRoot(sourceDirectory, sourceName) || protectsRoot(destinationDirectory, destinationName)
          ) return yield* source.op.fail("NotPermitted")

          if (isDotComponent(sourceName) || isDotComponent(destinationName)) {
            return yield* source.op.fail("InvalidArgument")
          }

          // Linux's order: search permission on both directories before either name is looked up; the names,
          // trailing slashes, the subtree rule and the same-object no-op; then write permission and the rest.
          yield* authorize(sourceDirectory, identity, EXECUTE, source.op)
          yield* authorize(destinationDirectory, identity, EXECUTE, destination.op)
          const sourceBefore = sourceDirectory.revision
          const destinationBefore = destinationDirectory.revision
          const childIno = sourceDirectory.entries.get(sourceName)
          const child = childIno === undefined ? undefined : (yield* view(childIno))

          if (child === undefined) return yield* source.op.fail("NotFound")
          const replacedIno = destinationDirectory.entries.get(destinationName)
          const replaced = replacedIno === undefined ? undefined : (yield* view(replacedIno))

          if (boundary !== undefined && (child.ino === boundary.root || replaced?.ino === boundary.root)) {
            return yield* source.op.fail("NotPermitted")
          }

          // A trailing slash on either side asks for a directory; a missing slashed destination is fine when the
          // source is one, as Linux allows.
          if ((source.trailingSlash || destination.trailingSlash) && child.kind !== "directory") {
            return yield* (source.trailingSlash ? source.op : destination.op).fail("NotDirectory")
          }

          if (destination.trailingSlash && replaced !== undefined && replaced.kind !== "directory") {
            return yield* destination.op.fail("NotDirectory")
          }

          const result = Effect.fnUntraced(function*() {
            return sameDirectory
              ? {
                _tag: "SameDirectory" as const,
                directory: { before: sourceBefore, after: (yield* directoryNow(source.parent)).revision }
              }
              : {
                _tag: "DifferentDirectories" as const,
                sourceDirectory: { before: sourceBefore, after: (yield* directoryNow(source.parent)).revision },
                destinationDirectory: {
                  before: destinationBefore,
                  after: (yield* directoryNow(destination.parent)).revision
                }
              }
          })

          for (let ancestor = destinationDirectory;; ancestor = yield* directoryNow(ancestor.parent)) {
            if (ancestor.ino === child.ino) return yield* destination.op.fail("InvalidArgument")

            if (ancestor.ino === ROOT_INO) break
          }

          if (child.ino === replaced?.ino) return yield* result()
          yield* authorize(sourceDirectory, identity, WRITE, source.op)
          yield* authorize(destinationDirectory, identity, WRITE, destination.op)
          yield* authorizeRemoval(sourceDirectory, child, source.op)

          if (replaced !== undefined) {
            yield* authorizeRemoval(destinationDirectory, replaced, destination.op)

            if (child.kind === "directory" && replaced.kind !== "directory") {
              return yield* destination.op.fail("NotDirectory")
            }

            if (child.kind !== "directory" && replaced.kind === "directory") {
              return yield* destination.op.fail("IsDirectory")
            }

            if (replaced.kind === "directory" && replaced.entries.size > 0) {
              return yield* destination.op.fail("NotEmpty")
            }
          }

          const now = yield* timestamp(op)
          const d = yield* Draft

          yield* d.rename({
            ino: child.ino,
            from: { parent: source.parent, name: sourceName },
            to: { parent: destination.parent, name: destinationName }
          })
          yield* publishEntry("Remove", sourceDirectory.ino, sourceName, child.ino)
          yield* d.put(withEntries(
            {
              ...sourceDirectory,
              metadata: {
                ...sourceDirectory.metadata,
                nlink: sourceDirectory.metadata.nlink - (child.kind === "directory" ? 1 : 0),
                mtimeNs: now,
                ctimeNs: now
              }
            },
            DirectoryEntries.remove(sourceDirectory.entries, sourceName)
          ))

          const destinationNow = yield* directoryNow(destination.parent)
          yield* d.put(withEntries(
            {
              ...destinationNow,
              metadata: {
                ...destinationNow.metadata,
                nlink: destinationNow.metadata.nlink + (child.kind === "directory" && replaced === undefined ? 1 : 0),
                mtimeNs: now,
                ctimeNs: now
              }
            },
            DirectoryEntries.set(destinationNow.entries, destinationName, child.ino)
          ))

          const moved = yield* nodeNow(child.ino)

          if (moved.kind === "directory") {
            yield* d.put({
              ...moved,
              parent: destination.parent,
              name: destinationName,
              metadata: { ...moved.metadata, ctimeNs: now }
            })
          } else {
            yield* d.put({
              ...moved,
              links: [
                ...withoutLink(moved.links, source.parent, sourceName),
                { parent: destination.parent, name: destinationName }
              ],
              metadata: { ...moved.metadata, ctimeNs: now }
            })
          }

          if (replaced !== undefined) {
            yield* detach(yield* nodeNow(replaced.ino), destination.parent, destinationName, now)
            yield* d.addEntries(-1)
          }

          yield* publishEntry("Create", destination.parent, destinationName, child.ino)

          return yield* result()
        }
      )

      const openExisting = Effect.fnUntraced(function*(
        file: RegularFile,
        request: Pick<OpenRequest, "access" | "truncate">,
        at: OpContext,
        op: OpContext
      ) {
        yield* authorize(
          file,
          identity,
          request.access === "read" ? READ : request.access === "write" ? WRITE : READ | WRITE,
          at
        )

        if (request.truncate) yield* resize(file, 0n, op)
      })

      type NamedEntry = ResolvedEntry & { readonly name: string }

      const openFile = Effect.fnUntraced(function*(
        entry: NamedEntry,
        found: Node | undefined,
        request: OpenRequest,
        acquired: FileReference,
        op: OpContext
      ) {
        const { name } = entry
        const parent = yield* directoryNow(entry.parent)
        const before = parent.revision
        let file = found
        let created = false

        if (file === undefined) {
          if (request.create === undefined || request.create === "never") return yield* entry.op.fail("NotFound")

          yield* authorize(parent, identity, WRITE | EXECUTE, entry.op)
          yield* reserveEntry(entry.op)
          const size = request.initialSize ?? 0n

          if (request.initialSize !== undefined) {
            if (size < 0n) return yield* entry.op.fail("InvalidArgument")

            if (size > BigInt(maxFileBytes)) return yield* entry.op.fail("FileTooLarge")
            yield* reserveBytes(entry.op, size)
          }

          const owner = request.owner

          if (
            !identity.privileged &&
            ((owner?.uid !== undefined && owner.uid !== identity.uid) ||
              (owner?.gid !== undefined && !inGroup(identity, owner.gid)))
          ) {
            return yield* entry.op.fail("NotPermitted")
          }

          const now = yield* timestamp(op)

          const mode = request.exactMode
            ? yield* permittedMode(
              { kind: "file", uid: owner?.uid ?? identity.uid, gid: owner?.gid ?? parent.metadata.gid },
              request.mode!,
              op
            )
            : (request.mode ?? 0o666) & 0o777 & ~umask

          file = yield* newFile(parent, new Uint8Array(Number(size)), mode, now, owner, request.times)
          yield* attach(parent, name, file, now)
          const draft = yield* Draft
          yield* draft.addEntries(1)
          yield* draft.addUsedBytes(size)
          created = true
          yield* publishEntry("Create", parent.ino, name, file.ino)
        } else {
          if (file.kind === "symlink") return yield* entry.op.fail("SymlinkLoop")

          if (file.kind !== "file") return yield* entry.op.fail("IsDirectory")
          yield* openExisting(file, request, entry.op, op)
        }

        yield* (yield* Draft).retain(file.ino)
        yield* bindFile(acquired, file.ino)

        return { ino: file.ino, created, directory: { before, after: (yield* directoryNow(entry.parent)).revision } }
      })

      const releasePending = (opened: () => Ino | undefined) => () =>
        Effect.gen(function*() {
          const ino = opened()

          if (ino === undefined) return
          yield* releaseFileInode(ino)
        })

      const acquireOpenedFile = <A, E, R>(
        ref: FileReference,
        op: OpContext,
        acquire: (opened: (ino: Ino) => void) => Effect.Effect<A, E, R>
      ) => {
        let opened: Ino | undefined

        return Effect.andThen(
          preflight(op),
          acquireHandle(
            ref,
            (effect) => coordinated(op, effect),
            acquire((ino) => {
              opened = ino
            }),
            releasePending(() => opened),
            finalizeFile(ref)
          )
        )
      }

      const asResolvedNode = (target: Target, op: OpContext, options?: { readonly followFinalSymlink?: boolean }) =>
        Effect.map(
          resolveTarget(target, op, options),
          (resolved): ResolvedNode => ({ ino: resolved.node.ino, op: resolved.op })
        )

      const asTarget = (input: TargetInput): Target => Target.of(input)

      const acquireDirectory = Effect.fnUntraced(function*(input: TargetInput, op: OpContext) {
        yield* preflight(op)
        const target = asTarget(input)
        const acquired = makeDirectoryReference()

        return yield* acquireHandle(
          acquired,
          (acquire) => coordinatedRead(op, Effect.uninterruptible(acquire)),
          Effect.gen(function*() {
            const directory = yield* resolveDirectory(target, op)
            yield* authorize(directory.node, identity, EXECUTE, directory.op)
            assignAuthority(acquired, target)
            const candidates = acquired.boundaries ?? []

            if (candidates.length === 1) acquired.namespaceRoots = candidates[0]
            let current: Directory = directory.node

            while (candidates.length > 1) {
              const nearest = candidates.find((chain) => chain.at(-1) === current.ino)

              if (nearest !== undefined) {
                acquired.namespaceRoots = nearest
                break
              }

              if (current.ino === ROOT_INO) break
              current = yield* directoryNow(current.parent)
            }

            holdDirectory(directory.node.ino)
            TokenRegistry.publish(acquired, directory.node.ino)

            return acquired
          }),
          // Nothing to undo here: the finalizer that follows an interrupted acquisition releases the hold under
          // every permit, where a detached directory may leave the table.
          () => Effect.void,
          finalizeDirectory(acquired)
        )
      })

      const fail = (op: OpContext, cause?: unknown, field?: string) =>
        op.fail("InvalidArgument", field === undefined ? { cause } : { cause, field })

      const preparedOp = (prepared: PreparedEntry, op: OpContext) =>
        prepared.kind === "path" ? op.at(prepared.path.input) : op

      const openPath = Effect.fnUntraced(
        function*(target: Extract<Target, { _tag: "Path" }>, options: OpenOptions, op: OpContext) {
          const pathOp = op.at(target.path)
          const prepared = prepare(target.path, op)
          const chosen = yield* decodeOpenOptions(options).pipe(Effect.mapError((cause) => fail(pathOp, cause)))

          if (chosen.access === "read" && (chosen.append || chosen.truncate)) {
            return yield* pathOp.fail("InvalidArgument")
          }

          if (chosen.mode !== undefined && (chosen.create === undefined || chosen.create === "never")) {
            return yield* pathOp.fail("InvalidArgument")
          }

          const acquired = makeFileReference(chosen.access, chosen.append ?? false)
          const follow = target.followFinalSymlink ?? true

          return yield* acquireOpenedFile(
            acquired,
            op,
            (opened) =>
              Effect.gen(function*() {
                const path = yield* Effect.fromResult(prepared)

                const resolved = yield* resolver.resolve({ kind: "path", path, base: target.relativeTo }, {
                  kind: "OrCreate",
                  create: chosen.create ?? "never",
                  finalSymlink: follow ? "follow" : "preserve"
                }, op)

                const { parent, name } = resolved

                if (resolved.kind === "missing" && path.trailingSlash) return yield* pathOp.fail("IsDirectory")
                yield* authorize(parent, identity, EXECUTE, pathOp)
                const file = resolved.kind === "existing" ? resolved.node : undefined

                const result = yield* openFile(
                  { parent: parent.ino, name, trailingSlash: path.trailingSlash, addressing: "path", op: pathOp },
                  file,
                  chosen,
                  acquired,
                  op
                )

                opened(result.ino)

                assignAuthority(acquired, target)

                return fileHandle(acquired)
              })
          )
        }
      )

      const openNode = Effect.fnUntraced(function*(target: Target, options: OpenOptions, op: OpContext) {
        const chosen = yield* decodeOpenOptions(options).pipe(Effect.mapError((cause) => fail(op, cause)))

        if (chosen.access === "read" && (chosen.append || chosen.truncate)) return yield* op.fail("InvalidArgument")

        if ((chosen.create !== undefined && chosen.create !== "never") || chosen.mode !== undefined) {
          return yield* op.fail("InvalidArgument")
        }

        const acquired = makeFileReference(chosen.access, chosen.append ?? false)

        return yield* acquireOpenedFile(
          acquired,
          op,
          (opened) =>
            Effect.gen(function*() {
              const resolved = yield* resolveTarget(target, op)
              const node = resolved.node

              if (node.kind !== "file") return yield* resolved.op.fail("IsDirectory")

              if (node.metadata.nlink === 0) return yield* resolved.op.fail("StaleReference")
              yield* openExisting(node, chosen, resolved.op, op)
              const draft = yield* Draft
              yield* draft.retain(node.ino)
              yield* bindFile(acquired, node.ino)
              opened(node.ino)

              assignAuthority(acquired, target)

              return fileHandle(acquired)
            })
        )
      })

      const openEntry = Effect.fnUntraced(function*(entry: Entry, options: OpenEntryOptions, op: OpContext) {
        const name = yield* Effect.fromResult(entryName(entry.name, op))
        const decoded = yield* decodeOpenEntryOptions(options).pipe(Effect.mapError((cause) => fail(op, cause)))
        const chosen = { ...decoded }

        if (chosen.access === "read" && (chosen.append || chosen.truncate)) return yield* op.fail("InvalidArgument")

        if (
          (chosen.mode !== undefined || chosen.times !== undefined || chosen.initialSize !== undefined ||
            chosen.exactMode !== undefined || chosen.owner !== undefined) &&
          (chosen.create === undefined || chosen.create === "never")
        ) {
          return yield* op.fail("InvalidArgument")
        }

        if (chosen.exactMode && chosen.mode === undefined) return yield* op.fail("InvalidArgument")
        const acquired = makeFileReference(chosen.access, chosen.append ?? false)
        const expected = chosen.expected

        return yield* acquireOpenedFile(
          acquired,
          op,
          (opened) =>
            Effect.gen(function*() {
              const resolved = yield* resolver.resolve({ kind: "entry", directory: entry.directory, name }, {
                kind: "OrCreate",
                create: chosen.create ?? "never",
                finalSymlink: chosen.followFinalSymlink !== false ? "follow" : "preserve",
                beforeFollow: Effect.fnUntraced(function*(_, direct) {
                  if (expected !== undefined) {
                    let expectedIno: Ino | undefined

                    if (expected !== null) {
                      const observed = yield* Effect.result(referencedNode(expected, op))

                      if (Result.isFailure(observed)) {
                        return yield* op.fail("VolumeBusy", { cause: observed.failure })
                      }

                      expectedIno = observed.success.ino
                    }

                    if (direct?.ino !== expectedIno) return yield* op.fail("VolumeBusy")
                  }

                  if (chosen.expectedChild === null) {
                    if (direct !== undefined) return yield* op.fail("StaleReference")
                  } else if (chosen.expectedChild !== undefined) {
                    const expectedChild = chosen.expectedChild
                    const observed = yield* referencedNode(expectedChild.reference, op)

                    if (
                      direct?.ino !== observed.ino || observed.revision !== expectedChild.revision ||
                      observed.metadata.atimeNs !== expectedChild.atimeNs ||
                      observed.metadata.mtimeNs !== expectedChild.mtimeNs
                    ) {
                      return yield* op.fail("StaleReference")
                    }
                  }
                })
              }, op)

              const file = resolved.kind === "existing" ? resolved.node : undefined
              const mutationParent = resolved.kind === "missing" ? resolved.parent.ino : resolved.origin.parent.ino
              const mutationName = resolved.kind === "missing" ? resolved.name : resolved.origin.name

              const result = yield* openFile(
                { parent: mutationParent, name: mutationName, trailingSlash: false, addressing: "entry", op },
                file,
                { ...chosen, initialSize: chosen.initialSize ?? 0n },
                acquired,
                op
              )

              opened(result.ino)

              return {
                handle: (() => {
                  assignAuthority(acquired, entry.directory)

                  return fileHandle(acquired)
                })(),
                reference: referenceFor(result.ino),
                created: result.created,
                directory: result.directory
              }
            })
        )
      })

      const walkChildren = Effect.fnUntraced(function*(
        directory: Directory,
        path: Uint8Array,
        depth: number,
        up: WalkFrame | undefined
      ) {
        const listed = referenceFor(directory.ino)
        const frames: Array<WalkFrame> = []

        for (const [name, childIno] of Arr.sort(directory.entries, byEntryName)) {
          const child = yield* view(childIno)

          if (child === undefined) continue
          const bytes = nameBytes(name)

          frames.push({
            ino: child.ino,
            kind: child.kind,
            name: bytes,
            key: name,
            path: joinPath(path, bytes),
            parent: directory.ino,
            up,
            depth: depth + 1,
            bytes: child.kind === "directory" ? 0n : child.metadata.size,
            reference: referenceFor(child.ino),
            directory: listed,
            listed: false
          })
        }

        return frames
      })

      const anchorFrame = (parent: Directory, key: string, root: Directory): WalkFrame => ({
        ino: root.ino,
        kind: root.kind,
        name: nameBytes(key),
        key,
        path: new Uint8Array(0),
        parent: parent.ino,
        up: undefined,
        depth: 0,
        bytes: 0n,
        reference: referenceFor(root.ino),
        directory: referenceFor(parent.ino),
        listed: false
      })

      const pathAnchor = (target: Target, root: Directory, op: OpContext): Effect.Effect<WalkFrame | undefined> => {
        if (!Target.$is("Path")(target)) return Effect.undefined
        const prepared = prepare(target.path, op)

        if (Result.isFailure(prepared)) return Effect.undefined

        return resolveEntry({ kind: "path", path: prepared.success, base: target.relativeTo }, op).pipe(
          Effect.flatMap((entry) =>
            Effect.map(view(entry.parent), (parent) => {
              return entry.name !== undefined && parent?.kind === "directory" &&
                  parent.entries.get(entry.name) === root.ino
                ? anchorFrame(parent, entry.name, root)
                : undefined
            })
          ),
          Effect.catch(() => Effect.undefined)
        )
      }

      const holds = (parent: Node | undefined, frame: WalkFrame): parent is Directory =>
        parent?.kind === "directory" && parent.metadata.nlink > 0 && parent.entries.get(frame.key) === frame.ino

      // The node a frame names, reached by name from the walk's root as a path lookup reaches it: every directory on
      // the way must be searchable and must still hold the name the walk listed for the object it listed. A frame
      // whose chain no longer holds it, such as a directory renamed out of the tree, reaches nothing. A root the
      // walk reached by name is anchored by that name, so a root moved away reaches nothing too; a root reached
      // through a reference or a handle is held by the object it resolved to, as a descriptor holds it.
      // It steps down the chain in a loop, so a tree of any depth reaches its frames without deepening the stack.
      const reachFrame = (frame: WalkFrame, at: OpContext): Effect.Effect<Node | undefined, FsFailure> =>
        Effect.gen(function*() {
          if (boundary !== undefined) yield* boundary.alive(at)
          const chain: Array<WalkFrame> = []

          for (let link: WalkFrame | undefined = frame; link !== undefined; link = link.up) chain.push(link)
          let node: Node | undefined = yield* view((chain.at(-1) ?? frame).parent)

          if (node !== undefined) yield* checkAuthority(node, at)

          for (let index = chain.length - 1; index >= 0; index--) {
            const link = chain[index]

            if (link === undefined || node?.kind !== "directory" || node.metadata.nlink === 0) return undefined
            yield* authorize(node, identity, EXECUTE, at)
            node = node.entries.get(link.key) === link.ino ? (yield* view(link.ino)) : undefined
          }

          return node
        })

      // Walks the tree below the directory `first` lists, depth first. Every later directory is read in its own
      // observation, so a walk holds one permit at a time and never a handle; it writes nothing, so it refreshes no
      // access time. Each directory is reached by name, so it needs search permission on the directories above it,
      // and one that left the tree after it was listed has nothing to walk. A directory past `maxDepth` is never
      // read. `locate` names an entry's path in a failure, and `listable` authorizes reading a directory. Entries
      // gathered before a failure are handed on before the failure is.
      const walkFrames = <E extends WalkFailure = never>(
        op: OpContext,
        first: Effect.Effect<Array<WalkFrame>, FsFailure>,
        plan: WalkPlan<E>,
        locate: (path: Uint8Array) => PathInput,
        listable: (directory: Directory, at: OpContext) => Effect.Effect<void, FsFailure>
      ): Stream.Stream<WalkFrame, FsFailure | E> =>
        Stream.suspend(() => {
          let pending: Array<WalkFrame> | undefined
          let entries = 0
          let bytes = 0n
          let failure: FsFailure | E | undefined

          const list = (frame: WalkFrame) =>
            coordinatedRead(
              op,
              Effect.suspend(() => {
                if (TokenRegistry.inode(reference) === undefined) return Effect.fail(op.fail("ClosedCaller"))
                const at = op.at(locate(frame.path))

                return Effect.flatMap(reachFrame(frame, at), (node) =>
                  node?.kind !== "directory" || node.metadata.nlink === 0
                    ? Effect.succeed([])
                    : Effect.andThen(listable(node, at), walkChildren(node, frame.path, frame.depth, frame)))
              })
            )

          const admit = (frame: WalkFrame): E | undefined => {
            entries++
            bytes += frame.bytes

            return plan.limit(frame, { entries, bytes }, "entry")
          }

          const step = Effect.gen(function*() {
            // Preserve the generic limit error E; yielding the error directly widens it to WalkFailure.
            // oxlint-disable-next-line effecttsgo/unnecessary-fail-yieldable-error -- E must stay narrow for unbounded removal.
            if (failure !== undefined) return yield* Effect.fail(failure)

            if (pending === undefined) pending = (yield* first).reverse()
            const out: Array<WalkFrame> = []

            const stop = (error: FsFailure | E) => {
              if (out.length === 0) return Effect.fail(error)
              failure = error

              return Effect.succeed([out, Option.some(undefined)] as const)
            }

            while (out.length < WALK_CHUNK_ENTRIES) {
              const frame = pending.pop()

              if (frame === undefined) return [out, Option.none()] as const
              const unlisted = frame.kind === "directory" && !frame.listed

              if (!unlisted || plan.order === "pre") {
                const rejected = admit(frame)

                if (rejected !== undefined) return yield* stop(rejected)
                out.push(frame)
              }

              if (unlisted) {
                const rejected = plan.limit(frame, { entries, bytes }, "directory")

                if (rejected !== undefined) return yield* stop(rejected)

                const listed = yield* Effect.result(list(frame))

                if (Result.isFailure(listed)) return yield* stop(listed.failure)

                if (plan.order === "post") pending.push({ ...frame, listed: true })

                for (let index = listed.success.length - 1; index >= 0; index--) {
                  const child = listed.success[index]

                  if (child !== undefined) pending.push(child)
                }

                return [out, Option.some(undefined)] as const
              }
            }

            return [out, Option.some(undefined)] as const
          })

          return Stream.paginate(undefined, () => step)
        })

      // Empties the directory an entry names, entries before their directories, each removal its own change. Each
      // entry is removed by its name in the directory the walk reached by name from the target's name, and only
      // while that name still holds the object the walk listed, so a subtree renamed out of the target, the target
      // renamed away, and a replacement created under a listed name are all left alone. It stops at the first
      // failure, which names the entry's path under the one the caller gave. Removing an empty directory reveals nothing, so only a directory with entries must be readable, and
      // no permission is changed to make one so. With `force`, the entry itself going missing leaves nothing to
      // empty.
      const emptyDirectory = Effect.fnUntraced(
        function*(prepared: PreparedEntry, op: OpContext, force: boolean, guard: Effect.Effect<void, FsFailure>) {
          const prefix = prepared.kind === "path" ? prepared.path.bytes : nameBytes(prepared.name)
          const locate = (path: Uint8Array): PathInput => ownedPath(joinPath(prefix, path))

          const targetGuard = guard.pipe(
            Effect.catchIf((error) => force && error.code === "NotFound", () => Effect.void)
          )

          const listable = (directory: Directory, at: OpContext) =>
            Effect.andThen(
              targetGuard,
              directory.entries.size === 0 ? Effect.void : authorize(directory, identity, READ, at)
            )

          let anchor: WalkFrame | undefined
          let targetAt = preparedOp(prepared, op)

          const first = coordinatedRead(
            op,
            Effect.gen(function*() {
              yield* guard
              const entry = yield* resolveEntry(prepared, op)
              const parent = yield* directoryNow(entry.parent)
              yield* authorize(parent, identity, EXECUTE, entry.op)
              const childIno = entry.name === undefined ? undefined : parent.entries.get(entry.name)
              const child = childIno === undefined ? undefined : (yield* view(childIno))

              if (entry.name === undefined || child === undefined) return yield* entry.op.fail("NotFound")

              if (child.kind !== "directory") return []
              yield* listable(child, entry.op)
              anchor = anchorFrame(parent, entry.name, child)
              targetAt = entry.op

              return yield* walkChildren(child, new Uint8Array(0), 0, anchor)
            })
          ).pipe(
            Effect.catchIf((error) => force && error.code === "NotFound", () => Effect.succeed([]))
          )

          const seams = yield* VolumeTestSeams

          const removeFrame = (frame: WalkFrame) => {
            const at = op.at(locate(frame.path))

            return Effect.andThen(
              seams.beforeTreeRemoval,
              coordinated(
                op,
                Effect.gen(function*() {
                  yield* targetGuard

                  if (anchor !== undefined && !holds(yield* view(anchor.parent), anchor)) {
                    return yield* (force ? Effect.void : Effect.fail(targetAt.fail("NotFound")))
                  }

                  return yield* Effect.flatMap(
                    frame.up === undefined ? view(frame.parent) : reachFrame(frame.up, at),
                    (parent) =>
                      !holds(parent, frame)
                        ? Effect.fail(at.fail("NotFound"))
                        : removeEntry({
                          parent: parent.ino,
                          name: frame.key,
                          trailingSlash: false,
                          addressing: "entry",
                          op: at
                        }, op)
                  )
                })
              )
            )
          }

          const plan: WalkPlan = { order: "post", limit: () => undefined }

          return yield* Stream.runForEach(walkFrames(op, first, plan, locate, listable), removeFrame)
        }
      )

      const rootOp = OpContext.make("root")

      const entryVerb = Effect.fnUntraced(function*<A>(
        operation: string,
        input: EntryInput,
        body: (entry: ResolvedEntry, op: OpContext) => Effect.Effect<A, FsFailure, Draft>
      ) {
        const op = OpContext.make(operation)
        const prepared = yield* Effect.fromResult(prepareEntry(input, op))

        return yield* coordinated(op, Effect.flatMap(resolveEntry(prepared, op), (entry) => body(entry, op)))
      })

      const openDispatch = Effect.fnUntraced(
        function*(input: TargetInput | Entry, options: OpenOptions | OpenEntryOptions) {
          const op = OpContext.make("open")

          if (isEntry(input)) return yield* openEntry(input, options, op)
          const target = asTarget(input)

          if (Target.$is("Path")(target)) return yield* openPath(target, options, op)

          return yield* openNode(target, options, op)
        }
      )

      function open(
        input: Target | PathInput | ObjectReference | FileHandle,
        options: OpenOptions
      ): Effect.Effect<FileHandle, FsFailure, Scope.Scope>
      function open(input: Entry, options: OpenEntryOptions): Effect.Effect<OpenEntryResult, FsFailure, Scope.Scope>
      function open(
        input: TargetInput | Entry,
        options: OpenOptions | OpenEntryOptions
      ): Effect.Effect<FileHandle | OpenEntryResult, FsFailure, Scope.Scope> {
        return openDispatch(input, options)
      }

      const removeDispatch = Effect.fnUntraced(function*(input: EntryInput, options?: RemoveOptions) {
        const op = OpContext.make("remove")
        const prepared = yield* Effect.fromResult(prepareEntry(input, op))

        const chosen = yield* decodeRemoveOptions(options ?? {}).pipe(
          Effect.mapError((cause) => fail(preparedOp(prepared, op), cause))
        )

        const imported = prepared.kind === "entry"
          ? inheritedFor(prepared.directory)
          : prepared.base === undefined
          ? []
          : registry.handleBoundaries(prepared.base)

        const guard = chosen.expected === undefined && imported.length === 0 ? Effect.void : Effect.gen(function*() {
          const entry = yield* resolveEntry(prepared, op)
          const parent = yield* directoryNow(entry.parent)

          if (protectsRoot(parent, entry.name)) return yield* entry.op.fail("NotPermitted")

          if (chosen.expected === undefined) return
          const expected = yield* registry.referenceIdentity(chosen.expected, op)
          const expectedNode = yield* view(expected)

          if (expectedNode !== undefined && expectedNode.metadata.nlink > 0) yield* checkAuthority(expectedNode, op)
          yield* authorize(parent, identity, EXECUTE, entry.op)
          const found = entry.name === undefined ? parent.ino : parent.entries.get(entry.name)

          if (found === undefined) return yield* entry.op.fail("NotFound")

          if (found !== expected) return yield* entry.op.fail("VolumeBusy", { field: "expected" })
        })

        const once = coordinated(
          op,
          Effect.andThen(guard, Effect.flatMap(resolveEntry(prepared, op), (entry) => removeEntry(entry, op)))
        )

        const target = <A>(effect: Effect.Effect<A, FsFailure>) =>
          chosen.force === true
            ? Effect.catchIf(effect, (error) => error.code === "NotFound", () => Effect.undefined)
            : effect

        const removed = yield* Effect.result(target(once))

        if (Result.isSuccess(removed)) return removed.success

        if (chosen.recursive !== true || removed.failure.code !== "NotEmpty") return yield* removed.failure
        yield* emptyDirectory(prepared, op, chosen.force === true, guard)

        return yield* target(once)
      })

      function remove(
        input: EntryInput,
        options?: RemoveOptions & { readonly force?: false }
      ): Effect.Effect<DirectoryChange, FsFailure>
      function remove(input: EntryInput, options: RemoveOptions): Effect.Effect<DirectoryChange | undefined, FsFailure>
      function remove(
        input: EntryInput,
        options?: RemoveOptions
      ): Effect.Effect<DirectoryChange | undefined, FsFailure> {
        return removeDispatch(input, options)
      }

      const selectWatch = (
        input: TargetInput,
        decoded: { readonly recursive?: boolean | undefined; readonly alias?: "all" | "resolved" | undefined }
      ) => {
        const op = OpContext.make("watch")
        const target = asTarget(input)

        return Effect.gen(function*() {
          yield* checkAvailable("watch")
          const resolved = yield* resolveTarget(target, op)
          yield* authorize(resolved.node, identity, READ, resolved.op)

          if (resolved.node.metadata.nlink === 0) return yield* resolved.op.fail("NotFound")

          if (decoded.alias === "resolved" && resolved.kind === "node" && resolved.node.kind !== "directory") {
            return yield* op.fail("InvalidArgument")
          }

          const selection: WatchTarget = {
            roots,
            additionalRoots: [...inherited, ...inheritedFor(target)],
            target: resolved.node.ino,
            recursive: decoded.recursive ?? true
          }

          return (
            decoded.alias === "resolved" && resolved.kind === "entry"
              ? { ...selection, selected: { parent: resolved.parent.ino, name: resolved.name } }
              : selection
          )
        })
      }

      const operations: EngineOperations = Object.freeze({
        limits,
        root: coordinatedRead(
          rootOp,
          Effect.suspend(() =>
            !TokenRegistry.isOpen(reference)
              ? Effect.fail(rootOp.fail("ClosedCaller"))
              : Effect.gen(function*() {
                const node = yield* view(boundary?.root ?? ROOT_INO)

                if (node === undefined) return yield* rootOp.fail("ClosedCaller")
                yield* checkAuthority(node, rootOp)

                return referenceFor(node.ino)
              })
          )
        ),
        lookup: Effect.fnUntraced(function*(input) {
          const op = OpContext.make("lookup")
          const prepared = yield* Effect.fromResult(prepareEntry(input, op))

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const entry = yield* resolveEntry(prepared, op)
              const directory = yield* directoryNow(entry.parent)

              if (isDotComponent(entry.name)) {
                return yield* entry.op.fail(entry.addressing === "entry" ? "InvalidArgument" : "NotFound")
              }

              yield* authorize(directory, identity, EXECUTE, entry.op)
              const child = directory.entries.get(entry.name)

              if (child === undefined) return yield* entry.op.fail("NotFound")

              return referenceFor(child)
            })
          )
        }),
        parent: Effect.fnUntraced(function*(input) {
          const op = OpContext.make("parent")
          const target = asTarget(input)

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const directory = yield* resolveDirectory(target, op)
              yield* authorize(directory.node, identity, EXECUTE, directory.op)

              return referenceFor(
                directory.node.ino === boundary?.root ||
                  inheritedFor(target).some((chain) => chain.at(-1) === directory.node.ino)
                  ? directory.node.ino
                  : directory.node.parent
              )
            })
          )
        }),
        stat: Effect.fnUntraced(function*(input) {
          const op = OpContext.make("stat")
          const target = asTarget(input)

          return yield* coordinatedRead(
            op,
            Effect.map(resolveTarget(target, op), (resolved) => withMetadata(resolved.node))
          )
        }),
        readDirectory: Effect.fnUntraced(function*(input) {
          const op = OpContext.make("readDirectory")
          const target = asTarget(input)

          return yield* accessing(
            op,
            Effect.gen(function*() {
              const directory = yield* resolveDirectory(target, op)
              yield* authorize(directory.node, identity, READ, directory.op)

              const value = Object.freeze(
                DirectoryEntries.toArray(directory.node.entries).map(([name, child]) =>
                  Object.freeze({ name: nameBytes(name), reference: referenceFor(child) })
                )
              )

              const access = { node: directory.node, now: yield* timestamp(op) }

              return { value: Object.freeze({ value, revision: directory.node.revision }), access }
            })
          )
        }),
        walk: (input: TargetInput, options?: WalkOptions): Stream.Stream<WalkEntry, WalkFailure> => {
          const op = OpContext.make("walk")
          const target = asTarget(input)
          const prefix = Target.$is("Path")(target) ? Result.getOrUndefined(inputBytes(target.path)) : undefined

          const locate = (path: Uint8Array): PathInput =>
            ownedPath(prefix === undefined ? path : joinPath(prefix, path))

          const authorities = inheritedFor(target).map((chain) => Confinement.make(authorityView, chain))

          const readable = Effect.fnUntraced(function*(directory: Directory, at: OpContext) {
            for (const authority of authorities) yield* authority.check(directory, at, true)
            yield* authorize(directory, identity, READ, at)
          })

          return Stream.unwrap(Effect.gen(function*() {
            const chosen = yield* decodeWalkOptions(options ?? {}).pipe(
              Effect.mapError((cause) => fail(Target.$is("Path")(target) ? op.at(target.path) : op, cause))
            )

            const first = coordinatedRead(
              op,
              Effect.gen(function*() {
                const directory = yield* resolveDirectory(target, op)
                yield* authorize(directory.node, identity, READ, directory.op)

                return yield* walkChildren(
                  directory.node,
                  new Uint8Array(0),
                  0,
                  yield* pathAnchor(target, directory.node, op)
                )
              })
            )

            const exceeded = (frame: WalkFrame, field: keyof WalkOptions): WalkFailure =>
              makeError({ code: "LimitExceeded", operation: op.operation, field, path: errorPath(locate(frame.path)) })

            const maxBytes = chosen.maxBytes === undefined ? undefined : ByteSize.toBigInt(chosen.maxBytes)

            const plan: WalkPlan<WalkFailure> = {
              order: chosen.order ?? "pre",
              limit: (frame, progress, phase) => {
                if (chosen.maxDepth !== undefined && frame.depth > chosen.maxDepth) return exceeded(frame, "maxDepth")

                if (phase === "directory") return undefined

                if (chosen.maxEntries !== undefined && progress.entries > chosen.maxEntries) {
                  return exceeded(frame, "maxEntries")
                }

                return maxBytes !== undefined && progress.bytes > maxBytes ? exceeded(frame, "maxBytes") : undefined
              }
            }

            return Stream.map(walkFrames(op, first, plan, locate, readable), (frame): WalkEntry =>
              Object.freeze({
                path: ownedPath(frame.path),
                name: frame.name,
                reference: frame.reference,
                directory: frame.directory,
                kind: frame.kind,
                depth: frame.depth
              }))
          }))
        },
        readLink: Effect.fnUntraced(function*(input) {
          const op = OpContext.make("readLink")
          const target = asTarget(input)

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              const resolved = yield* resolveTarget(target, op, { followFinalSymlink: false, final: true })

              if (resolved.node.kind !== "symlink") return yield* resolved.op.fail("InvalidArgument")

              return new Uint8Array(resolved.node.target)
            })
          )
        }),
        realPath: Effect.fnUntraced(function*(input) {
          const op = OpContext.make("realPath")
          const target = asTarget(input)

          return yield* coordinatedRead(
            op,
            Effect.gen(function*() {
              if (Target.$is("Path")(target)) {
                const pathOp = op.at(target.path)
                const result = yield* resolveTarget(target, op, { final: true })

                const directory = result.node.kind === "directory"
                  ? result.node
                  : result.kind === "entry"
                  ? result.parent
                  : undefined

                const prefix = directory === undefined ? SLASH_HEX : yield* callerPath(directory.ino)

                if (prefix === undefined) return yield* pathOp.fail("NotFound")

                if (result.node.kind === "directory" || result.kind === "node") return ownedPath(nameBytes(prefix))

                return ownedPath(nameBytes(prefix + (prefix === SLASH_HEX ? "" : SLASH_HEX) + result.name))
              }

              const resolved = yield* resolveTarget(target, op)
              const path = yield* callerPath(resolved.node.ino)

              if (path === undefined) return yield* resolved.op.fail("NotFound")

              return ownedPath(nameBytes(path))
            })
          )
        }),
        access: Effect.fnUntraced(function*(input, bits = 0) {
          const op = OpContext.make("access")
          const target = asTarget(input)

          if (!Number.isInteger(bits) || bits < 0 || bits > (READ | WRITE | EXECUTE)) {
            return yield* (Target.$is("Path")(target) ? op.at(target.path) : op).fail("InvalidArgument")
          }

          return yield* coordinatedRead(
            op,
            Effect.map(resolveTarget(target, op), (resolved) => {
              const node = resolved.node
              let granted = 0

              for (const bit of [READ, WRITE, EXECUTE]) {
                if ((bits & bit) === 0) continue

                if (bit === EXECUTE && node.kind === "file" && (node.metadata.mode & ANY_EXECUTE) === 0) continue

                if (identity.privileged || (permitted(node, identity) & bit) !== 0) granted |= bit
              }

              return granted
            })
          )
        }),
        readFile: Effect.fnUntraced(function*(input) {
          const op = OpContext.make("readFile")
          const target = asTarget(input)

          return yield* accessing(
            op,
            Effect.gen(function*() {
              const resolved = yield* resolveTarget(target, op)
              const node = resolved.node

              if (node.kind === "symlink") return yield* resolved.op.fail("SymlinkLoop")

              if (node.kind !== "file") return yield* resolved.op.fail("IsDirectory")
              yield* authorize(node, identity, READ, resolved.op)
              const data = new Uint8Array(node.data)

              return { value: data, access: { node, now: yield* timestamp(op) } }
            })
          )
        }),
        writeFile: dual(
          3,
          Effect.fnUntraced(function*(input: EntryInput, bytes: Uint8Array, options: WriteFileOptions) {
            const op = OpContext.make("writeFile")

            const prepared = yield* Effect.fromResult(prepareEntry(input, op))
            const optionsOp = preparedOp(prepared, op)

            if (!isAttachedBytes(bytes)) return yield* optionsOp.fail("InvalidArgument")

            const captured = new Uint8Array(bytes)

            const chosen = yield* decodeWriteFileOptions(options).pipe(
              Effect.mapError((cause) => fail(optionsOp, cause))
            )

            return yield* coordinated(
              op,
              Effect.gen(function*() {
                const resolved = yield* resolver.resolve(prepared, {
                  kind: "OrCreate",
                  create: chosen.create ?? "never",
                  finalSymlink: chosen.replaceFinalSymlink !== true && chosen.followFinalSymlink !== false
                    ? "follow"
                    : "preserve",
                  entryExclusive: "afterSymlink"
                }, op)

                const { parent, name, trailingSlash, op: entryOp } = resolved
                const found = resolved.kind === "existing" ? resolved.node : undefined

                if (found?.kind === "directory" || (found === undefined && trailingSlash)) {
                  return yield* entryOp.fail("IsDirectory")
                }

                const replaced = found?.kind === "symlink" ? found : undefined

                if (replaced !== undefined && !chosen.replaceFinalSymlink) return yield* entryOp.fail("SymlinkLoop")

                if (chosen.access === "read") return yield* entryOp.fail("InvalidHandle")
                const file = found?.kind === "file" ? found : undefined

                if (file === undefined) {
                  yield* authorize(parent, identity, WRITE | EXECUTE, entryOp)

                  if (replaced !== undefined) yield* authorizeRemoval(parent, replaced, entryOp)

                  yield* (replaced === undefined ? reserveEntry(entryOp) : reserveInode(entryOp))
                } else {
                  yield* authorize(file, identity, chosen.access === "readWrite" ? READ | WRITE : WRITE, entryOp)
                }

                const finalMode = chosen.finalMode === undefined ? undefined : yield* permittedMode(
                  file?.metadata ?? { kind: "file", uid: identity.uid, gid: parent.metadata.gid },
                  chosen.finalMode,
                  entryOp
                )

                const previous = file?.data.length ?? 0
                const initial = chosen.truncate ? 0 : previous
                const position = chosen.append ? initial : 0
                const size = Math.max(initial, position + captured.length)

                if (size > maxFileBytes) return yield* entryOp.fail("FileTooLarge")
                const reclaimed = replaced !== undefined && replaced.metadata.nlink === 1 ? replaced.target.length : 0

                yield* reserveBytes(entryOp, BigInt(size - previous) - BigInt(reclaimed))

                if (file !== undefined && !chosen.truncate && captured.length === 0 && chosen.finalMode === undefined) {
                  return referenceFor(file.ino)
                }

                let data = captured

                if (position !== 0 || size !== captured.length) {
                  data = new Uint8Array(size)

                  if (file !== undefined && !chosen.truncate) data.set(file.data)
                  data.set(captured, position)
                }

                const now = yield* timestamp(op)
                const d = yield* Draft

                const node = file ??
                  (yield* newFile(parent, new Uint8Array(0), (chosen.mode ?? 0o666) & 0o777 & ~umask, now))

                const written: RegularFile = {
                  ...node,
                  data,
                  metadata: {
                    ...node.metadata,
                    mode: finalMode ?? node.metadata.mode & ~SET_ID_BITS,
                    size: BigInt(size),
                    mtimeNs: now,
                    ctimeNs: now
                  }
                }

                yield* d.addUsedBytes(BigInt(size - previous))

                if (file === undefined) {
                  if (replaced !== undefined) yield* detach(replaced, parent.ino, name, now)

                  yield* attach(yield* directoryNow(parent.ino), name, written, now)

                  if (replaced === undefined) yield* d.addEntries(1)
                  yield* publishEntry(replaced === undefined ? "Create" : "Update", parent.ino, name, written.ino)
                } else {
                  yield* d.put(written)
                  yield* publishNode(written.ino)
                }

                return referenceFor(written.ino)
              })
            )
          })
        ),
        open,
        mkdir: Effect.fnUntraced(function*(input, options = {}) {
          const op = OpContext.make("mkdir")
          const prepared = yield* Effect.fromResult(prepareEntry(input, op))
          const optionsOp = preparedOp(prepared, op)
          const decoded = yield* decodeMkdirOptions(options).pipe(Effect.mapError((cause) => fail(optionsOp, cause)))
          const chosen = { ...decoded }

          if (chosen.exactMode && chosen.mode === undefined) return yield* optionsOp.fail("InvalidArgument")

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const request = { mode: chosen.mode ?? 0o777, exactMode: chosen.exactMode, times: chosen.times }

              const { child, directory } = chosen.recursive === true
                ? yield* makeDirectories(prepared, request, op)
                : yield* makeDirectory(yield* resolveEntry(prepared, op), request, op)

              return { reference: referenceFor(child), directory }
            })
          )
        }),
        symlink: Effect.fnUntraced(function*(target, input, options = {}) {
          const op = OpContext.make("symlink")
          const targetOp = op.at(target)
          const prepared = yield* Effect.fromResult(prepareEntry(input, op))
          const optionsOp = preparedOp(prepared, op)
          const decoded = yield* decodeSymlinkOptions(options).pipe(Effect.mapError((cause) => fail(optionsOp, cause)))
          const rawTarget = inputBytes(target)

          if (Result.isFailure(rawTarget)) return yield* targetOp.fail(rawTarget.failure)

          if (rawTarget.success.includes(0)) return yield* targetOp.fail("InvalidArgument")
          const targetBytes = new Uint8Array(rawTarget.success)
          const chosen = { ...decoded }

          return yield* coordinated(
            op,
            Effect.gen(function*() {
              const entry = yield* resolveEntry(prepared, op)
              const { child, directory } = yield* makeSymlink(entry, targetBytes, chosen.times, op)

              return { reference: referenceFor(child), directory }
            })
          )
        }),
        link: dual(
          2,
          Effect.fnUntraced(function*(sourceInput: TargetInput, input: EntryInput) {
            const op = OpContext.make("link")
            const source = asTarget(sourceInput)
            const prepared = yield* Effect.fromResult(prepareEntry(input, op))

            return yield* coordinated(
              op,
              Effect.gen(function*() {
                const resolved = yield* resolveTarget(source, op, { followFinalSymlink: false })
                const node = resolved.node

                if (node.kind === "directory") return yield* resolved.op.fail("IsDirectory")

                if (node.metadata.nlink === 0) return yield* resolved.op.fail("StaleReference")
                const entry = yield* resolveEntry(prepared, op)
                const directory = yield* linkNode(node, entry, op)

                return { reference: referenceFor(node.ino), directory }
              })
            )
          })
        ),
        unlink: Effect.fnUntraced(function*(input) {
          return yield* entryVerb("unlink", input, unlinkEntry)
        }),
        rmdir: Effect.fnUntraced(function*(input) {
          return yield* entryVerb("rmdir", input, rmdirEntry)
        }),
        remove,
        rename: dual(
          2,
          Effect.fnUntraced(function*(fromInput: EntryInput, toInput: EntryInput) {
            const op = OpContext.make("rename")
            const from = yield* Effect.fromResult(prepareEntry(fromInput, op))
            const to = yield* Effect.fromResult(prepareEntry(toInput, op))

            return yield* coordinated(
              op,
              Effect.gen(function*() {
                const source = yield* resolveEntry(from, op)
                const destination = yield* resolveEntry(to, op)

                return yield* renameEntry(source, destination, op)
              })
            )
          })
        ),
        chmod: dual(
          2,
          Effect.fnUntraced(function*(input: TargetInput, mode: number) {
            const op = OpContext.make("chmod")
            const target = asTarget(input)

            if (!isMode(mode)) return yield* op.fail("InvalidArgument")
            yield* changeAttributes(() => asResolvedNode(target, op), { mode }, op)
          })
        ),
        chown: dual(
          2,
          Effect.fnUntraced(function*(input: TargetInput, owner: OwnerUpdate) {
            const op = OpContext.make("chown")
            const target = asTarget(input)
            const decoded = yield* decodeOwnerUpdate(owner).pipe(Effect.mapError((cause) => fail(op, cause)))
            yield* changeAttributes(() => asResolvedNode(target, op), { owner: decoded }, op)
          })
        ),
        utimes: dual(
          2,
          Effect.fnUntraced(function*(input: TargetInput, times: Times) {
            const op = OpContext.make("utimes")
            const target = asTarget(input)
            const decoded = yield* decodeTimes(times).pipe(Effect.mapError((cause) => fail(op, cause)))
            yield* changeAttributes(() => asResolvedNode(target, op), { times: decoded }, op)
          })
        ),
        // A negative length fails before the target resolves, as truncate(2) rejects it before the lookup.
        truncate: dual(
          2,
          Effect.fnUntraced(function*(input: TargetInput, length: bigint) {
            const op = OpContext.make("truncate")
            const target = asTarget(input)

            if (!isLength(length)) return yield* op.fail("InvalidArgument")
            yield* changeAttributes(() => asResolvedNode(target, op), { size: length }, op)
          })
        ),
        setattr: dual(
          2,
          Effect.fnUntraced(function*(input: TargetInput, attributes: SetattrOptions) {
            const op = OpContext.make("setattr")
            const target = asTarget(input)

            // A caller outside TypeScript can pass anything, so a non-object fails typed rather than as a defect;
            // the check reads a widened copy so the attributes keep their type below.
            const raw: unknown = attributes

            if (!Predicate.isObject(raw)) return yield* fail(op)
            const unknown = Object.keys(attributes).find((key) => !SETATTR_FIELDS.includes(key))

            if (unknown !== undefined) return yield* fail(op, undefined, unknown)

            if (attributes.size !== undefined && !isLength(attributes.size)) return yield* fail(op, undefined, "size")

            if (attributes.mode !== undefined && !isMode(attributes.mode)) return yield* fail(op, undefined, "mode")

            const owner = attributes.owner === undefined
              ? undefined
              : yield* decodeOwnerUpdate(attributes.owner).pipe(Effect.mapError((cause) => fail(op, cause, "owner")))

            const times = attributes.times === undefined
              ? undefined
              : yield* decodeTimes(attributes.times).pipe(Effect.mapError((cause) => fail(op, cause, "times")))

            const expected = attributes.expected === undefined
              ? undefined
              : yield* decodeExpected(attributes.expected).pipe(Effect.mapError((cause) => fail(op, cause, "expected")))

            yield* changeAttributes(
              () => asResolvedNode(target, op),
              { size: attributes.size, mode: attributes.mode, owner, times, expected },
              op
            )
          })
        ),
        openDirectory: Effect.fnUntraced(function*(input) {
          const acquired = yield* acquireDirectory(input, OpContext.make("openDirectory"))
          const statOp = OpContext.make("stat")

          const handle: DirectoryHandle = Object.freeze({
            [DirectoryHandleId]: true as const,
            stat: coordinatedRead(
              statOp,
              Effect.gen(function*() {
                const ino = TokenRegistry.inode(acquired)
                const node = !TokenRegistry.isOpen(acquired) || ino === undefined ? undefined : yield* view(ino)

                if (node !== undefined && acquired.authority !== undefined) yield* acquired.authority(node, statOp)

                return yield* (node === undefined
                  ? Effect.fail(statOp.fail("InvalidHandle"))
                  : Effect.succeed(withMetadata(node)))
              })
            ),
            close: coordinatedCleanup(Effect.suspend(() => {
              if (TokenRegistry.inode(acquired) === undefined) {
                return Effect.fail(OpContext.make("close").fail("InvalidHandle"))
              }

              return releaseDirectory(acquired)
            })).pipe(
              Effect.mapError((error) =>
                error.code === "VolumeBusy" ? OpContext.make("close").fail("VolumeBusy") : error
              ),
              Effect.ensuring(closeReleasedScope(acquired))
            )
          })

          registry.registerDirectory(handle, acquired)

          return handle
        })
      })

      return {
        operations,
        selectWatch,
        withRoot: Effect.fnUntraced(function*(input) {
          const acquired = yield* acquireDirectory(input, OpContext.make("withRoot"))

          return createContext(
            acquired,
            identity,
            umask,
            [...roots, TokenRegistry.inode(acquired)!],
            acquired.boundaries ?? []
          )
        }),
        withDirectory: Effect.fnUntraced(function*(input) {
          const acquired = yield* acquireDirectory(input, OpContext.make("withDirectory"))

          return createContext(
            acquired,
            identity,
            umask,
            acquired.namespaceRoots ?? roots,
            acquired.boundaries ?? []
          )
        })
      }
    }

    return Object.freeze({
      limits,
      shutdown,
      usage: coordinatedRead(
        OpContext.make("usage"),
        Effect.sync((): VolumeUsage => ({ usedBytes: state.usedBytes, entries: state.entries }))
      ),
      context: Effect.fnUntraced(function*(options?: RootCallerOptions) {
        const decoded = yield* Effect.fromResult(
          decodeConfiguration(RootCallerOptions, options === undefined ? {} : options, "caller")
        )

        const chosen = decoded.identity ?? { uid: 0, gid: 0, groups: [], privileged: true }
        const identity = Object.freeze({ ...chosen, groups: Object.freeze([...chosen.groups]) })

        return yield* coordinatedRead(
          OpContext.make("caller"),
          Effect.sync(() => createContext(makeDirectoryReference(ROOT_INO), identity, decoded.umask ?? 0o022))
        )
      }),
      coordinate: changing,
      admit,
      checkAvailable,
      execution,
      syncBinding: synchronous ?
        Object.freeze({
          check: (operation: string): Result.Result<void, FsFailure> =>
            active
              ? Result.fail(fsFailure("VolumeBusy", operation))
              : Result.succeed(undefined)
        }) :
        undefined,
      preflight,
      capture: (operation: string) => coordinatedRead(OpContext.make(operation), Effect.sync(() => state)),
      cooperativeCapture: synchronous ?
        undefined :
        <A, E, R>(operation: string, read: (state: VolumeState) => Effect.Effect<A, E, R>) =>
          coordinatedRead(OpContext.make(operation), Effect.suspend(() => read(state))),
      referenceInode: (reference: ObjectReference, op: OpContext) =>
        coordinatedRead(
          op,
          Effect.gen(function*() {
            return (yield* TokenRegistry.nodeOrFail(yield* registry.resolve(reference, "reference"), "reference", op))
              .ino
          })
        ),
      objectFor: (resolveInode: Effect.Effect<Ino, FsFailure>, op: OpContext) =>
        coordinatedRead(
          op,
          Effect.gen(function*() {
            const ino = yield* resolveInode
            yield* TokenRegistry.nodeOrFail(yield* registry.resolveInode(ino), "reference", op)

            return referenceFor(ino)
          })
        ),
      watchRoot: Effect.fnUntraced(function*(reference: ObjectReference, op: OpContext) {
        const node = yield* TokenRegistry.nodeOrFail(yield* registry.resolve(reference, "reference"), "reference", op)

        return node.metadata.nlink === 0 ? yield* op.fail("StaleReference") : node.ino
      })
    })
  }
)
