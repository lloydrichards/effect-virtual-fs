import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { defaultLimits as defaults, GlobQuery, type Limits, QueryFailure, type Skips, type Work } from "../Search.js"

/** @internal */
export { BudgetExceeded, defaultLimits as defaults, GlobQuery, Kind, Limits, QueryFailure } from "../Search.js"

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
