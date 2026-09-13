// Virtual filesystem failure schemas and identities shared by the runtime implementation.
import * as Data from "effect/Data"
import * as Schema from "effect/Schema"
import type { PathInput } from "../../VirtualFileSystem.js"

/** @internal */
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

/** @internal */
export type FsCode = typeof FsCode.Type

/** @internal */
export class FsError extends Data.TaggedError("FsError")<{
  readonly code: FsCode
  readonly operation: string
  readonly path?: PathInput
}> {}

/** @internal */
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly field: string
}> {}
