/**
 * Compiles bounded Unicode namespace globs and meters scalar matching work.
 *
 * @internal
 * @since 0.1.0
 */
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import { BudgetExceeded, type Kind, type Limits, type Meter, QueryFailure } from "./searchModel.js"

type Atom = { readonly low: number; readonly high: number }

type Token =
  | { readonly tag: "literal"; readonly value: string }
  | { readonly tag: "star" }
  | { readonly tag: "any" }
  | { readonly tag: "class"; readonly atoms: ReadonlyArray<Atom>; readonly negate: boolean }

type Segment = ReadonlyArray<Token> | "**"

interface Pattern {
  readonly segments: ReadonlyArray<Segment>
  readonly directory: boolean
}

/** @internal */
export interface CompiledSelectors {
  readonly include: ReadonlyArray<Pattern>
  readonly exclude: ReadonlyArray<Pattern>
}

/** @internal */
export const compile = Effect.fnUntraced(function*(
  selectors: { readonly include: ReadonlyArray<string>; readonly exclude?: ReadonlyArray<string> },
  limits: Limits
) {
  const fail = (
    pattern: string,
    message: string,
    limit?: "maxPatterns" | "maxPatternBytes" | "maxPatternListBytes" | "maxExpansions" | "maxTokens"
  ) =>
    limit === undefined
      ? new QueryFailure({ field: "patterns", pattern, message })
      : new QueryFailure({ field: "patterns", pattern, message, limit })

  if (selectors.include.length === 0) return yield* fail("", "At least one include pattern is required")

  if (selectors.include.length + (selectors.exclude?.length ?? 0) > limits.maxPatterns) {
    return yield* fail("", "Too many patterns", "maxPatterns")
  }

  const sources = [...selectors.include, ...selectors.exclude ?? []]
  let bytes = 0n
  let expansions = 0
  let tokens = 0
  let steps = 0
  const include: Array<Pattern> = []
  const exclude: Array<Pattern> = []

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex]!
    // Count scalar UTF-8 bytes before allocating expanded patterns.
    let sourceBytes = 0n

    for (const scalar of source) {
      const point = scalar.codePointAt(0)!

      if (point === 0 || point >= 0xd800 && point <= 0xdfff) {
        return yield* fail(source, "Patterns require Unicode scalar values without NUL")
      }

      sourceBytes += BigInt(point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4)

      if (sourceBytes > ByteSize.toBigInt(limits.maxPatternBytes)) {
        return yield* fail(source, "Pattern byte limit exceeded", "maxPatternBytes")
      }

      if (++steps % 128 === 0) yield* Effect.yieldNow
    }

    bytes += sourceBytes

    if (bytes > ByteSize.toBigInt(limits.maxPatternListBytes)) {
      return yield* fail(source, "Pattern list byte limit exceeded", "maxPatternListBytes")
    }

    const pending = [source]
    const expanded: Array<string> = []

    while (pending.length > 0) {
      const value = pending.pop()!
      const stack: Array<{ start: number; commas: Array<number> }> = []
      let choice: { start: number; end: number; commas: Array<number> } | undefined
      let inClass = false

      for (let i = 0; i < value.length; i++) {
        const char = value[i]!

        if (++steps % 128 === 0) yield* Effect.yieldNow

        if (char === "\\") {
          i++
          continue
        }

        if (char === "[") inClass = true

        if (char === "]") inClass = false

        if (inClass) continue

        if (char === "{") stack.push({ start: i, commas: [] })
        else if (char === "," && stack.length > 0) stack[stack.length - 1]!.commas.push(i)
        else if (char === "}") {
          const open = stack.pop()

          if (open === undefined) return yield* fail(source, "Unmatched closing brace")

          // Expand outer choices first so nested braces cannot duplicate sibling alternatives.
          if (open.commas.length > 0 && (choice === undefined || open.start < choice.start)) {
            choice = { ...open, end: i }
          }
        }
      }

      if (stack.length > 0) return yield* fail(source, "Unclosed brace")

      if (choice === undefined) {
        if (++expansions > limits.maxExpansions) return yield* fail(source, "Expansion limit exceeded", "maxExpansions")
        expanded.push(value)
      } else {
        const boundaries = [choice.start, ...choice.commas, choice.end]

        if (expansions + pending.length + boundaries.length - 1 > limits.maxExpansions) {
          return yield* fail(source, "Expansion limit exceeded", "maxExpansions")
        }

        for (let i = boundaries.length - 2; i >= 0; i--) {
          pending.push(
            value.slice(0, choice.start) + value.slice(boundaries[i]! + 1, boundaries[i + 1]) +
              value.slice(choice.end + 1)
          )
        }
      }
    }

    for (const value of expanded) {
      const directory = value.endsWith("/")
      const pieces = (directory ? value.slice(0, -1) : value).split("/")
      const segments: Array<Segment> = []

      for (const piece of pieces) {
        if (piece === "" || piece === "." || piece === "..") {
          return yield* fail(source, "Empty, absolute and dot segments are unsupported")
        }

        if (piece === "**") {
          if (++tokens > limits.maxTokens) return yield* fail(source, "Token limit exceeded", "maxTokens")
          segments.push("**")
          continue
        }

        const scalars = Array.from(piece)
        const segment: Array<Token> = []

        for (let i = 0; i < scalars.length; i++) {
          const scalar = scalars[i]!

          if (++tokens > limits.maxTokens) return yield* fail(source, "Token limit exceeded", "maxTokens")

          if (scalar === "\\") {
            const next = scalars[++i]

            if (next === undefined) return yield* fail(source, "Dangling escape")
            segment.push({ tag: "literal", value: next })
          } else if (scalar === "*") {
            if (scalars[i + 1] === "*") return yield* fail(source, "Globstar must occupy a whole segment")
            segment.push({ tag: "star" })
          } else if (scalar === "?") segment.push({ tag: "any" })
          else if (scalar === "[") {
            const negate = scalars[i + 1] === "!"

            if (negate) i++
            const atoms: Array<Atom> = []

            const read = () => {
              let char = scalars[++i]

              if (char === "\\") char = scalars[++i]

              return char?.codePointAt(0)
            }

            while (scalars[i + 1] !== "]") {
              const low = read()

              if (low === undefined) return yield* fail(source, "Unclosed character class")
              let high = low

              if (scalars[i + 1] === "-" && scalars[i + 2] !== "]") {
                i++
                const end = read()

                if (end === undefined || end < low) return yield* fail(source, "Invalid character range")
                high = end
              }

              if (++tokens > limits.maxTokens) return yield* fail(source, "Token limit exceeded", "maxTokens")
              atoms.push({ low, high })

              if (++steps % 128 === 0) yield* Effect.yieldNow
            }

            i++

            if (atoms.length === 0) return yield* fail(source, "Empty character class")
            segment.push({ tag: "class", atoms, negate })
          } else segment.push({ tag: "literal", value: scalar })

          if (++steps % 128 === 0) yield* Effect.yieldNow
        }

        segments.push(segment)
      }

      ;(sourceIndex < selectors.include.length ? include : exclude).push({ segments, directory })
    }
  }

  return { include, exclude } satisfies CompiledSelectors
})

/** @internal */
export const matches = Effect.fnUntraced(
  function*(compiled: CompiledSelectors, parts: ReadonlyArray<string>, kind: Kind, meter: Meter) {
    const path = parts.join("/")

    const tick = Effect.fnUntraced(function*() {
      if (meter.work.matchingWork >= meter.limits.maxMatchingWork) {
        return yield* new BudgetExceeded({ limit: "maxMatchingWork", path })
      }

      meter.work.matchingWork++

      if (meter.work.matchingWork % 128 === 0) yield* Effect.yieldNow
    })

    const segmentMatches = Effect.fnUntraced(function*(tokens: ReadonlyArray<Token>, text: string) {
      const scalars = Array.from(text)
      let previous = [true, ...scalars.map(() => false)]

      for (const token of tokens) {
        const next = scalars.map(() => false)
        next.push(false)

        for (let i = 0; i <= scalars.length; i++) {
          yield* tick()

          if (token.tag === "star") next[i] = previous[i]! || i > 0 && next[i - 1]!
          else if (i > 0 && previous[i - 1]) {
            if (token.tag === "any") next[i] = true
            else if (token.tag === "literal") next[i] = token.value === scalars[i - 1]
            else {
              const point = scalars[i - 1]!.codePointAt(0)!
              let found = false

              for (const atom of token.atoms) {
                yield* tick()

                if (point >= atom.low && point <= atom.high) {
                  found = true
                  break
                }
              }

              next[i] = token.negate ? !found : found
            }
          }
        }

        previous = next
      }

      return previous[scalars.length]!
    })

    const any = Effect.fnUntraced(function*(patterns: ReadonlyArray<Pattern>) {
      for (const pattern of patterns) {
        yield* tick()

        if (pattern.directory && kind !== "directory") continue
        let previous = [true, ...parts.map(() => false)]

        for (const segment of pattern.segments) {
          const next = parts.map(() => false)
          next.push(false)

          for (let i = 0; i <= parts.length; i++) {
            yield* tick()
            next[i] = segment === "**"
              ? previous[i]! || i > 0 && next[i - 1]!
              : i > 0 && previous[i - 1]! && (yield* segmentMatches(segment, parts[i - 1]!))
          }

          previous = next
        }

        if (previous[parts.length]) return true
      }

      return false
    })

    const excluded = yield* any(compiled.exclude)

    return { excluded, included: excluded ? false : yield* any(compiled.include) }
  }
)
