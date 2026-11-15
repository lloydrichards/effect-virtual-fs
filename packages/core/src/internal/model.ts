import * as Brand from "effect/Brand"
import * as ByteSize from "effect/ByteSize"
import type * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Equal from "effect/Equal"
import { dual } from "effect/Function"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as SchemaIssue from "effect/SchemaIssue"
import { DirectoryHandleId, FileHandleId } from "../FileHandle.js"
import type { DirectoryHandle, FileHandle, ObjectReference } from "../VirtualFileSystem.js"
import type { BytePath } from "./bytePath.js"
import * as BytePathStorage from "./bytePath.js"

import { type Metadata, Mode, OwnerUpdate, Times, Timestamp } from "../Metadata.js"
import { type ArgumentFailure, type FsCode, type FsFailure, make as makeError, type VfsError } from "../VfsError.js"

export type PathInput = string | BytePath

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

const { fsFailure } = Errors

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
  export const validatePath = (
    input: PathInput,
    operation: string,
    maxPathBytes: ByteSize.ByteSize | undefined
  ): Result.Result<Uint8Array, FsFailure> => {
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

    let start = 0

    for (let index = 0; index <= bytes.length; index++) {
      if (index !== bytes.length && bytes[index] !== SLASH_BYTE) continue

      if (index - start > MAX_NAME_BYTES) return Result.fail(fsFailure("PathTooLong", operation, { path: input }))

      start = index + 1
    }

    return Result.succeed(bytes)
  }

  /** @internal */
  export const preparePath = (
    input: PathInput,
    operation: string,
    maxPathBytes: ByteSize.ByteSize | undefined
  ): Result.Result<PreparedPath, FsFailure> => {
    const checked = validatePath(input, operation, maxPathBytes)

    if (Result.isFailure(checked)) return Result.fail(checked.failure)
    const bytes = checked.success
    const components: Array<string> = []
    const suffixes: Array<Uint8Array> = []
    let start = 0

    for (let index = 0; index <= bytes.length; index++) {
      if (index !== bytes.length && bytes[index] !== SLASH_BYTE) continue

      if (index > start) {
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

const { nameBytes, ownedPath, SLASH_HEX } = Paths

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

/** Immutable snapshot representation for core codecs, fixtures, search, delta and merge. @internal */
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

const MAX_FILE_BYTES = State.MAX_FILE_BYTES

type VolumeState = State.VolumeState

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
