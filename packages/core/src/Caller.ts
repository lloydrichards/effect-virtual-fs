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
 * an explicit creation mode; permission policy still applies.
 *
 * @category schemas
 * @since 0.6.0
 */
export const MkdirOptions = Schema.Struct({
  mode: Schema.optionalKey(Mode),
  exactMode: Schema.optionalKey(Schema.Boolean),
  times: Schema.optionalKey(Times)
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
