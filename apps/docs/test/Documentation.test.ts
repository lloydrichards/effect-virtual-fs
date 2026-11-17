import { describe, expect, it } from "bun:test"
import { checkPublicSource } from "../scripts/check-public-docs"
import { collectPublicExamples, expectedExampleOutput } from "../scripts/public-examples"

const documented = (declaration: string): string =>
  `/**
 * Builds a resource for the caller.
 * @since 0.1.0
 * @category constructors
 */
${declaration}`

describe("public documentation contracts", () => {
  it("should accept declarations when their documentation and public owner are explicit", () => {
    expect(
      checkPublicSource(
        `${documented("export const make = () => 1")}\nexport { other } from './other.js'`,
        "api.ts",
        new Set(["api.ts", "other.ts"])
      )
    )
      .toEqual([])
  })

  it("should require documentation when a declaration is public", () => {
    const failures = checkPublicSource("const privateValue = 1; export const publicValue = privateValue", "api.ts")
    expect(failures).toHaveLength(3)
    expect(failures.some((failure) => failure.includes("description"))).toBe(true)
    expect(failures.some((failure) => failure.includes("@since"))).toBe(true)
    expect(failures.some((failure) => failure.includes("@category"))).toBe(true)
  })

  it("should require descriptions when declarations already have metadata", () => {
    const text = "/** @since 0.1.0\n * @category models\n */\nexport interface Options {}"
    expect(checkPublicSource(text, "api.ts")).toEqual(["api.ts:4: public declaration needs a description"])
  })

  it("should reject metadata when versions or categories are invalid", () => {
    const text = documented("export type Options = string").replace("0.1.0", "next").replace("constructors", "")
    const failures = checkPublicSource(text, "api.ts")
    expect(failures.some((failure) => failure.includes("stable major.minor.patch"))).toBe(true)
    expect(failures.some((failure) => failure.includes("@category"))).toBe(true)
  })

  it("should reject local links when their target is private", () => {
    const text = documented("export const make = () => 1").replace("Builds a resource", "See {@link hidden}")
      + "\nconst hidden = 1"

    expect(checkPublicSource(text, "api.ts").some((failure) => failure.includes("link hidden"))).toBe(true)
    expect(checkPublicSource(text.replace("{@link hidden}", "{@link make}"), "api.ts")).toEqual([])
  })

  it("should validate stability when a declaration supplies a label", () => {
    expect(checkPublicSource(documented("export const make = () => 1"), "api.ts")).toEqual([])
    const text = documented("export const make = () => 1").replace("@since", "@stability preview\n * @since")
    expect(checkPublicSource(text, "api.ts").some((failure) => failure.includes("@stability"))).toBe(true)
    expect(checkPublicSource(text.replace("preview", "experimental"), "api.ts")).toEqual([])
  })

  it("should accept inherited metadata when members belong to a documented declaration", () => {
    const text = "/** @internal */\nexport const hidden = 1\n"
      + documented("export interface Options { readonly key: string }")

    expect(checkPublicSource(text, "api.ts")).toEqual([])
  })
})

describe("public examples", () => {
  it("should collect examples when class comments use TypeScript fences and CRLF lines", () => {
    const source =
      "/**\r\n * @example\r\n * ```typescript\r\n * const n = 1\r\n * ```\r\n */\r\nexport class Example {}"

    expect(collectPublicExamples(source, "api.ts")).toEqual([{ body: "const n = 1", line: 2 }])
  })

  it("should reject examples when their code fence cannot be checked", () => {
    expect(() => collectPublicExamples("/** @example No executable block. */\nexport const value = 1", "api.ts"))
      .toThrow("@example needs a fenced TypeScript block")
  })
})

describe("example package names", () => {
  it("should preserve package names when examples contain JSDoc-like tags", () => {
    const source =
      "/**\n * @example\n * ```ts\n * // from @effect/sql-sqlite-bun\n * const value = 1\n * ```\n * @since 0.1.0\n */\nexport const value = 1"

    expect(collectPublicExamples(source, "api.ts")).toEqual([
      { body: "// from @effect/sql-sqlite-bun\nconst value = 1", line: 2 }
    ])
  })
})

describe("public export ownership", () => {
  it("should require documentation when a local declaration is exported under an alias", () => {
    expect(checkPublicSource("const value = 1; export { value as publicValue }", "api.ts"))
      .toHaveLength(3)
    expect(checkPublicSource(documented("const value = 1; export { value as publicValue }"), "api.ts"))
      .toEqual([])
  })

  it("should require documentation when public declarations are enums or namespaces", () => {
    expect(checkPublicSource("export enum Value { A }", "api.ts")).toHaveLength(3)
    expect(checkPublicSource("export namespace Value { export const child = 1 }", "api.ts")).toHaveLength(3)
  })

  it("should reject reexports when their defining module is not public", () => {
    expect(
      checkPublicSource("export { hidden } from './internal/hidden.js'", "api.ts").some((failure) =>
        failure.includes("public defining module")
      )
    ).toBe(true)
  })

  it("should reject direct declarations when a module is a root barrel", () => {
    expect(
      checkPublicSource(documented("export const value = 1"), "index.ts").some((failure) =>
        failure.includes("reexports only")
      )
    ).toBe(true)
  })
})

describe("example output assertions", () => {
  it("should preserve output assertions when examples end in blank lines", () => {
    expect(expectedExampleOutput("program.then(console.log)\n// expected\n  \n", "api.ts:1")).toBe("expected")
  })

  it("should reject output examples when their expected comment is missing", () => {
    expect(() => expectedExampleOutput("program.then(console.log)", "api.ts:1"))
      .toThrow("api.ts:1: output-producing example needs a trailing // expected output comment")
    expect(expectedExampleOutput("const program = 1", "api.ts:1")).toBeUndefined()
  })
})

describe("exported link names", () => {
  it("should resolve links through aliases when the original name is private", () => {
    const text = documented("const localValue = 1; export { localValue as publicValue }")
      .replace("Builds a resource for the caller.", "See {@link localValue}.")

    expect(checkPublicSource(text, "api.ts").some((failure) => failure.includes("link localValue"))).toBe(true)
    expect(checkPublicSource(text.replace("{@link localValue}", "{@link publicValue}"), "api.ts")).toEqual([])
  })
})
