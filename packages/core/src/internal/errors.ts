// Virtual filesystem failure schemas and identities shared by the runtime implementation.
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as SchemaIssue from "effect/SchemaIssue"
import type { PathInput } from "../VirtualFileSystem.js"
import { ConfigurationError, FsCode, FsError } from "../VirtualFileSystemError.js"

/** @internal */
export { ConfigurationError, FsError }

/** @internal */
export { FsCode }

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

/** @internal */
export interface OpContext {
  readonly operation: string
  readonly fail: (code: FsCode, details?: { readonly cause?: NonNullable<FsError["cause"]> }) => FsError
  // Failures from the returned context name `path`, so a helper takes one context rather than a context and a path.
  readonly at: (path: PathInput) => OpContext
}

const makeOpContext = (operation: string, located?: { readonly path: PathInput }): OpContext => ({
  operation,
  // Spreading keeps exactly the keys the site names, as direct construction did, including a path an untyped
  // caller left undefined. A site whose path is optional keeps the context it has instead of calling `at`.
  fail: (code, details) => new FsError({ code, operation, ...located, ...details }),
  at: (path) => makeOpContext(operation, { path })
})

/** @internal */
export const OpContext = {
  make: (operation: string): OpContext => makeOpContext(operation)
}
