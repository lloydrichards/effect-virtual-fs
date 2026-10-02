import { assert, describe, it } from "@effect/vitest"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import { compile, matches } from "../../src/internal/glob.js"
import { defaults, makeMeter } from "../../src/internal/searchModel.js"

describe("Unicode glob matcher", () => {
  it.effect("matches scalar wildcards, numeric ranges, escapes and nested alternatives", () =>
    Effect.gen(function*() {
      for (
        const [pattern, path, expected] of [
          ["?.ts", "😀.ts", true],
          ["??.ts", "😀.ts", false],
          ["[😀-🙏]", "😁", true],
          ["[!😀-🙏]", "x", true],
          ["\\*", "*", true],
          ["{a,{b,c}}", "c", true],
          ["**/*.ts", ".hidden/😀.ts", true],
          ["a/**/z", "a/z", true],
          ["{1..3}", "{1..3}", true],
          ["@(a)", "@(a)", true]
        ] as const
      ) {
        const compiled = yield* compile({ include: [pattern] }, defaults)
        assert.strictEqual((yield* matches(compiled, path.split("/"), "file", makeMeter(defaults))).included, expected)
      }
    }))
  it.effect("rejects malformed scalar syntax and path segments", () =>
    Effect.gen(function*() {
      for (
        const pattern of [
          "",
          "/a",
          "a//b",
          ".",
          "..",
          "a/**b",
          "[",
          "[]",
          "[z-a]",
          "{a,b",
          "a}",
          "a\\",
          "\u0000",
          "\ud800"
        ]
      ) {
        assert.strictEqual((yield* Effect.flip(compile({ include: [pattern] }, defaults)))._tag, "SearchQueryFailure")
      }
    }))
  it.effect("applies directory selection and exclusions", () =>
    Effect.gen(function*() {
      const compiled = yield* compile({ include: ["**/"], exclude: ["private/**"] }, defaults)
      assert.deepStrictEqual(yield* matches(compiled, ["a"], "directory", makeMeter(defaults)), {
        included: true,
        excluded: false
      })
      assert.deepStrictEqual(yield* matches(compiled, ["a"], "file", makeMeter(defaults)), {
        included: false,
        excluded: false
      })
      assert.deepStrictEqual(yield* matches(compiled, ["private", "x"], "directory", makeMeter(defaults)), {
        included: false,
        excluded: true
      })
    }))
  it.effect("bounds aggregate compilation across includes and excludes", () =>
    Effect.gen(function*() {
      for (
        const [override, include, exclude, limit] of [
          [{ maxPatterns: 1 }, ["a"], ["b"], "maxPatterns"],
          [{ maxPatternBytes: ByteSize.bytes(3) }, ["😀"], [], "maxPatternBytes"],
          [{ maxPatternListBytes: ByteSize.bytes(1) }, ["a"], ["b"], "maxPatternListBytes"],
          [{ maxExpansions: 3 }, ["{a,b}{c,d}"], [], "maxExpansions"],
          [{ maxTokens: 2 }, ["a"], ["bc"], "maxTokens"]
        ] as const
      ) {
        assert.strictEqual(
          (yield* Effect.flip(compile({ include, exclude }, { ...defaults, ...override }))).limit,
          limit
        )
      }

      yield* compile({ include: ["{a,b}"], exclude: ["c"] }, { ...defaults, maxExpansions: 3 })
    }))
  it.effect("counts nested brace alternatives without duplicating outer choices", () =>
    Effect.gen(function*() {
      const compiled = yield* compile({ include: ["{a,{b,c}}"] }, { ...defaults, maxExpansions: 3, maxTokens: 3 })

      for (const path of ["a", "b", "c"]) {
        assert.strictEqual((yield* matches(compiled, [path], "file", makeMeter(defaults))).included, true)
      }

      assert.strictEqual(
        (yield* Effect.flip(compile({ include: ["{a,{b,c}}"] }, { ...defaults, maxExpansions: 2 }))).limit,
        "maxExpansions"
      )
      const selectors = yield* compile({ include: ["{a,{b,c}}"], exclude: ["z"] }, { ...defaults, maxExpansions: 4 })
      assert.strictEqual((yield* matches(selectors, ["c"], "file", makeMeter(defaults))).included, true)
    }))

  it.effect("counts class checks and stops with an exact typed matching budget", () =>
    Effect.gen(function*() {
      const compiled = yield* compile({ include: ["[abcdef]"] }, defaults)
      const meter = makeMeter({ ...defaults, maxMatchingWork: 5 })
      const error = yield* Effect.flip(matches(compiled, ["f"], "file", meter))
      assert.deepStrictEqual([error._tag, error.limit, error.path], ["SearchBudgetExceeded", "maxMatchingWork", "f"])
      assert.strictEqual(meter.work.matchingWork, 5)
      const one = makeMeter(defaults)
      const two = makeMeter(defaults)
      assert.deepStrictEqual(yield* matches(compiled, ["f"], "file", one), yield* matches(compiled, ["f"], "file", two))
      assert.strictEqual(one.work.matchingWork, two.work.matchingWork)
      assert.ok(one.work.matchingWork > 6)
    }))
})
