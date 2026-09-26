// Virtual filesystem failure construction shared by the runtime implementation.
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as SchemaAST from "effect/SchemaAST"
import type * as SchemaIssue from "effect/SchemaIssue"
import type { BytePath } from "../BytePath.js"
import {
  type ArgumentFailure,
  type FsCode,
  type FsFailure,
  type ImageCode,
  type ImageFailure,
  make as makeError,
  type VfsCode,
  VfsError
} from "../VfsError.js"
import type { PathInput } from "../VirtualFileSystem.js"
import { getBytes, isBytePath, isPathBytes, make } from "./bytePath.js"

/** @internal */
export { VfsError }

const encoder = new TextEncoder()

// An error names the path it was addressing as bytes. A string input is encoded as UTF-8, so an unencodable
// string (a lone surrogate) names its replacement encoding: the position is kept, the exact code unit is not.
// An input that no byte path could hold (empty, holding a NUL, or a forged byte path) names no path, so the
// error never carries a BytePath that breaks its invariant.
/** @internal */
export const errorPath = (input: PathInput): BytePath | undefined => {
  const bytes = Predicate.isString(input) ? encoder.encode(input) : isBytePath(input) ? getBytes(input) : undefined

  if (bytes === undefined || !isPathBytes(bytes)) return undefined

  return isBytePath(input) ? input : make(bytes)
}

// Names the offending option so the caller learns which key it got wrong, not just that decoding failed.
const configurationField = (issue: SchemaIssue.Issue): string => {
  if (Predicate.isTagged("Pointer")(issue)) return issue.path.map(String).join(".")

  if (Predicate.isTagged("Composite")(issue)) return configurationField(issue.issues[0])

  // A public limits schema that decodes into an internal budget reports its key beneath the transformation.
  if (Predicate.isTagged("Encoding")(issue)) return configurationField(issue.issue)

  return "options"
}

interface Details {
  readonly path?: PathInput
  readonly field?: string
  readonly cause?: unknown
}

// Builds the error from its code, so the narrowed type comes from the code rather than a cast.
const build = <C extends VfsCode>(code: C, operation: string, details?: Details): VfsError & { readonly code: C } =>
  makeError({
    code,
    operation,
    field: details?.field,
    path: details?.path === undefined ? undefined : errorPath(details.path),
    cause: details?.cause
  })

/** @internal */
export const argumentFailure = (operation: string, field: string, cause?: unknown): ArgumentFailure =>
  build("InvalidArgument", operation, { field, cause })

/** @internal */
export const decodeConfiguration = <A, I>(
  schema: Schema.Codec<A, I>,
  value: typeof Schema.Unknown.Type,
  operation: string
): Result.Result<A, ArgumentFailure> =>
  Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(value).pipe(
    Result.mapError((error) => argumentFailure(operation, configurationField(error.issue), error))
  )

// Marks a check whose failure means the input spells a value wrongly (noncanonical base64, an oversized decimal)
// rather than having the wrong shape.
/** @internal */
export const ENCODING_CHECK = "@effect-vfs/core/encodingCheck"

/** @internal */
export interface IssueSite {
  // Where the first failure is, from the decoded value's root.
  readonly path: ReadonlyArray<PropertyKey>
  // The checks the first failure was reported through, outermost first.
  readonly checks: ReadonlyArray<SchemaAST.Filter<unknown>>
}

// Follows an issue to its first failure. A decode stops at the first failure, so the first branch of every
// composite issue is the one that failed.
/** @internal */
export const issueSite = (issue: SchemaIssue.Issue): IssueSite => {
  const path: Array<PropertyKey> = []
  const checks: Array<SchemaAST.Filter<unknown>> = []
  let current: SchemaIssue.Issue | undefined = issue

  while (current !== undefined) {
    if (Predicate.isTagged("Pointer")(current)) {
      path.push(...current.path)
      current = current.issue
    } else if (Predicate.isTagged("Filter")(current)) {
      checks.push(current.filter)
      current = current.issue
    } else if (Predicate.isTagged("Encoding")(current)) current = current.issue
    else if (Predicate.isTagged("Composite")(current) || Predicate.isTagged("AnyOf")(current)) {
      current = current.issues[0]
    } else current = undefined
  }

  return { path, checks }
}

/** @internal */
export const isEncodingIssue = (site: IssueSite): boolean =>
  site.checks.some((check) => check.annotations?.[ENCODING_CHECK] === true)

/** @internal */
export const fsFailure = (code: FsCode, operation: string, details?: Details): FsFailure =>
  build(code, operation, details)

/** @internal */
export const imageFailure = (
  operation: string,
  code: ImageCode,
  details?: { readonly field?: string; readonly cause?: unknown }
): ImageFailure => build(code, operation, details)

// A codec builds its failures under its own name; the public entry point that ran it names the operation.
/** @internal */
const retarget = (operation: string, error: VfsError): VfsError =>
  error.operation === operation
    ? error
    : makeError({ code: error.code, operation, field: error.field, path: error.path, cause: error.cause })

// Leaves failures from other services alone.
/** @internal */
export const retargetFailure = <E>(operation: string, error: E): E => {
  if (!Schema.is(VfsError)(error)) return error

  // SAFETY: only the operation changes, so the narrowed code the channel holds still applies.
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- see the invariant above.
  return retarget(operation, error) as E
}

/** @internal */
export interface OpContext {
  readonly operation: string
  readonly fail: (code: FsCode, details?: { readonly cause?: unknown; readonly field?: string }) => FsFailure
  // Failures from the returned context name `path`, so a helper takes one context rather than a context and a path.
  readonly at: (path: PathInput) => OpContext
}

const makeOpContext = (operation: string, located?: PathInput): OpContext => ({
  operation,
  fail: (code, details) => fsFailure(code, operation, located === undefined ? details : { ...details, path: located }),
  // An input that is neither a string nor a byte path (an untyped caller's mistake) names no path.
  at: (path) => makeOpContext(operation, Predicate.isString(path) || isBytePath(path) ? path : undefined)
})

/** @internal */
export const OpContext = {
  make: (operation: string): OpContext => makeOpContext(operation)
}
