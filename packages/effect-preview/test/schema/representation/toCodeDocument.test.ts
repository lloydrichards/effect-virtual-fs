// Generated from Effect PR #9960 by scripts/sync.mjs. Edit the snapshot or generator, then run sync.
import { assert, describe, it } from "@effect/vitest"
import { Codegen, SchemaRepresentation } from "effect"
import * as Schema from "../../../src/compat/Schema.js"

const emitSchema = (name: string, schema: Schema.Constraint) => {
  const document = SchemaRepresentation.toRepresentation(schema.ast)
  const module = new Codegen.Module()
  module.addSchemas({ [name]: document.representation }, { references: document.references })

  return module.print()
}

describe("BytePath schema code generation", () => {
  it("should emit opaque path schemas when generating BytePath values", () => {
    for (
      const [schema, name] of [
        [Schema.BytePath, "BytePath"],
        [Schema.toType(Schema.BytePathFromBytes), "BytePathFromBytes"]
      ] as const
    ) {
      const source = emitSchema(name, schema)
      assert.include(source, 'import { BytePath as bytePathSchema } from "@effect-vfs/effect-preview/Schema"')
      assert.include(source, 'import type * as BytePathType from "@effect-vfs/effect-preview/BytePath"')
      assert.include(source, `export type ${name} = BytePathType.BytePath`)
      assert.include(source, `export const ${name} = bytePathSchema.annotate(`)
    }
  })

  it("should emit a byte-array schema when generating the encoded side of BytePathFromBytes", () => {
    const source = emitSchema("BytePathFromBytesEncoded", Schema.BytePathFromBytes)
    assert.include(source, "export type BytePathFromBytesEncoded = globalThis.Uint8Array")
    assert.include(source, "export const BytePathFromBytesEncoded = Schema.Uint8Array.annotate(")
    assert.include(source, '"~identifier": "BytePathFromBytes"')
  })
})
