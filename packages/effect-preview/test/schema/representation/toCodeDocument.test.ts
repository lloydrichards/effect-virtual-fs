// Generated from Effect PR #9960 by scripts/sync.mjs. Edit the snapshot or generator, then run sync.
import { assert, describe, it } from "@effect/vitest"
import * as Schema from "../../../src/compat/Schema.js"
import * as SchemaRepresentation from "effect/SchemaRepresentation"
const makeCode = SchemaRepresentation.makeCode
type Expected = {
  readonly codes: SchemaRepresentation.Code
  readonly references?: { readonly nonRecursives: ReadonlyArray<{ readonly $ref: string; readonly code: SchemaRepresentation.Code }> }
  readonly artifacts?: ReadonlyArray<SchemaRepresentation.Artifact>
}
function canonicalizeGeneratedCode(input: unknown): unknown {
  if (typeof input === "string") return input.replaceAll(/"expected": "(?:\\.|[^"\\])*"(?:, )?/g, "").replaceAll(", }", " }").replaceAll(".annotate({  })", "")
  if (Array.isArray(input)) return input.map(canonicalizeGeneratedCode)
  if (typeof input !== "object" || input === null) return input
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, canonicalizeGeneratedCode(value)]))
}
function assertSchema(input: { readonly schema: Schema.Constraint }, expected: Expected) {
  const actual = SchemaRepresentation.toCodeDocument(SchemaRepresentation.toRepresentations([input.schema.ast]))
  assert.deepStrictEqual(canonicalizeGeneratedCode(actual), canonicalizeGeneratedCode({
    codes: [expected.codes],
    references: { nonRecursives: expected.references?.nonRecursives ?? [], recursives: {} },
    artifacts: expected.artifacts ?? []
  }))
}
    it("should emit opaque path schemas when generating BytePath values", () => {
      for (
        const [schema, identifier] of [
          [Schema.BytePath, "BytePath"],
          [Schema.toType(Schema.BytePathFromBytes), "BytePathFromBytes"]
        ] as const
      ) {
        assertSchema({ schema }, {
          codes: makeCode(identifier, identifier),
          references: {
            nonRecursives: [{
              $ref: identifier,
              code: makeCode(`bytePathSchema.annotate({ "identifier": "${identifier}" })`, "import('@effect-vfs/effect-preview/BytePath').BytePath")
            }]
          },
          artifacts: [{
            _tag: "Import",
            importDeclaration: `import { BytePath as bytePathSchema } from "@effect-vfs/effect-preview/Schema"`
          }]
        })
      }
    })

    it("should emit a byte-array schema when generating the encoded side of BytePathFromBytes", () => {
      assertSchema({ schema: Schema.BytePathFromBytes }, {
        codes: makeCode("BytePathFromBytesEncoded", "BytePathFromBytesEncoded"),
        references: {
          nonRecursives: [{
            $ref: "BytePathFromBytesEncoded",
            code: makeCode(
              `Schema.Uint8Array.annotate({ "~identifier": "BytePathFromBytes" })`,
              "globalThis.Uint8Array"
            )
          }]
        }
      })
    })

