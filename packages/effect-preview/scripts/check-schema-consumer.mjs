// Compile the emitted imports, reference definitions and root expression as a package consumer.
/* eslint-disable effecttsgo/node-builtin-import */
import * as BytePath from "@effect-vfs/effect-preview/BytePath"
import * as PreviewSchema from "@effect-vfs/effect-preview/Schema"
import { Result, Schema, SchemaRepresentation } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const input = Schema.Struct({ path: PreviewSchema.BytePath, label: Schema.String })

const document = SchemaRepresentation.toCodeDocument(SchemaRepresentation.toRepresentations([input.ast]))

const source = [
  "import * as Schema from \"effect/Schema\"",
  ...document.artifacts.map((artifact) => {
    assert.equal(artifact._tag, "Import")

    return artifact.importDeclaration
  }),
  ...document.references.nonRecursives.map(({ $ref, code }) =>
    `type ${$ref} = ${code.Type}\nconst ${$ref} = ${code.runtime}`
  ),
  `export type Entry = ${document.codes[0].Type}`,
  `export const Entry = ${document.codes[0].runtime}`
].join("\n")

const temporary = await mkdtemp(fileURLToPath(new URL("../.schema-consumer-", import.meta.url)))

try {
  const consumer = join(temporary, "consumer.mts")
  await writeFile(consumer, source)
  execFileSync(process.execPath, [
    fileURLToPath(import.meta.resolve("typescript-js/bin/tsc")),
    "--strict",
    "--module",
    "NodeNext",
    "--target",
    "ES2024",
    "--skipLibCheck",
    "--noEmitOnError",
    consumer
  ], { stdio: "inherit" })
  const { Entry } = await import(pathToFileURL(join(temporary, "consumer.mjs")).href)
  const path = Result.getOrThrow(BytePath.fromBytes(Uint8Array.of(47, 255)))
  const codec = Schema.toCodecJson(Entry)
  const encoded = Result.getOrThrow(Schema.encodeResult(codec)({ path, label: "fixture" }))
  assert.deepEqual(encoded, { path: "L/8=", label: "fixture" })
  const decoded = Result.getOrThrow(Schema.decodeResult(codec)(encoded))
  assert.deepEqual(BytePath.toBytes(decoded.path), Uint8Array.of(47, 255))
  assert.equal(decoded.label, "fixture")
} finally {
  await rm(temporary, { recursive: true, force: true })
}
