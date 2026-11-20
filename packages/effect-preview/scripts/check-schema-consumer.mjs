// Compile the emitted imports, reference definitions and root expression as a package consumer.
/* eslint-disable effecttsgo/node-builtin-import */
import * as BytePath from "@effect-vfs/effect-preview/BytePath"
import * as PreviewSchema from "@effect-vfs/effect-preview/Schema"
import { Codegen, Result, Schema, SchemaRepresentation } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const input = Schema.Struct({ path: PreviewSchema.BytePath, label: Schema.String })

const document = SchemaRepresentation.toRepresentation(input.ast)

// oxlint-disable-next-line effecttsgo/experimental-api-usage -- This check qualifies the pinned preview generator.
const module = new Codegen.Module()

module.addSchemas({ Entry: document.representation }, { references: document.references })

const temporary = await mkdtemp(fileURLToPath(new URL("../.schema-consumer-", import.meta.url)))

try {
  const consumer = join(temporary, "consumer.mts")
  await writeFile(consumer, module.print())
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
