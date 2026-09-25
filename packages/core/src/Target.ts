/**
 * How a caller names what it operates on. A `Target` is a path, an object
 * reference, or an open handle; an `Entry` is a child of a directory target
 * called `name`. Every verb takes one or the other, so the three addressing
 * modes share one body and one option vocabulary.
 *
 * @since 0.6.0
 */
import * as Data from "effect/Data"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { DirectoryHandleId, FileHandleId } from "./FileHandle.js"
import * as Internal from "./internal/bytePath.js"
import type { DirectoryHandle, FileHandle, ObjectReference, PathInput } from "./VirtualFileSystem.js"

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

    if (Predicate.isString(input) || Internal.isBytePath(input)) return enumeration.Path({ path: input })

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
export const Entry = (directory: TargetInput, name: NameInput): Entry => ({ directory: Target.of(directory), name })

/**
 * Whether a path input is a byte path rather than a string.
 *
 * @category predicates
 * @since 0.6.0
 */
export const isBytePathInput = (input: PathInput): boolean => Internal.isBytePath(input)
