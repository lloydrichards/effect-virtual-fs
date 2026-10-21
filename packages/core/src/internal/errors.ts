import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as SchemaAST from "effect/SchemaAST"
import type * as SchemaIssue from "effect/SchemaIssue"
import { type ImageCode, type ImageFailure, make as makeError, VfsError } from "../VfsError.js"

// Distinguishes invalid value encoding from invalid structure.
/** @internal */
export const ENCODING_CHECK = "@effect-vfs/core/encodingCheck"

/** @internal */
export interface IssueSite {
  readonly path: ReadonlyArray<PropertyKey>
  readonly checks: ReadonlyArray<SchemaAST.Filter<unknown>>
}

// Decoding stops at the first failure; composite issues put it in their first branch.
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
export const imageFailure = (
  operation: string,
  code: ImageCode,
  details?: { readonly field?: string; readonly cause?: unknown }
): ImageFailure => makeError({ code, operation, field: details?.field, path: undefined, cause: details?.cause })

/** @internal */
const retarget = (operation: string, error: VfsError): VfsError =>
  error.operation === operation
    ? error
    : makeError({ code: error.code, operation, field: error.field, path: error.path, cause: error.cause })

/** @internal */
export const retargetFailure = <E>(operation: string, error: E): E => {
  if (!Schema.is(VfsError)(error)) return error

  // SAFETY: retarget changes only the operation, preserving E's error variant.
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- see the invariant above.
  return retarget(operation, error) as E
}
