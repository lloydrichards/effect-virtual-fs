/**
 * Bounded filename search over an explicit immutable snapshot.
 *
 * Search grants the snapshot's authority, without caller permission filtering.
 * Paths are exact UTF-8 strings relative to the selected directory root. Hidden
 * names are included, discovered symlinks are not followed, and hard-link names
 * are searched independently. Glob never reads or copies file contents.
 *
 * @since 0.8.0
 */
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { BytePath } from "./BytePath.js"
import * as Glob from "./internal/glob.js"
import * as Visitor from "./internal/search.js"
import * as Internal from "./internal/searchModel.js"
import type { Snapshot } from "./Snapshot.js"
import type { FsFailure, ImageFailure } from "./VfsError.js"

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
 * Complete finite search limits, including reserved content-work limits.
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
 * matching operations. Content bounds are shared for later content modes;
 * glob performs no content work. These bounds do not promise a deadline or
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
 * Work counts, with exact raw UTF-8 result bytes.
 *
 * @category schemas
 * @since 0.8.0
 */
export const Work = Schema.Struct({
  entries: Schema.Natural,
  matchingWork: Schema.Natural,
  resultBytes: Schema.ByteSize,
  scannedBytes: Schema.ByteSize,
  lineEvaluations: Schema.Natural
})

/**
 * Work counts, with exact raw UTF-8 result bytes.
 *
 * @category models
 * @since 0.8.0
 */
export type Work = typeof Work.Type

/**
 * Counted policy skips. Descendants of skipped directories are not estimated.
 *
 * @category schemas
 * @since 0.8.0
 */
export const Skips = Schema.Struct({
  invalidNames: Schema.Natural,
  invalidNameSubtrees: Schema.Natural,
  oversizedFiles: Schema.Natural,
  invalidUtf8Files: Schema.Natural,
  binaryFiles: Schema.Natural
})

/**
 * Counted policy skips.
 *
 * @category models
 * @since 0.8.0
 */
export type Skips = typeof Skips.Type

/**
 * `Complete` exhausts the eligible namespace, possibly with skips. `Stopped`
 * names the exhausted bound and a root-relative path when representable.
 * The empty string identifies the selected root. Stopping does not assert
 * that another matching entry exists.
 *
 * @category schemas
 * @since 0.8.0
 */
export const Completion = Schema.Union([
  Schema.TaggedStruct("Complete", {}),
  Schema.TaggedStruct("Stopped", { limit: Limit, path: Schema.optionalKey(Schema.String) })
])

/**
 * Query completion with an actual stopping bound.
 *
 * @category models
 * @since 0.8.0
 */
export type Completion = typeof Completion.Type

/**
 * A selected root, preceding results, counters and completion.
 *
 * @category schemas
 * @since 0.8.0
 */
export const GlobReport = Schema.Struct({
  root: GlobQuery.fields.root,
  results: Schema.Array(Schema.String),
  work: Work,
  skips: Skips,
  completion: Completion
})

/**
 * A selected root, preceding results, counters and completion.
 *
 * @category models
 * @since 0.8.0
 */
export type GlobReport = typeof GlobReport.Type

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
 * Query and snapshot failures preserved by collectors.
 *
 * @category errors
 * @since 0.8.0
 */
export type GlobFailure = QueryFailure | FsFailure | ImageFailure

/**
 * Stream failures, including exhaustion after earlier rows.
 *
 * @category errors
 * @since 0.8.0
 */
export type ScanGlobFailure = GlobFailure | BudgetExceeded

const evaluate = Effect.fnUntraced(function*(snapshot: Snapshot, input: GlobQuery) {
  const { query, limits } = yield* Internal.query(input)
  const patterns = yield* Glob.compile(query, limits)
  const meter = Internal.makeMeter(limits)
  const visitor = yield* Visitor.makeVisitor(snapshot, query.root, meter)
  let rows = 0

  let stopped: BudgetExceeded | undefined = limits.maxResults === 0
    ? new BudgetExceeded({ limit: "maxResults", path: "" })
    : undefined

  const select = Effect.fnUntraced(function*(entry: Visitor.Entry) {
    const match = yield* Glob.matches(patterns, entry.parts, entry.kind, meter)

    return {
      selected: !match.excluded && match.included && (query.kinds === undefined || query.kinds.includes(entry.kind)),
      prune: match.excluded
    }
  })

  const next = Effect.fnUntraced(function*(): Effect.fn.Return<string | undefined, BudgetExceeded> {
    if (stopped !== undefined) return yield* stopped
    const entry = yield* visitor.next(select)

    if (entry === undefined) return undefined
    const size = BigInt(entry.pathBytes)

    if (size > limits.maxResultBytes - meter.work.resultBytes) {
      return yield* new BudgetExceeded({ limit: "maxResultBytes", path: entry.path })
    }

    meter.work.resultBytes = ByteSize.bytes(meter.work.resultBytes + size)
    rows += 1

    if (rows === limits.maxResults) stopped = new BudgetExceeded({ limit: "maxResults", path: entry.path })

    return entry.path
  })

  return { query, meter, next }
})

/**
 * Stream ordinary root-relative strings in depth-first preorder, with each
 * directory sorted by raw name bytes. Resolve the root through directory
 * symlinks; never follow discovered symlinks or emit the root itself.
 *
 * A budget failure may follow earlier rows. Taking a prefix establishes no
 * completion. Use `glob` when skip counts or coverage matter. Each evaluation
 * owns fresh traversal and counters, including repeated or concurrent runs.
 *
 * @example
 * ```ts
 * import * as BunCrypto from "@effect/platform-bun/BunCrypto"
 * import { Search, VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import { Effect, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.fromFixture({ entries: [
 *     { kind: "file", path: "/😀.ts", bytes: new Uint8Array() }
 *   ] })
 *   const snapshot = yield* volume.snapshot
 *   return yield* Stream.runCollect(Search.scanGlob(snapshot, { root: "/", include: ["?.ts"] }))
 * })
 * Effect.runPromise(program.pipe(Effect.provide(BunCrypto.layer))).then(console.log)
 * // [ '😀.ts' ]
 * ```
 *
 * @category operations
 * @since 0.8.0
 */
export const scanGlob = (snapshot: Snapshot, query: GlobQuery): Stream.Stream<string, ScanGlobFailure> =>
  Stream.unwrap(
    Effect.map(evaluate(snapshot, query), ({ next }) =>
      Stream.unfold(
        undefined,
        Effect.fnUntraced(function*() {
          const row = yield* next()

          return row === undefined ? undefined : [row, undefined] as const
        })
      ))
  )

/**
 * Collect bounded matches and preserve preceding rows when a work or output
 * budget stops the query. Invalid queries, malformed patterns and snapshot
 * failures remain typed failures; interruption remains interruption.
 *
 * Reaching the row cap always reports `Stopped`, even for the last possible
 * result. Invalid UTF-8 names are counted skips, and invalid-name directories
 * count one skipped subtree without examining its descendants.
 *
 * @example
 * ```ts
 * import * as BunCrypto from "@effect/platform-bun/BunCrypto"
 * import { Search, VirtualFileSystem as Vfs } from "@effect-vfs/core"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const volume = yield* Vfs.fromFixture({ entries: [
 *     { kind: "file", path: "/a.ts", bytes: new Uint8Array() },
 *     { kind: "file", path: "/b.ts", bytes: new Uint8Array() }
 *   ] })
 *   return yield* Search.glob(yield* volume.snapshot, {
 *     root: "/", include: ["*.ts"], limits: { maxResults: 1 }
 *   })
 * })
 * Effect.runPromise(program.pipe(Effect.provide(BunCrypto.layer))).then((report) => {
 *   console.log(report.results, report.completion._tag)
 * })
 * // [ "a.ts" ] Stopped
 * ```
 *
 * @category operations
 * @since 0.8.0
 */
export const glob: (snapshot: Snapshot, query: GlobQuery) => Effect.Effect<GlobReport, GlobFailure> = Effect.fn(
  "Search.glob"
)(
  function*(snapshot: Snapshot, query: GlobQuery): Effect.fn.Return<GlobReport, GlobFailure> {
    const evaluation = yield* evaluate(snapshot, query)
    const results: Array<string> = []

    const completion: Completion = yield* Effect.gen(function*() {
      for (let row = yield* evaluation.next(); row !== undefined; row = yield* evaluation.next()) results.push(row)

      return Completion.members[0].make({})
    }).pipe(Effect.catchTag("SearchBudgetExceeded", (error) =>
      Effect.succeed(
        error.path === undefined
          ? Completion.members[1].make({ limit: error.limit })
          : Completion.members[1].make({ limit: error.limit, path: error.path })
      )))

    return {
      root: evaluation.query.root,
      results,
      work: { ...evaluation.meter.work },
      skips: { ...evaluation.meter.skips },
      completion
    }
  }
)
