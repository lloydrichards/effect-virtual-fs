import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { BytePath } from "../BytePath.js"
import type { Skips, Work } from "../Search.js"

/**
 * Entry kinds selected by filename queries.
 *
 * @category schemas
 * @since 0.8.0
 */
export const Kind = Schema.Literals(["file", "directory", "symlink"])

/**
 * Entry kinds selected by filename queries.
 *
 * @category models
 * @since 0.8.0
 */
export type Kind = typeof Kind.Type

const limitFields = {
  maxEntries: Schema.Natural,
  maxDepth: Schema.Natural,
  maxPathBytes: Schema.ByteSize,
  maxResults: Schema.Natural,
  maxResultBytes: Schema.ByteSize,
  maxPatternBytes: Schema.ByteSize,
  maxPatterns: Schema.Natural,
  maxPatternListBytes: Schema.ByteSize,
  maxExpansions: Schema.Natural,
  maxTokens: Schema.Natural,
  maxMatchingWork: Schema.Natural,
  maxScannedBytes: Schema.ByteSize,
  maxFileBytes: Schema.ByteSize,
  maxLineEvaluations: Schema.Natural,
  maxExcerptBytes: Schema.ByteSize
}

/**
 * Complete finite namespace, matching, content and output limits.
 *
 * @category schemas
 * @since 0.8.0
 */
export const Limits = Schema.Struct(limitFields)

/**
 * Complete finite search limits.
 *
 * @category models
 * @since 0.8.0
 */
export type Limits = typeof Limits.Type

/**
 * Optional overrides applied to default limits.
 *
 * @category schemas
 * @since 0.8.0
 */
export const LimitOverrides = Schema.Struct({
  maxEntries: Schema.optionalKey(limitFields.maxEntries),
  maxDepth: Schema.optionalKey(limitFields.maxDepth),
  maxPathBytes: Schema.optionalKey(limitFields.maxPathBytes),
  maxResults: Schema.optionalKey(limitFields.maxResults),
  maxResultBytes: Schema.optionalKey(limitFields.maxResultBytes),
  maxPatternBytes: Schema.optionalKey(limitFields.maxPatternBytes),
  maxPatterns: Schema.optionalKey(limitFields.maxPatterns),
  maxPatternListBytes: Schema.optionalKey(limitFields.maxPatternListBytes),
  maxExpansions: Schema.optionalKey(limitFields.maxExpansions),
  maxTokens: Schema.optionalKey(limitFields.maxTokens),
  maxMatchingWork: Schema.optionalKey(limitFields.maxMatchingWork),
  maxScannedBytes: Schema.optionalKey(limitFields.maxScannedBytes),
  maxFileBytes: Schema.optionalKey(limitFields.maxFileBytes),
  maxLineEvaluations: Schema.optionalKey(limitFields.maxLineEvaluations),
  maxExcerptBytes: Schema.optionalKey(limitFields.maxExcerptBytes)
})

/**
 * Optional overrides applied to default limits.
 *
 * @category models
 * @since 0.8.0
 */
export type LimitOverrides = typeof LimitOverrides.Type

/**
 * Names of compiler, traversal, output and content bounds.
 *
 * @category schemas
 * @since 0.8.0
 */
export const Limit = Schema.Literals([
  "maxEntries",
  "maxDepth",
  "maxPathBytes",
  "maxResults",
  "maxResultBytes",
  "maxPatternBytes",
  "maxPatterns",
  "maxPatternListBytes",
  "maxExpansions",
  "maxTokens",
  "maxMatchingWork",
  "maxScannedBytes",
  "maxFileBytes",
  "maxLineEvaluations",
  "maxExcerptBytes"
])

/**
 * Names of compiler, traversal, output and content bounds.
 *
 * @category models
 * @since 0.8.0
 */
export type Limit = typeof Limit.Type

/**
 * Finite default work policy. Byte limits use exact `ByteSize` values.
 *
 * Defaults are 100,000 entries, depth 256, 4 KiB paths, 100 rows, 64 KiB
 * result payload, 4 KiB per pattern, 128 pattern sources, 64 KiB aggregate
 * sources, 1,024 expanded alternatives, 65,536 compiled tokens, and 10 million
 * matching operations. Content defaults are 64 MiB scanned bytes, 1 MiB per
 * file, 100,000 line evaluations and 1 KiB excerpts. Glob performs no content work. These bounds do not promise a deadline or
 * measure JavaScript heap or serialized JSON size.
 *
 * @category defaults
 * @since 0.8.0
 */
export const defaultLimits: Limits = Object.freeze({
  maxEntries: 100_000,
  maxDepth: 256,
  maxPathBytes: ByteSize.bytes(4_096),
  maxResults: 100,
  maxResultBytes: ByteSize.bytes(65_536),
  maxPatternBytes: ByteSize.bytes(4_096),
  maxPatterns: 128,
  maxPatternListBytes: ByteSize.bytes(65_536),
  maxExpansions: 1_024,
  maxTokens: 65_536,
  maxMatchingWork: 10_000_000,
  maxScannedBytes: ByteSize.bytes(67_108_864),
  maxFileBytes: ByteSize.bytes(1_048_576),
  maxLineEvaluations: 100_000,
  maxExcerptBytes: ByteSize.bytes(1_024)
})

/**
 * An explicit directory root, nonempty include list and optional exclusions,
 * kinds and limits. All patterns are root-relative and case-sensitive.
 *
 * Wildcards and classes match Unicode code points without normalization.
 * Supports `*`, `?`, classes, comma brace alternatives, whole-segment `**`,
 * backslash escapes, and a directory-only trailing slash. Excluded directories
 * prune traversal. Include selectors and kind filters do not prune directories.
 *
 * @category schemas
 * @since 0.8.0
 */
export const GlobQuery = Schema.Struct({
  root: Schema.Union([Schema.String, BytePath]),
  include: Schema.NonEmptyArray(Schema.String),
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  kinds: Schema.optionalKey(Schema.Array(Kind)),
  limits: Schema.optionalKey(LimitOverrides)
})

/**
 * Filename query decoded by `GlobQuery`.
 *
 * @category models
 * @since 0.8.0
 */
export type GlobQuery = typeof GlobQuery.Type

/**
 * Invalid query, pattern syntax or aggregate compilation limit.
 *
 * @category errors
 * @since 0.8.0
 */
export class QueryFailure extends Schema.TaggedError<QueryFailure>()("SearchQueryFailure", {
  field: Schema.String,
  message: Schema.String,
  pattern: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Limit)
}) {}

/**
 * Typed runtime budget exhaustion.
 *
 * @category errors
 * @since 0.8.0
 */
export class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()("SearchBudgetExceeded", {
  limit: Limit,
  path: Schema.optionalKey(Schema.String)
}) {}

/**
 * Explicit content interpretation. Literal strings never become regex implicitly.
 *
 * @category schemas
 * @since 0.8.0
 */
export const Pattern = Schema.TaggedUnion({
  Literal: {
    pattern: Schema.NonEmptyString.check(
      Schema.makeFilter<string>(
        (value) =>
          !value.includes("\0") && !value.includes("\r") && !value.includes("\n") && !/[\ud800-\udfff]/u.test(value),
        {
          expected: "literal line text without NUL, CR, LF or lone surrogates"
        }
      )
    )
  },
  Regex: {
    pattern: Schema.String
  }
})

/**
 * Explicit literal or native regex content pattern.
 *
 * @category models
 * @since 0.8.0
 */
export type Pattern = typeof Pattern.Type

/**
 * Regular-file content selection using the same case-sensitive filename globs as
 * `GlobQuery`. Content `ignoreCase` defaults to false and never affects filenames.
 *
 * @category schemas
 * @since 0.8.0
 */
export const ContentQuery = Schema.Struct({
  root: GlobQuery.fields.root,
  include: GlobQuery.fields.include,
  exclude: GlobQuery.fields.exclude,
  pattern: Pattern,
  ignoreCase: Schema.optionalKey(Schema.Boolean),
  limits: GlobQuery.fields.limits
})

/**
 * Validated snapshot content query.
 *
 * @category models
 * @since 0.8.0
 */
export type ContentQuery = typeof ContentQuery.Type

/** @internal */
export const defaults: Limits = defaultLimits

/** @internal */
export interface Meter {
  readonly limits: Limits
  readonly work: { -readonly [K in keyof Work]: Work[K] }
  readonly skips: { -readonly [K in keyof Skips]: Skips[K] }
}

/** @internal */
export const makeMeter = (limits: Limits): Meter => ({
  limits,
  work: {
    entries: 0,
    matchingWork: 0,
    resultBytes: ByteSize.bytes(0),
    scannedBytes: ByteSize.bytes(0),
    lineEvaluations: 0
  },
  skips: { invalidNames: 0, invalidNameSubtrees: 0, oversizedFiles: 0, invalidUtf8Files: 0, binaryFiles: 0 }
})

/** @internal */
export const query = Effect.fnUntraced(function*(input: GlobQuery) {
  const decoded = yield* Schema.decodeEffect(GlobQuery, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError((error) => new QueryFailure({ field: "query", message: error.message }))
  )

  return { query: decoded, limits: { ...defaults, ...decoded.limits } }
})
