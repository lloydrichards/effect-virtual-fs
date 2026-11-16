// This build tool reads a pinned upstream snapshot and writes only this package's generated files.
/* eslint-disable effecttsgo/node-builtin-import */
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, posix, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))

const snapshot = JSON.parse(await readFile(new URL("../upstream/files.json", import.meta.url), "utf8"))

const manifest = JSON.parse(await readFile(new URL("../upstream/manifest.json", import.meta.url), "utf8"))

const check = process.argv.includes("--check")

if (process.argv.some((arg, index) => index > 1 && arg !== "--check")) {
  throw new Error("Usage: bun scripts/sync.mjs [--check]")
}

const hash = (text) => createHash("sha256").update(text).digest("hex")

if (snapshot.commit !== manifest.commit || snapshot.repository !== manifest.repository) {
  throw new Error("Snapshot provenance differs from manifest")
}

const patches = new Map(snapshot.files.map((file) => [file.filename.replace("packages/effect/", ""), file.patch]))

if (patches.size !== snapshot.files.length || patches.size !== Object.keys(manifest.files).length) {
  throw new Error("Snapshot file inventory differs from manifest")
}

for (const [path, patch] of patches) {
  if (hash(patch) !== manifest.files[path]) throw new Error(`Upstream patch checksum mismatch: ${path}`)
}

const sources = new Map([...patches].map(([path, patch]) => [path,
  patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) =>
    line.slice(1)
  ).join("\n") + "\n"
]))

const additions = (path) => sources.get(path)

const generated = new Map()

const banner = "// Generated from Effect PR #9960 by scripts/sync.mjs. Edit the snapshot or generator, then run sync.\n"

const put = (path, text) => generated.set(path, banner + text)

const compat = new Set(["BytePath", "Bytes", "DateTime", "Schema"])

const moduleFor = (name) => compat.has(name) ? `src/compat/${name}.ts` : undefined

const rewrite = (source, destination, original) => {
  // Only module specifiers are rewritten; unrelated string values retain upstream semantics.
  const specifier = (name) => {
    let path

    if (name === "effect/virtual-file-system") path = "src/virtual-file-system/VirtualFileSystem.ts"
    else if (name.startsWith("effect/virtual-file-system/")) path = `src/${name.slice("effect/".length)}.ts`
    else if (name.startsWith("effect/")) path = moduleFor(name.slice(7))
    else if (name.startsWith(".")) {
      const upstream = posix.normalize(posix.join(posix.dirname(original), name))

      if (upstream.startsWith("src/virtual-file-system/")) path = upstream
      else if (upstream.startsWith("src/")) {
        const effectModule = upstream.slice(4).replace(/\.ts$/, "")
        path = moduleFor(effectModule)

        if (!path) return `effect/${effectModule}`
      }
    }

    if (!path) return name
    let local = posix.relative(posix.dirname(destination), path).replace(/\.ts$/, ".js")

    return local.startsWith(".") ? local : `./${local}`
  }

  source = source.replace(
    /\b(from\s+|import\s*\(\s*)(["'])([^"']+)\2/g,
    (_, prefix, quote, name) => `${prefix}${quote}${specifier(name)}${quote}`
  )
  // Split namespace imports from Effect's barrel so every preview value comes from one module copy.
  source = source.replace(/import (type )?\{([^}]+)\} from "effect"/g, (_, type, names) => {
    const rest = []
    const imports = []

    for (const name of names.split(",").map((name) => name.trim())) {
      const match = /^(type )?(BytePath|Bytes|DateTime|Schema)$/.exec(name)

      if (match) {
        imports.push(`import ${type || match[1] || ""}* as ${match[2]} from "${specifier(`effect/${match[2]}`)}"`)
      } else rest.push(name)
    }

    if (rest.length) imports.push(`import ${type || ""}{ ${rest.join(", ")} } from "effect"`)

    return imports.join("\n")
  })

  return source
}

for (const [path, patch] of patches) {
  if (!patch.startsWith("@@ -0,0")) continue
  const destination = path === "src/BytePath.ts" ? "src/compat/BytePath.ts" : path
  put(destination, rewrite(additions(path), destination, path))
}

// Only the core snapshot adapter owns immutable image records suitable for this handoff.
put("src/internal/ownedCapture.ts", 'export { unsafeFromOwnedRecords } from "../virtual-file-system/internal/capture.js"\n')

put("src/internal/durableStorage.ts",
  'export { installStorage, resumeAllocator } from "../virtual-file-system/internal/engine.js"\n' +
  'export { cleanupError } from "../virtual-file-system/internal/handles.js"\n')

put(
  "src/index.ts",
  "export * as VirtualFileSystem from \"./virtual-file-system/VirtualFileSystem.js\"\nexport * as BytePath from \"./compat/BytePath.js\"\n"
)

put(
  "src/compat/Bytes.ts",
  "export * from \"effect/Bytes\"\n" +
    rewrite(additions("src/Bytes.ts").replace(/^.*\n/, ""), "src/compat/Bytes.ts", "src/Bytes.ts")
)

const dateTime = additions("src/DateTime.ts")

put(
  "src/compat/DateTime.ts",
  "export * from \"effect/DateTime\"\nimport * as Internal from \"effect/DateTime\"\nimport type { DateTime, Utc } from \"effect/DateTime\"\n" +
    rewrite(dateTime, "src/compat/DateTime.ts", "src/DateTime.ts")
)

const schemaImports = `export * from "effect/Schema"
import * as BytePath_ from "./BytePath.js"
import * as DateTime from "./DateTime.js"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Result_ from "effect/Result"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { declare, link, Uint8Array, decodeTo, BigInt, brand, Struct, Literals, TaggedStruct, instanceOf } from "effect/Schema"
`

// Generated consumers bind Schema to stock Effect and can define their own type and value named BytePath.
const portBytePathCode = (source) => source
  .replace('`Schema.BytePath', '`bytePathSchema')
  .replace(/(["`])BytePath\.BytePath\1/g, "$1import('@effect-vfs/effect-preview/BytePath').BytePath$1")
  .replace('import * as BytePath from "effect/BytePath"', 'import { BytePath as bytePathSchema } from "@effect-vfs/effect-preview/Schema"')

put(
  "src/compat/Schema.ts",
  schemaImports + portBytePathCode(additions("src/Schema.ts").replace("import * as BytePath_ from \"./BytePath.ts\"\n", ""))
)

// Bytes predates the PR. Its added cases use the existing fixture helper and describe block.
const byteTests = additions("test/Bytes.test.ts")

const firstTest = byteTests.indexOf("  it(")

put(
  "test/Bytes.test.ts",
  rewrite(
    byteTests.slice(0, firstTest) +
      "\nconst b = (...bytes: Array<number>) => new Uint8Array(bytes)\ndescribe(\"Bytes.byteLength\", () => {\n" +
      byteTests.slice(firstTest) + "})\n",
    "test/Bytes.test.ts",
    "test/Bytes.test.ts"
  )
)

const representationPath = "test/schema/representation/toCodeDocument.test.ts"

const representationHelpers = `import { assert, describe, it } from "@effect/vitest"
import * as Schema from "../../../src/compat/Schema.js"
import * as SchemaRepresentation from "effect/SchemaRepresentation"
const makeCode = SchemaRepresentation.makeCode
type Expected = {
  readonly codes: SchemaRepresentation.Code
  readonly references?: { readonly nonRecursives: ReadonlyArray<{ readonly $ref: string; readonly code: SchemaRepresentation.Code }> }
  readonly artifacts?: ReadonlyArray<SchemaRepresentation.Artifact>
}
function canonicalizeGeneratedCode(input: unknown): unknown {
  if (typeof input === "string") return input.replaceAll(/"expected": "(?:\\\\.|[^"\\\\])*"(?:, )?/g, "").replaceAll(", }", " }").replaceAll(".annotate({  })", "")
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
`

put(representationPath, representationHelpers + portBytePathCode(additions(representationPath)))

// The upstream identity probes spawn another runtime and copy source. Use the built port so both
// Bun and Node can load its .js imports, preserving the duplicate-copy/reload assertions.
const testPath = "test/virtual-file-system/VirtualFileSystem.test.ts"

let probes = generated.get(testPath)

probes = probes.replace(
  "new URL(\"../../src/virtual-file-system/VirtualFileSystem.ts\", import.meta.url).href",
  "new URL(\"../../dist/virtual-file-system/VirtualFileSystem.js\", import.meta.url).href"
)

probes = probes.replace(
  "new URL(\"../../src/\", import.meta.url).href",
  "new URL(\"../../dist/\", import.meta.url).href"
)

probes = probes.replace(
  "new URL(\"../../src/Effect.ts\", import.meta.url).href",
  "import.meta.resolve(\"effect/Effect\")"
)

probes = probes.replace(
  "join(directory, \"src/virtual-file-system/VirtualFileSystem.ts\")",
  "join(directory, \"src/virtual-file-system/VirtualFileSystem.js\")"
)

probes = probes.replace(
  "const CopyEffect = await import(pathToFileURL(join(directory, \"src/Effect.ts\")).href)",
  "const CopyEffect = Effect"
)

generated.set(testPath, probes)

const expected = new Set(generated.keys())

for (const directory of ["src", "test", "typetest"]) {
  let files = []

  try {
    files = await readdir(resolve(root, directory), { recursive: true, withFileTypes: true })
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }

  for (const file of files) {
    if (file.isFile()) {
      const path = relative(root, resolve(file.parentPath, file.name))

      if (!expected.has(path)) throw new Error(`Unexpected file in generated directory: ${path}`)
    }
  }
}

for (const [path, source] of generated) {
  const target = resolve(root, path)

  if (check) {
    if (await readFile(target, "utf8").catch(() => undefined) !== source) {
      throw new Error(`Generated file differs: ${path}. Run bun run sync.`)
    }
  } else {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, source)
  }
}

process.stdout.write(`${check ? "Verified" : "Generated"} ${generated.size} files from ${snapshot.commit}\n`)
