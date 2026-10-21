/**
 * Caller identity brands and schemas: credentials, root caller options, and
 * the settings and results of the operations a caller performs.
 *
 * @since 0.6.0
 */
import type * as Schema from "effect/Schema"
import * as Engine from "./internal/engine.js"
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
export const Identity: Schema.Struct<{
  readonly uid: Schema.Natural
  readonly gid: Schema.Natural
  readonly groups: Schema.$Array<Schema.Natural>
  readonly privileged: Schema.Boolean
}> = Engine.Identity

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
export const RootCallerOptions: Schema.Struct<{
  readonly identity: Schema.optionalKey<
    Schema.Struct<{
      readonly uid: Schema.Natural
      readonly gid: Schema.Natural
      readonly groups: Schema.$Array<Schema.Natural>
      readonly privileged: Schema.Boolean
    }>
  >
  readonly umask: Schema.optionalKey<Schema.Natural>
}> = Engine.RootCallerOptions

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
export const OpenOptions: Schema.Struct<{
  readonly access: Schema.Literals<readonly ["read", "write", "readWrite"]>
  readonly create: Schema.optionalKey<Schema.Literals<readonly ["never", "ifMissing", "exclusive"]>>
  readonly mode: Schema.optionalKey<Schema.Natural>
  readonly append: Schema.optionalKey<Schema.Boolean>
  readonly truncate: Schema.optionalKey<Schema.Boolean>
}> = Engine.OpenOptions

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
export const WriteFileOptions: Schema.Struct<{
  readonly access: Schema.Literals<readonly ["read", "write", "readWrite"]>
  readonly create: Schema.optionalKey<Schema.Literals<readonly ["never", "ifMissing", "exclusive"]>>
  readonly mode: Schema.optionalKey<Schema.Natural>
  readonly append: Schema.optionalKey<Schema.Boolean>
  readonly truncate: Schema.optionalKey<Schema.Boolean>
  readonly followFinalSymlink: Schema.optionalKey<Schema.Boolean>
  readonly replaceFinalSymlink: Schema.optionalKey<Schema.Boolean>
  readonly finalMode: Schema.optionalKey<Schema.Natural>
}> = Engine.WriteFileOptions

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
export const DirectoryChange: Schema.Struct<{
  readonly before: Schema.BigInt
  readonly after: Schema.BigInt
}> = Engine.DirectoryChange

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
export const RenameReferenceResult: Schema.TaggedUnion<{
  readonly DifferentDirectories: Schema.TaggedStruct<"DifferentDirectories", {
    readonly sourceDirectory: Schema.Struct<{
      readonly before: Schema.BigInt
      readonly after: Schema.BigInt
    }>
    readonly destinationDirectory: Schema.Struct<{
      readonly before: Schema.BigInt
      readonly after: Schema.BigInt
    }>
  }>
  readonly SameDirectory: Schema.TaggedStruct<"SameDirectory", {
    readonly directory: Schema.Struct<{
      readonly before: Schema.BigInt
      readonly after: Schema.BigInt
    }>
  }>
}> = Engine.RenameReferenceResult

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
export const MkdirOptions: Schema.Struct<{
  readonly mode: Schema.optionalKey<Schema.Natural>
  readonly exactMode: Schema.optionalKey<Schema.Boolean>
  readonly times: Schema.optionalKey<
    Schema.Struct<{
      readonly access: Schema.Union<
        readonly [
          Schema.Struct<{
            readonly kind: Schema.Literal<"now">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"omit">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"value">
            readonly nanoseconds: Schema.BigInt
          }>
        ]
      >
      readonly modification: Schema.Union<
        readonly [
          Schema.Struct<{
            readonly kind: Schema.Literal<"now">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"omit">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"value">
            readonly nanoseconds: Schema.BigInt
          }>
        ]
      >
    }>
  >
  readonly recursive: Schema.optionalKey<Schema.Boolean>
}> = Engine.MkdirOptions

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
export const WalkOptions: Schema.Struct<{
  readonly order: Schema.optionalKey<Schema.Literals<readonly ["pre", "post"]>>
  readonly maxDepth: Schema.optionalKey<Schema.Natural>
  readonly maxEntries: Schema.optionalKey<Schema.Natural>
  readonly maxBytes: Schema.optionalKey<Schema.ByteSize>
}> = Engine.WalkOptions

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
export const RemoveOptions: Schema.Struct<{
  readonly recursive: Schema.optionalKey<Schema.Boolean>
  readonly force: Schema.optionalKey<Schema.Boolean>
  readonly expected: Schema.optionalKey<Schema.suspend<Schema.declare<ObjectReference, ObjectReference>>>
}> = Engine.RemoveOptions

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
export const SymlinkOptions: Schema.Struct<{
  readonly times: Schema.optionalKey<
    Schema.Struct<{
      readonly access: Schema.Union<
        readonly [
          Schema.Struct<{
            readonly kind: Schema.Literal<"now">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"omit">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"value">
            readonly nanoseconds: Schema.BigInt
          }>
        ]
      >
      readonly modification: Schema.Union<
        readonly [
          Schema.Struct<{
            readonly kind: Schema.Literal<"now">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"omit">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"value">
            readonly nanoseconds: Schema.BigInt
          }>
        ]
      >
    }>
  >
}> = Engine.SymlinkOptions

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
export const SetattrOptions: Schema.Struct<{
  readonly size: Schema.optionalKey<Schema.BigInt>
  readonly mode: Schema.optionalKey<Schema.Natural>
  readonly owner: Schema.optionalKey<
    Schema.Struct<{
      readonly uid: Schema.optionalKey<Schema.Natural>
      readonly gid: Schema.optionalKey<Schema.Natural>
    }>
  >
  readonly times: Schema.optionalKey<
    Schema.Struct<{
      readonly access: Schema.Union<
        readonly [
          Schema.Struct<{
            readonly kind: Schema.Literal<"now">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"omit">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"value">
            readonly nanoseconds: Schema.BigInt
          }>
        ]
      >
      readonly modification: Schema.Union<
        readonly [
          Schema.Struct<{
            readonly kind: Schema.Literal<"now">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"omit">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"value">
            readonly nanoseconds: Schema.BigInt
          }>
        ]
      >
    }>
  >
  readonly expected: Schema.optionalKey<
    Schema.Struct<{
      readonly revision: Schema.BigInt
    }>
  >
}> = Engine.SetattrOptions

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
export const ObjectReferenceSchema: Schema.declare<ObjectReference, ObjectReference> = Engine.ObjectReferenceSchema

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
export const OpenEntryOptions: Schema.Struct<{
  readonly access: Schema.Literals<readonly ["read", "write", "readWrite"]>
  readonly create: Schema.optionalKey<Schema.Literals<readonly ["never", "ifMissing", "exclusive"]>>
  readonly mode: Schema.optionalKey<Schema.Natural>
  readonly append: Schema.optionalKey<Schema.Boolean>
  readonly truncate: Schema.optionalKey<Schema.Boolean>
  readonly followFinalSymlink: Schema.optionalKey<Schema.Boolean>
  readonly times: Schema.optionalKey<
    Schema.Struct<{
      readonly access: Schema.Union<
        readonly [
          Schema.Struct<{
            readonly kind: Schema.Literal<"now">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"omit">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"value">
            readonly nanoseconds: Schema.BigInt
          }>
        ]
      >
      readonly modification: Schema.Union<
        readonly [
          Schema.Struct<{
            readonly kind: Schema.Literal<"now">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"omit">
          }>,
          Schema.Struct<{
            readonly kind: Schema.Literal<"value">
            readonly nanoseconds: Schema.BigInt
          }>
        ]
      >
    }>
  >
  readonly initialSize: Schema.optionalKey<Schema.BigInt>
  readonly exactMode: Schema.optionalKey<Schema.Boolean>
  readonly owner: Schema.optionalKey<
    Schema.Struct<{
      readonly uid: Schema.optionalKey<Schema.Natural>
      readonly gid: Schema.optionalKey<Schema.Natural>
    }>
  >
  readonly expected: Schema.optionalKey<Schema.NullOr<Schema.declare<ObjectReference, ObjectReference>>>
  readonly expectedChild: Schema.optionalKey<
    Schema.NullOr<
      Schema.Struct<{
        readonly reference: Schema.declare<ObjectReference, ObjectReference>
        readonly revision: Schema.BigInt
        readonly atimeNs: Schema.BigInt
        readonly mtimeNs: Schema.BigInt
      }>
    >
  >
}> = Engine.OpenEntryOptions

/**
 * Options of `open` on an entry.
 *
 * @category models
 * @since 0.6.0
 */
export type OpenEntryOptions = typeof OpenEntryOptions.Type
