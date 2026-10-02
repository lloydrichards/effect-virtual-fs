import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as RegExp from "effect/RegExp"
import * as Schema from "effect/Schema"
import {
  BudgetExceeded,
  ContentQuery,
  type CountResult,
  defaultLimits,
  type LineResult,
  Pattern,
  QueryFailure
} from "../Search.js"
import type { Snapshot } from "../Snapshot.js"
import * as Glob from "./glob.js"
import * as Visitor from "./search.js"
import { makeMeter } from "./searchModel.js"

/** @internal */
export interface ContentRows {
  readonly lines: LineResult
  readonly files: string
  readonly countLines: CountResult
}

/** @internal */
export type Mode = keyof ContentRows

const stepBytes = 4_096

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

// Valid UTF-8 has one scalar per leading byte; classification proves these widths.
const scalarWidth = (byte: number): number => byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4

const classify = Effect.fnUntraced(function*(data: Uint8Array) {
  let binary = false
  let checkpoint = stepBytes

  for (let index = 0; index < data.length;) {
    if (index >= checkpoint) {
      yield* Effect.yieldNow
      checkpoint = index + stepBytes
    }

    const first = data[index]!

    if (first === 0) binary = true

    if (first < 0x80) {
      index++
      continue
    }

    const width = scalarWidth(first)

    if (first < 0xc2 || first > 0xf4 || index + width > data.length) return "invalid"
    const second = data[index + 1]!

    if (second < 0x80 || second > 0xbf) return "invalid"

    if (first === 0xe0 && second < 0xa0 || first === 0xed && second > 0x9f) return "invalid"

    if (first === 0xf0 && second < 0x90 || first === 0xf4 && second > 0x8f) return "invalid"

    for (let offset = 2; offset < width; offset++) {
      const byte = data[index + offset]!

      if (byte < 0x80 || byte > 0xbf) return "invalid"
    }

    index += width
  }

  return binary ? "binary" : "text"
})

const offsets = Effect.fnUntraced(function*(data: Uint8Array, start: number, matchStart: number, matchEnd: number) {
  let index = start
  let units = 0
  let rangeStart = start
  let checkpoint = start + stepBytes

  while (units < matchEnd) {
    if (index >= checkpoint) {
      yield* Effect.yieldNow
      checkpoint = index + stepBytes
    }

    if (units === matchStart) rangeStart = index
    const width = scalarWidth(data[index]!)
    units += width === 4 ? 2 : 1
    index += width
  }

  if (matchStart === matchEnd) rangeStart = index

  return { start: rangeStart, end: index }
})

interface Cursor {
  readonly entry: Visitor.Entry
  readonly data: Uint8Array
  offset: number
  lineNumber: number
  count: number
}

/** @internal */
export const evaluate = Effect.fnUntraced(function*<M extends Mode>(snapshot: Snapshot, input: ContentQuery, mode: M) {
  const query = yield* Schema.decodeEffect(ContentQuery, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError((error) => new QueryFailure({ field: "query", message: error.message }))
  )

  const limits = { ...defaultLimits, ...query.limits }
  const source = query.pattern.pattern
  let sourceBytes = 0n
  let sourceCheckpoint = stepBytes

  // Count source bytes before constructing a regex or an escaped literal source.
  for (let index = 0; index < source.length;) {
    const scalar = source.codePointAt(index)!
    sourceBytes += scalar < 0x80 ? 1n : scalar < 0x800 ? 2n : scalar < 0x10000 ? 3n : 4n

    if (sourceBytes > limits.maxPatternBytes) {
      return yield* new QueryFailure({
        field: "pattern",
        message: "Pattern source exceeds maxPatternBytes",
        limit: "maxPatternBytes"
      })
    }

    index += scalar > 0xffff ? 2 : 1

    if (index >= sourceCheckpoint) {
      yield* Effect.yieldNow
      sourceCheckpoint = index + stepBytes
    }
  }

  const pattern = yield* Effect.try({
    try: () =>
      new globalThis.RegExp(
        Pattern.match(query.pattern, {
          Literal: ({ pattern }) => RegExp.escape(pattern),
          Regex: ({ pattern }) => pattern
        }),
        query.ignoreCase ? "ui" : "u"
      ),
    catch: (error) => new QueryFailure({ field: "pattern", pattern: source, message: String(error) })
  })

  const selectors = yield* Glob.compile(query, limits)
  const meter = makeMeter(limits)
  const visitor = yield* Visitor.makeVisitor(snapshot, query.root, meter)
  let current: Cursor | undefined
  let rows = 0

  let stopped: BudgetExceeded | undefined = limits.maxResults === 0
    ? new BudgetExceeded({ limit: "maxResults", path: "" })
    : undefined

  const select = Effect.fnUntraced(function*(entry: Visitor.Entry) {
    const match = yield* Glob.matches(selectors, entry.parts, entry.kind, meter)

    return { selected: entry.kind === "file" && !match.excluded && match.included, prune: match.excluded }
  })

  const reserve = Effect.fnUntraced(function*(size: bigint, path: string) {
    if (size > limits.maxResultBytes - meter.work.resultBytes) {
      return yield* new BudgetExceeded({ limit: "maxResultBytes", path })
    }

    meter.work.resultBytes = ByteSize.bytes(meter.work.resultBytes + size)
    rows++

    if (rows === limits.maxResults) stopped = new BudgetExceeded({ limit: "maxResults", path })
  })

  const next = Effect.fnUntraced(function*(): Effect.fn.Return<ContentRows[M] | undefined, BudgetExceeded> {
    if (stopped !== undefined) return yield* stopped

    while (true) {
      if (current === undefined) {
        const entry = yield* visitor.next(select)

        if (entry === undefined) return undefined

        if (entry.node.kind !== "file") continue
        const data = entry.node.data
        const size = BigInt(data.length)

        if (size > limits.maxFileBytes) {
          meter.skips.oversizedFiles++
          continue
        }

        if (size > limits.maxScannedBytes - meter.work.scannedBytes) {
          return yield* new BudgetExceeded({ limit: "maxScannedBytes", path: entry.path })
        }

        meter.work.scannedBytes = ByteSize.bytes(meter.work.scannedBytes + size)
        const classification = yield* classify(data)

        if (classification === "invalid") {
          meter.skips.invalidUtf8Files++
          continue
        }

        if (classification === "binary") {
          meter.skips.binaryFiles++
          continue
        }

        current = { entry, data, offset: 0, lineNumber: 0, count: 0 }
      }

      const cursor = current

      if (cursor.offset === cursor.data.length) {
        current = undefined

        if (mode === "countLines" && cursor.count > 0) {
          yield* reserve(BigInt(cursor.entry.pathBytes) + 8n, cursor.entry.path)

          // SAFETY: The countLines branch selects the corresponding generic row type.
          return { path: cursor.entry.path, count: cursor.count } as ContentRows[M]
        }

        continue
      }

      if (meter.work.lineEvaluations === limits.maxLineEvaluations) {
        return yield* new BudgetExceeded({ limit: "maxLineEvaluations", path: cursor.entry.path })
      }

      const start = cursor.offset
      let end = start
      let checkpoint = start + stepBytes

      while (end < cursor.data.length && cursor.data[end] !== 10) {
        end++

        if (end >= checkpoint) {
          yield* Effect.yieldNow
          checkpoint = end + stepBytes
        }
      }

      const hasLf = end < cursor.data.length
      cursor.offset = hasLf ? end + 1 : end

      if (hasLf && end > start && cursor.data[end - 1] === 13) end--
      cursor.lineNumber++
      const line = decoder.decode(cursor.data.subarray(start, end))
      meter.work.lineEvaluations++
      const match = mode === "lines" ? pattern.exec(line) : undefined
      const matched = mode === "lines" ? match !== null : pattern.test(line)
      // Regex calls themselves are synchronous; only owned work is interruptible.
      yield* Effect.yieldNow

      if (!matched) continue
      cursor.count++

      if (mode === "countLines") continue

      if (mode === "files") {
        yield* reserve(BigInt(cursor.entry.pathBytes), cursor.entry.path)
        current = undefined

        // SAFETY: The files branch selects the corresponding generic row type.
        return cursor.entry.path as ContentRows[M]
      }

      const range = yield* offsets(cursor.data, start, match!.index, match!.index + match![0].length)
      let excerptEnd = range.start
      checkpoint = excerptEnd + stepBytes

      while (excerptEnd < end) {
        const width = scalarWidth(cursor.data[excerptEnd]!)

        if (BigInt(excerptEnd + width - range.start) > limits.maxExcerptBytes) break
        excerptEnd += width

        if (excerptEnd >= checkpoint) {
          yield* Effect.yieldNow
          checkpoint = excerptEnd + stepBytes
        }
      }

      yield* reserve(BigInt(cursor.entry.pathBytes + 16 + excerptEnd - range.start), cursor.entry.path)

      // SAFETY: The files and countLines branches returned or continued above; this is a lines row.
      return {
        path: cursor.entry.path,
        lineNumber: cursor.lineNumber,
        range,
        excerpt: {
          text: decoder.decode(cursor.data.subarray(range.start, excerptEnd)),
          start: range.start,
          truncated: range.start > start || excerptEnd < end
        }
      } as ContentRows[M]
    }
  })

  return { query, meter, next }
})
