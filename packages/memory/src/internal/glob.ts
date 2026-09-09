/**
 * Compiles and matches the bounded POSIX glob syntax used by the memory adapter.
 *
 * @internal
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { badArgument } from "effect/PlatformError"
const argumentError = (method: string, description: string) =>
  badArgument({ module: "FileSystem", method, description })

const MAX_BRACE_EXPANSIONS = 256

interface GlobLiteral {
  readonly _tag: "Literal"
  readonly value: string
}

interface GlobStar {
  readonly _tag: "Star"
}

interface GlobOne {
  readonly _tag: "One"
}

interface GlobCharacterClass {
  readonly _tag: "CharacterClass"
  readonly negated: boolean
  readonly ranges: ReadonlyArray<readonly [string, string]>
  readonly literals: ReadonlyArray<string>
}

type GlobToken = GlobLiteral | GlobStar | GlobOne | GlobCharacterClass

const GlobToken = Data.taggedEnum<GlobToken>()

interface GlobSegment {
  readonly _tag: "Segment"
  readonly tokens: ReadonlyArray<GlobToken>
  readonly startsWithDot: boolean
}

interface GlobGlobstar {
  readonly _tag: "Globstar"
}

type CompiledGlobSegment = GlobSegment | GlobGlobstar

interface CompiledGlobPattern {
  readonly segments: ReadonlyArray<CompiledGlobSegment>
  readonly directoryOnly: boolean
}

interface BraceExpansion {
  readonly start: number
  readonly end: number
  readonly alternatives: ReadonlyArray<string>
}

interface GlobCharacterClassAtom {
  readonly value: string
  readonly escaped: boolean
}

const globSyntaxCharacters = new Set(["*", "?", "[", "]", "{", "}", ",", "\\"])

const findBraceExpansion = (pattern: string): BraceExpansion | undefined => {
  for (let start = 0; start < pattern.length; start++) {
    if (pattern[start] === "\\") {
      start += 1
      continue
    }
    if (pattern[start] !== "{") continue
    let depth = 1
    let characterClass = false
    let closed = false
    const commas: Array<number> = []
    for (let end = start + 1; end < pattern.length; end++) {
      if (pattern[end] === "\\") {
        end += 1
        continue
      }
      if (pattern[end] === "[") {
        characterClass = true
      } else if (pattern[end] === "]") {
        characterClass = false
      } else if (!characterClass && pattern[end] === "{") {
        depth += 1
      } else if (!characterClass && pattern[end] === "}") {
        depth -= 1
        if (depth === 0) {
          closed = true
          if (commas.length === 0) {
            const nested = findBraceExpansion(pattern.slice(start + 1, end))
            if (nested !== undefined) {
              return {
                start: start + nested.start + 1,
                end: start + nested.end + 1,
                alternatives: nested.alternatives
              }
            }
            start = end
            break
          }
          const alternatives: Array<string> = []
          let alternativeStart = start + 1
          for (const comma of [...commas, end]) {
            alternatives.push(pattern.slice(alternativeStart, comma))
            alternativeStart = comma + 1
          }
          return { start, end, alternatives }
        }
      } else if (!characterClass && pattern[end] === "," && depth === 1) {
        commas.push(end)
      }
    }
    if (!closed) return undefined
  }
  return undefined
}

const expandBraces = (method: string, pattern: string) => {
  let patterns = [pattern]
  while (true) {
    const index = patterns.findIndex((pattern) => findBraceExpansion(pattern) !== undefined)
    if (index === -1) return Effect.succeed(patterns)
    const current = patterns[index]!
    const expansion = findBraceExpansion(current)
    if (expansion === undefined) return Effect.succeed(patterns)
    if (patterns.length - 1 + expansion.alternatives.length > MAX_BRACE_EXPANSIONS) {
      return Effect.fail(argumentError(method, `brace expansion exceeds ${MAX_BRACE_EXPANSIONS} alternatives`))
    }
    patterns = [
      ...patterns.slice(0, index),
      ...expansion.alternatives.map((alternative) =>
        `${current.slice(0, expansion.start)}${alternative}${current.slice(expansion.end + 1)}`
      ),
      ...patterns.slice(index + 1)
    ]
  }
}

const parseCharacterClass = (method: string, segment: string, start: number) => {
  let index = start + 1
  const negated = segment[index] === "!"
  if (negated) index += 1
  const characters: Array<GlobCharacterClassAtom> = []
  while (index < segment.length) {
    if (segment[index] === "]" && characters.length > 0) break
    let escaped = false
    if (segment[index] === "\\") {
      escaped = true
      index += 1
      if (index === segment.length) {
        return argumentError(method, "character classes must not end with an escape")
      }
    }
    characters.push({ value: segment.charAt(index), escaped })
    index += 1
  }
  if (index === segment.length || characters.length === 0) {
    return argumentError(method, "character classes must be closed and non-empty")
  }
  const literals: Array<string> = []
  const ranges: Array<readonly [string, string]> = []
  for (let characterIndex = 0; characterIndex < characters.length; characterIndex++) {
    const character = characters[characterIndex]!
    if (
      characterIndex + 2 < characters.length &&
      characters[characterIndex + 1]!.value === "-" &&
      !characters[characterIndex + 1]!.escaped &&
      characters[characterIndex + 2]!.value !== "-"
    ) {
      const end = characters[characterIndex + 2]!.value
      if (character.value > end) {
        return argumentError(method, "character class ranges must be ascending")
      }
      ranges.push([character.value, end])
      characterIndex += 2
    } else {
      literals.push(character.value)
    }
  }
  return Effect.succeed([GlobToken.CharacterClass({ negated, ranges, literals }), index + 1] as const)
}

const parseGlobSegment = Effect.fnUntraced(function*(method: string, segment: string) {
  if (segment === "**") return { _tag: "Globstar" } satisfies GlobGlobstar
  const tokens: Array<GlobToken> = []
  let index = 0
  while (index < segment.length) {
    const character = segment.charAt(index)
    if (character === "\\") {
      index += 1
      if (index === segment.length) {
        return yield* argumentError(method, "patterns must not end with an escape")
      }
      const value = segment.charAt(index)
      if (globSyntaxCharacters.has(value)) {
        tokens.push(GlobToken.Literal({ value }))
      } else {
        tokens.push(GlobToken.Literal({ value: "\\" }))
        index -= 1
      }
    } else if (character === "*") {
      tokens.push(GlobToken.Star())
    } else if (character === "?") {
      tokens.push(GlobToken.One())
    } else if (character === "[") {
      const parsed = yield* parseCharacterClass(method, segment, index)
      tokens.push(parsed[0])
      index = parsed[1] - 1
    } else {
      tokens.push(GlobToken.Literal({ value: character }))
    }
    index += 1
  }
  return {
    _tag: "Segment",
    tokens,
    startsWithDot: tokens[0]?._tag === "Literal" && tokens[0].value === "." ||
      tokens[0]?._tag === "CharacterClass" &&
        !tokens[0].negated &&
        (tokens[0].literals.includes(".") ||
          tokens[0].ranges.some(([start, end]) => start <= "." && "." <= end))
  } satisfies GlobSegment
})

const compileGlobPattern = Effect.fnUntraced(function*(method: string, pattern: string) {
  if (pattern.length === 0 || pattern.includes("\0") || pattern.startsWith("/")) {
    return yield* argumentError(method, "pattern must be a root-relative POSIX glob")
  }
  const directoryOnly = pattern.endsWith("/")
  const path = directoryOnly ? pattern.slice(0, -1) : pattern
  const segments = path.split("/")
  if (segments.includes("") || segments.includes(".") || segments.includes("..")) {
    return yield* argumentError(method, "pattern must not contain empty or dot path segments")
  }
  const compiled = yield* Effect.forEach(segments, (segment) => parseGlobSegment(method, segment))
  return { segments: compiled, directoryOnly } satisfies CompiledGlobPattern
})

/** @internal */
export const compileGlobPatterns = Effect.fnUntraced(function*(method: string, pattern: string) {
  const expanded = yield* expandBraces(method, pattern)
  return yield* Effect.forEach(expanded, (alternative) => compileGlobPattern(method, alternative))
})

const matchesGlobToken = (token: GlobToken, value: string): boolean =>
  GlobToken.$match(token, {
    Literal: (token) => token.value === value,
    Star: () => false,
    One: () => true,
    CharacterClass: (token) => {
      const matches = token.literals.includes(value) ||
        token.ranges.some(([start, end]) => start <= value && value <= end)
      return token.negated ? !matches : matches
    }
  })

const matchesGlobSegment = (pattern: GlobSegment, value: string): boolean => {
  if (value.startsWith(".") && !pattern.startsWithDot) return false
  let patternIndex = 0
  let valueIndex = 0
  let starIndex = -1
  let starValueIndex = -1
  while (valueIndex < value.length) {
    const token = pattern.tokens[patternIndex]
    if (token !== undefined && token._tag !== "Star" && matchesGlobToken(token, value.charAt(valueIndex))) {
      patternIndex += 1
      valueIndex += 1
    } else if (token?._tag === "Star") {
      starIndex = patternIndex
      starValueIndex = valueIndex
      patternIndex += 1
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1
      starValueIndex += 1
      valueIndex = starValueIndex
    } else {
      return false
    }
  }
  while (pattern.tokens[patternIndex]?._tag === "Star") {
    patternIndex += 1
  }
  return patternIndex === pattern.tokens.length
}

/** @internal */
export const matchesGlob = (pattern: CompiledGlobPattern, path: ReadonlyArray<string>, directory: boolean): boolean => {
  if (pattern.directoryOnly && !directory) return false
  // Each row includes the terminal column; loop bounds keep every indexed cell present.
  let next = Array.from({ length: path.length + 1 }, (_, index) => index === path.length)
  for (let patternIndex = pattern.segments.length - 1; patternIndex >= 0; patternIndex--) {
    const current = Array.from({ length: path.length + 1 }, () => false)
    const segment = pattern.segments[patternIndex]!
    if (segment._tag === "Globstar") {
      for (let pathIndex = path.length; pathIndex >= 0; pathIndex--) {
        current[pathIndex] = next[pathIndex]! ||
          pathIndex < path.length &&
            !path[pathIndex]!.startsWith(".") &&
            current[pathIndex + 1]!
      }
    } else {
      for (let pathIndex = path.length - 1; pathIndex >= 0; pathIndex--) {
        current[pathIndex] = matchesGlobSegment(segment, path[pathIndex]!) && next[pathIndex + 1]!
      }
    }
    next = current
  }
  return next[0]!
}
