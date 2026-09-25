/**
 * Tagged errors shared by the public filesystem API and its implementation.
 *
 * @since 0.1.0
 */
import * as Data from "effect/Data"
import * as Schema from "effect/Schema"
import type { ImageError } from "./Snapshot.js"
import type { PathInput } from "./VirtualFileSystem.js"

/**
 * Schema for the portable virtual filesystem error codes.
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
 * A portable virtual filesystem error code.
 *
 * @category models
 * @since 0.6.0
 */
export type FsCode = typeof FsCode.Type

/**
 * An expected filesystem operation failure.
 *
 * The `code` distinguishes portable failures while `operation` names the action.
 * Byte paths are intentionally omitted from the formatted message.
 *
 * @example
 * ```ts
 * import { VirtualFileSystemError } from "@effect-vfs/core"
 *
 * const error = new VirtualFileSystemError.FsError({ code: "NotFound", operation: "readFile" })
 * console.log(error.code, error.message)
 * // NotFound readFile failed with NotFound
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class FsError extends Data.TaggedError("FsError")<{
  readonly code: FsCode
  readonly operation: string
  readonly path?: PathInput
  /** Underlying failure that this error classifies, when one exists. */
  readonly cause?: Schema.SchemaError | FsError | ImageError | TypeError
}> {
  override get message(): string {
    return `${this.operation} failed with ${this.code}`
  }
}

/**
 * An invalid volume or caller option, identified by its field name.
 *
 * @example
 * ```ts
 * import { VirtualFileSystemError } from "@effect-vfs/core"
 *
 * const error = new VirtualFileSystemError.ConfigurationError({ field: "maxEntries" })
 * console.log(error.field, error.message)
 * // maxEntries Invalid option: maxEntries
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly field: string
}> {
  override get message(): string {
    return `Invalid option: ${this.field}`
  }
}
