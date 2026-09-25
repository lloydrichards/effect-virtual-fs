/**
 * The one error family of `@effect-vfs/core`. Every failure a volume, caller,
 * handle, snapshot codec, delta codec, or live store reports is a `VfsError`
 * whose `code` says what went wrong, whose `operation` names the verb or
 * constructor, and which may name the offending option `field`, the `path`
 * it was addressing, and the underlying `cause` it classifies.
 *
 * @since 0.6.0
 */
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import type { BytePath } from "./BytePath.js"
import * as Internal from "./internal/bytePath.js"

// Declared from the byte-path internals rather than the BytePath module, which imports this one for its failures.
const BytePathSchema = Schema.declare<BytePath>(Internal.isBytePath)

/**
 * Schema for the codes an operation on a volume, caller, or handle reports.
 *
 * @category schemas
 * @since 0.6.0
 */
export const FsCode = Schema.Literals([
  "NotFound",
  "AlreadyExists",
  "NotEmpty",
  "NotDirectory",
  "AccessDenied",
  "InvalidHandle",
  "ForeignHandle",
  "InvalidReference",
  "ForeignReference",
  "StaleReference",
  "ClosedCaller",
  "InvalidArgument",
  "InvalidPathEncoding",
  "PathTooLong",
  "NoSpace",
  "IsDirectory",
  "FileTooLarge",
  "NoData",
  "SymlinkLoop",
  "UnrepresentableName",
  // A durable provider knows the mutation was not committed.
  "StorageRejected",
  // A commit or publication failed after its outcome ceased to be knowable to the caller.
  "OutcomeUnknown",
  // The provider stopped serving operations until recovery establishes its state.
  "VolumeUnavailable",
  "VolumeBusy"
])

/**
 * A code an operation on a volume, caller, or handle reports.
 *
 * @category models
 * @since 0.6.0
 */
export type FsCode = typeof FsCode.Type

/**
 * Schema for the codes a snapshot, fixture, live image, or delta codec reports.
 *
 * @category schemas
 * @since 0.6.0
 */
export const ImageCode = Schema.Literals(["InvalidEncoding", "UnsupportedVersion", "InvalidStructure", "LimitExceeded"])

/**
 * A code a snapshot, fixture, live image, or delta codec reports.
 *
 * @category models
 * @since 0.6.0
 */
export type ImageCode = typeof ImageCode.Type

/**
 * Schema for the code a delta reports when its base does not match.
 *
 * @category schemas
 * @since 0.6.0
 */
export const DeltaCode = Schema.Literals(["BaseMismatch"])

/**
 * The code a delta reports when its base does not match.
 *
 * @category models
 * @since 0.6.0
 */
export type DeltaCode = typeof DeltaCode.Type

/**
 * Schema for the codes a live image store reports while opening or recovering a volume.
 *
 * @category schemas
 * @since 0.6.0
 */
export const StoreCode = Schema.Literals(["Storage", "Ownership", "IncompatibleStore", "CorruptStore"])

/**
 * A code a live image store reports while opening or recovering a volume.
 *
 * @category models
 * @since 0.6.0
 */
export type StoreCode = typeof StoreCode.Type

/**
 * Schema for every code a `VfsError` can carry.
 *
 * @category schemas
 * @since 0.6.0
 */
export const VfsCode = Schema.Literals([
  ...FsCode.literals,
  ...ImageCode.literals,
  ...DeltaCode.literals,
  ...StoreCode.literals
])

/**
 * Every code a `VfsError` can carry.
 *
 * @category models
 * @since 0.6.0
 */
export type VfsCode = typeof VfsCode.Type

/**
 * Schema for the path an error names, carried as an opaque `BytePath` and
 * encoded as base64 bytes so the error survives a wire.
 *
 * @category schemas
 * @since 0.6.0
 */
export const ErrorPath = Schema.Uint8ArrayFromBase64.check(
  Schema.makeFilter((bytes) => Internal.isPathBytes(bytes) ? undefined : "must be non-empty and hold no NUL")
).pipe(
  Schema.decodeTo(
    BytePathSchema,
    SchemaTransformation.transform<BytePath, Uint8Array>({
      decode: (bytes) => Internal.make(bytes.slice()),
      encode: (path) => Internal.getBytes(path) ?? new Uint8Array()
    })
  )
)

/**
 * A failure reported by any part of the virtual filesystem.
 *
 * @example
 * ```ts
 * import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fs = yield* (yield* Vfs.make()).caller()
 *
 *   return yield* fs.readFile("/missing").pipe(
 *     Effect.catchTag("VfsError", (error) => Effect.succeed(`${error.operation}: ${error.code}`))
 *   )
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))).then(console.log)
 * // readFile: NotFound
 * ```
 *
 * @category errors
 * @since 0.6.0
 */
export class VfsError extends Schema.TaggedError<VfsError>()("VfsError", {
  /** What went wrong. */
  code: VfsCode,
  /** The verb or constructor that failed. */
  operation: Schema.String,
  /** The option or input area the failure concerns, when one is known. */
  field: Schema.optionalKey(Schema.String),
  /** The path the operation was addressing, when it named one. */
  path: Schema.optionalKey(ErrorPath),
  /** The underlying failure this error classifies, when one exists. */
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message(): string {
    return `${this.operation} failed with ${this.code}${this.field === undefined ? "" : ` at ${this.field}`}`
  }
}

/**
 * A `VfsError` whose code is one an operation on a volume, caller, or handle reports.
 *
 * @category models
 * @since 0.6.0
 */
export type FsFailure = VfsError & { readonly code: FsCode }

/**
 * A `VfsError` whose code is one a snapshot, fixture, live image, or delta codec reports.
 *
 * @category models
 * @since 0.6.0
 */
export type ImageFailure = VfsError & { readonly code: ImageCode }

/**
 * A `VfsError` whose code is one a live image store reports.
 *
 * @category models
 * @since 0.6.0
 */
export type StoreFailure = VfsError & { readonly code: StoreCode }

/**
 * A `VfsError` reporting a rejected option, always `InvalidArgument` with the offending `field`.
 *
 * @category models
 * @since 0.6.0
 */
export type ArgumentFailure = VfsError & { readonly code: "InvalidArgument" }

/**
 * What a `VfsError` is built from: a code, the operation that failed, and whichever of field, path and cause
 * apply.
 *
 * @category models
 * @since 0.6.0
 */
export interface Props<C extends VfsCode> {
  readonly code: C
  readonly operation: string
  readonly field?: string | undefined
  readonly path?: BytePath | undefined
  readonly cause?: unknown
}

interface Fields {
  code: VfsCode
  operation: string
  field?: string
  path?: BytePath
  cause?: unknown
}

/**
 * Builds a `VfsError` whose type carries its code, so a service can fail with a narrowed alias such as
 * `StoreFailure` or `ArgumentFailure` without a cast. An absent field, path or cause stays absent.
 *
 * @example
 * ```ts
 * import { VfsError } from "@effect-vfs/core"
 *
 * const failure: VfsError.StoreFailure = VfsError.make({ code: "Storage", operation: "MyStore.load" })
 *
 * console.log(failure.message)
 * // MyStore.load failed with Storage
 * ```
 *
 * @category constructors
 * @since 0.6.0
 */
export const make = <C extends VfsCode>(props: Props<C>): VfsError & { readonly code: C } => {
  const fields: Fields = { code: props.code, operation: props.operation }

  if (props.field !== undefined) fields.field = props.field

  if (props.path !== undefined) fields.path = props.path

  if (props.cause !== undefined) fields.cause = props.cause

  // SAFETY: the error was built from `props.code`, which is a C.
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- see the invariant above.
  return new VfsError(fields) as VfsError & { readonly code: C }
}
