/**
 * Caller identity brands and schemas: credentials, root caller options, and
 * the settings and results of the operations a caller performs.
 *
 * @since 0.6.0
 */
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { Mode, OwnerUpdate, Times, Timestamp } from "./Metadata.js"
import type { ObjectReference } from "./VirtualFileSystem.js"

/**
 * Brand key that marks a caller.
 *
 * @category type IDs
 * @since 0.6.0
 */
export const CallerId: unique symbol = Symbol.for("@effect-vfs/core/Caller")

/**
 * Brand key that marks a caller.
 *
 * @category type IDs
 * @since 0.6.0
 */
export type CallerId = typeof CallerId

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
 * Schema for the settings of a path-addressed open.
 *
 * @category schemas
 * @since 0.6.0
 */
export const OpenSettings = Schema.Struct({
  access: Schema.Literals(["read", "write", "readWrite"]),
  create: Schema.optionalKey(Schema.Literals(["never", "ifMissing", "exclusive"])),
  mode: Schema.optionalKey(Mode),
  append: Schema.optionalKey(Schema.Boolean),
  truncate: Schema.optionalKey(Schema.Boolean),
  followFinalSymlink: Schema.optionalKey(Schema.Boolean)
})

/**
 * Settings of a path-addressed open.
 *
 * @category models
 * @since 0.6.0
 */
export type OpenSettings = typeof OpenSettings.Type

/**
 * Schema for the settings of a whole-file write.
 *
 * @category schemas
 * @since 0.6.0
 */
export const WriteFileSettings = Schema.Struct({
  ...OpenSettings.fields,
  replaceFinalSymlink: Schema.optionalKey(Schema.Boolean),
  finalMode: Schema.optionalKey(Mode)
})

/**
 * Settings of a whole-file write.
 *
 * @category models
 * @since 0.6.0
 */
export type WriteFileSettings = typeof WriteFileSettings.Type

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
 * Schema for the result of a reference-addressed rename.
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
 * The result of a reference-addressed rename.
 *
 * @category models
 * @since 0.6.0
 */
export type RenameReferenceResult = typeof RenameReferenceResult.Type

/**
 * Schema for the settings of a reference-addressed directory creation.
 *
 * @category schemas
 * @since 0.6.0
 */
export const MkdirReferenceSettings = Schema.Struct({
  mode: Schema.optionalKey(Mode),
  exactMode: Schema.optionalKey(Schema.Boolean),
  times: Schema.optionalKey(Times)
})

/**
 * Settings of a reference-addressed directory creation.
 *
 * @category models
 * @since 0.6.0
 */
export type MkdirReferenceSettings = typeof MkdirReferenceSettings.Type

/**
 * Schema for the settings of a reference-addressed symbolic link creation.
 *
 * @category schemas
 * @since 0.6.0
 */
export const SymlinkReferenceSettings = Schema.Struct({
  times: Schema.optionalKey(Times)
})

/**
 * Settings of a reference-addressed symbolic link creation.
 *
 * @category models
 * @since 0.6.0
 */
export type SymlinkReferenceSettings = typeof SymlinkReferenceSettings.Type

/**
 * Schema for the settings of opening an existing file by reference.
 *
 * @category schemas
 * @since 0.6.0
 */
export const OpenReferenceSettings = Schema.Struct({
  access: Schema.Literals(["read", "write", "readWrite"]),
  append: Schema.optionalKey(Schema.Boolean),
  truncate: Schema.optionalKey(Schema.Boolean)
})

/**
 * Settings of opening an existing file by reference.
 *
 * @category models
 * @since 0.6.0
 */
export type OpenReferenceSettings = typeof OpenReferenceSettings.Type

const ObjectReferenceSchema = Schema.declare<ObjectReference>((input): input is ObjectReference =>
  Predicate.hasProperty(ObjectReferenceId)(input) && input[ObjectReferenceId] === true
)

/**
 * Schema for the settings of a lookup-or-create-and-open through a parent reference.
 *
 * @category schemas
 * @since 0.6.0
 */
export const OpenChildReferenceSettings = Schema.Struct({
  ...OpenSettings.fields,
  times: Schema.optionalKey(Times),
  initialSize: Schema.optionalKey(Schema.BigInt),
  exactMode: Schema.optionalKey(Schema.Boolean),
  owner: Schema.optionalKey(OwnerUpdate),
  expectedChild: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    reference: ObjectReferenceSchema,
    revision: Schema.BigInt,
    atimeNs: Timestamp,
    mtimeNs: Timestamp
  })))
})

/**
 * Settings of a lookup-or-create-and-open through a parent reference.
 *
 * @category models
 * @since 0.6.0
 */
export type OpenChildReferenceSettings = typeof OpenChildReferenceSettings.Type
