/** Virtual filesystem failure schemas and identities shared by the runtime implementation. @internal */
import * as Data from "effect/Data"
import * as Schema from "effect/Schema"
import type { PathInput } from "../../VirtualFileSystem.js"

/**
 * Schema for portable virtual filesystem error codes.
 *
 * @category schemas
 * @since 0.1.0
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
  "UnrepresentableName"
])
/**
 * A portable virtual filesystem error code.
 *
 * @category models
 * @since 0.1.0
 */
export type FsCode = typeof FsCode.Type
/**
 * Describes an expected filesystem operation failure.
 *
 * @category errors
 * @since 0.1.0
 */
export class FsError extends Data.TaggedError("FsError")<{
  /** Machine-readable reason for the failure. */
  readonly code: FsCode
  /** Operation that detected the failure. */
  readonly operation: string
  /** Path involved in the failure, when one path identifies it. */
  readonly path?: PathInput
}> {}
/**
 * Describes an invalid volume or caller option and names the rejected field.
 *
 * @category errors
 * @since 0.1.0
 */
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  /** Name of the rejected option. */
  readonly field: string
}> {}
