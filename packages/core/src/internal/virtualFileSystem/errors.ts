// Virtual filesystem failure schemas and identities shared by the runtime implementation.
import * as Data from "effect/Data"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as SchemaIssue from "effect/SchemaIssue"
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
  "UnrepresentableName",
  // A durable provider knows the mutation was not committed.
  "StorageRejected",
  // A commit or publication failed after its outcome ceased to be knowable to the caller.
  "OutcomeUnknown",
  // The provider stopped serving operations until recovery establishes its state.
  "VolumeUnavailable"
])

/** @internal */
export type FsCode = typeof FsCode.Type

/** @internal */
export class FsError extends Data.TaggedError("FsError")<{
  readonly code: FsCode
  readonly operation: string
  readonly path?: PathInput
}> {
  // The path is omitted on purpose: byte paths are not printable and may carry user data.
  override get message(): string {
    return `${this.operation} failed with ${this.code}`
  }
}

/** @internal */
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly field: string
}> {
  override get message(): string {
    return `Invalid option: ${this.field}`
  }
}

// Names the offending option so the caller learns which key it got wrong, not just that decoding failed.
const configurationField = (issue: SchemaIssue.Issue): string => {
  if (Predicate.isTagged("Pointer")(issue)) return issue.path.map(String).join(".")

  if (Predicate.isTagged("Composite")(issue)) return configurationField(issue.issues[0])

  return "options"
}

/** @internal */
export const decodeConfiguration = <A>(schema: Schema.Codec<A>, value: typeof Schema.Unknown.Type) =>
  Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(value).pipe(
    Result.mapError((error) => new ConfigurationError({ field: configurationField(error.issue) }))
  )
