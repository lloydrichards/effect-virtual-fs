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

const sources = new Map(
  [...patches].map(([path, patch]) => [
    path,
    patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1))
      .join("\n") + "\n"
  ])
)

const additions = (path) => {
  const source = sources.get(path)

  if (source === undefined) throw new Error(`Required snapshot file is missing: ${path}`)

  return source
}

const replaceRequired = (source, anchor, replacement, adaptation) => {
  const count = anchor instanceof RegExp ? [...source.matchAll(anchor)].length : source.split(anchor).length - 1

  if (count !== 1) throw new Error(`${adaptation}: expected 1 anchor match, found ${count}`)

  return source.replaceAll(anchor, replacement)
}

const generated = new Map()

const banner = "// Generated from Effect PR #9960 by scripts/sync.mjs. Edit the snapshot or generator, then run sync.\n"

const put = (path, text) => generated.set(path, banner + text)

const compat = new Set(["BytePath", "Bytes", "DateTime", "Schema"])

const moduleFor = (name) => compat.has(name) ? `src/compat/${name}.ts` : undefined

const rewrite = (source, destination, original) => {
  // These import rewrites apply only to files that use the corresponding specifiers.
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

const handlesPath = "src/virtual-file-system/internal/handles.ts"

const handleAnchor = "const synchronous = new WeakMap<E.FileState, M.SyncFileHandle>()"

const handles = generated.get(handlesPath)

if (handles.split(handleAnchor).length !== 2) throw new Error("Expected one preview handle-release anchor")

generated.set(
  handlesPath,
  handles.replace(
    handleAnchor,
    `// The core compatibility indexes retire alongside engine pins.
export const onHandleRelease = (handle: M.FileHandle | M.DirectoryHandle, release: (id: bigint) => void) => {
  const state = states.get(handle) ?? E.directoryHandleState(handle)
  if (state === undefined) return undefined
  const registered = state.resource.releaseWithResult(() => release(state.id))
  return Result.isSuccess(registered) ? state.id : undefined
}
${handleAnchor}`
  )
)

// Only the core snapshot adapter owns immutable image records suitable for this handoff.
put(
  "src/internal/ownedCapture.ts",
  "export { unsafeFromOwnedRecords } from \"../virtual-file-system/internal/capture.js\"\n"
)

put(
  "src/internal/durableStorage.ts",
  "export { installStorage, resumeAllocator } from \"../virtual-file-system/internal/engine.js\"\n" +
    "export { cleanupError, onHandleRelease } from \"../virtual-file-system/internal/handles.js\"\n"
)

put(
  "src/index.ts",
  "export * as VirtualFileSystem from \"./virtual-file-system/VirtualFileSystem.js\"\nexport * as BytePath from \"./compat/BytePath.js\"\n"
)

const bytes = replaceRequired(
  additions("src/Bytes.ts"),
  /^ \* Inspects, joins and compares byte sequences stored in `Uint8Array` values\.\n/gm,
  "",
  "src/Bytes.ts (remove the partial upstream module comment)"
)

put("src/compat/Bytes.ts", "export * from \"effect/Bytes\"\n" + rewrite(bytes, "src/compat/Bytes.ts", "src/Bytes.ts"))

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
const portBytePathCode = (path, source) => {
  source = replaceRequired(source, "`Schema.BytePath", "`bytePathSchema", `${path} (rename the runtime schema)`)
  source = replaceRequired(
    source,
    /(["`])BytePath\.BytePath\1/g,
    "$1BytePathType.BytePath$1",
    `${path} (qualify the generated BytePath type)`
  )

  return replaceRequired(
    source,
    "import * as BytePath from \"effect/BytePath\"",
    "import { BytePath as bytePathSchema } from \"@effect-vfs/effect-preview/Schema\"`,"
      + " `import type * as BytePathType from \"@effect-vfs/effect-preview/BytePath\"",
    `${path} (import the preview schema in generated code)`
  )
}

const schema = replaceRequired(
  additions("src/Schema.ts"),
  "import * as BytePath_ from \"./BytePath.ts\"\n",
  "",
  "src/Schema.ts (remove the upstream BytePath import)"
)

put("src/compat/Schema.ts", schemaImports + portBytePathCode("src/Schema.ts", schema))

// Bytes predates the PR. Its added cases use the existing fixture helper and describe block.
const byteTests = additions("test/Bytes.test.ts")

const firstTest = byteTests.indexOf("  it(")

if (firstTest === -1) throw new Error("test/Bytes.test.ts (wrap the added test cases): missing the first test")

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

// The pinned Effect build renders modules instead of exposing a code document and its artifacts.
put(
  representationPath,
  `import { assert, describe, it } from "@effect/vitest"
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
      assert.include(source, \`export type \${name} = BytePathType.BytePath\`)
      assert.include(source, \`export const \${name} = bytePathSchema.annotate(\`)
    }
  })

  it("should emit a byte-array schema when generating the encoded side of BytePathFromBytes", () => {
    const source = emitSchema("BytePathFromBytesEncoded", Schema.BytePathFromBytes)
    assert.include(source, "export type BytePathFromBytesEncoded = globalThis.Uint8Array")
    assert.include(source, "export const BytePathFromBytesEncoded = Schema.Uint8Array.annotate(")
    assert.include(source, '"~identifier": "BytePathFromBytes"')
  })
})
`
)

// The upstream identity probes spawn another runtime and copy source. Use the built port so both
// Bun and Node can load its .js imports, preserving the duplicate-copy/reload assertions.
const testPath = "test/virtual-file-system/VirtualFileSystem.test.ts"

let probes = generated.get(testPath)

if (probes === undefined) throw new Error(`${testPath} (adapt the identity probes): expected a new snapshot file`)

const adaptProbe = (adaptation, anchor, replacement) => {
  probes = replaceRequired(probes, anchor, replacement, `${testPath} (${adaptation})`)
}

// Regular output files avoid runtimes dropping piped child output. The probe still
// runs the requested runtime and validates the JSON returned by the copied engine.
adaptProbe(
  "use spawn for the identity probe",
  "import { execFile } from \"node:child_process\"",
  "import { spawn } from \"node:child_process\""
)

adaptProbe(
  "import helpers for temporary output files",
  "import { promisify } from \"node:util\"",
  `import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"`
)

adaptProbe(
  "capture child output in temporary files",
  "const execute = promisify(execFile)",
  `const execute = async (command: string, args: Array<string>, options: { readonly maxBuffer: number }) => {
  const directory = mkdtempSync(join(tmpdir(), "effect-vfs-probe-"))
  const output = join(directory, "stdout")
  const errors = join(directory, "stderr")
  const stdout = openSync(output, "w")
  const stderr = openSync(errors, "w")
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", stdout, stderr] })
      child.once("error", reject)
      child.once("close", (code) => {
        if (code === 0) resolve()
        else reject(new Error(readFileSync(errors, "utf8") || "Identity probe exited with code " + code))
      })
    })
    const text = readFileSync(output, "utf8")
    if (new TextEncoder().encode(text).length > options.maxBuffer) throw new Error("Identity probe output exceeds maxBuffer")
    return { stdout: text }
  } finally {
    closeSync(stdout)
    closeSync(stderr)
    rmSync(directory, { recursive: true, force: true })
  }
}`
)

// Resolve the dependency itself so copied engines use the same Effect in either linker layout.
adaptProbe(
  "resolve the installed Effect package",
  "const nodeModulesUrl = new URL(\"../../../../node_modules/\", import.meta.url).href",
  "const effectPackageUrl = new URL(\"./\", import.meta.resolve(\"effect/package.json\")).href"
)

adaptProbe(
  "import mkdirSync in the copied engine probe",
  "import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from \"node:fs\"",
  "import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from \"node:fs\""
)

adaptProbe(
  "link the installed Effect package into the temporary copy",
  "symlinkSync(fileURLToPath(${JSON.stringify(nodeModulesUrl)}), join(directory, \"node_modules\"), \"dir\")",
  "mkdirSync(join(directory, \"node_modules\"))\nsymlinkSync(fileURLToPath(${JSON.stringify(effectPackageUrl)}), join(directory, \"node_modules/effect\"), \"dir\")"
)

adaptProbe(
  "load the built public VFS module",
  "new URL(\"../../src/virtual-file-system/VirtualFileSystem.ts\", import.meta.url).href",
  "new URL(\"../../dist/virtual-file-system/VirtualFileSystem.js\", import.meta.url).href"
)

adaptProbe(
  "copy the built engine directory",
  "new URL(\"../../src/\", import.meta.url).href",
  "new URL(\"../../dist/\", import.meta.url).href"
)

adaptProbe(
  "resolve the installed Effect module",
  "new URL(\"../../src/Effect.ts\", import.meta.url).href",
  "import.meta.resolve(\"effect/Effect\")"
)

adaptProbe(
  "load the copied JavaScript module",
  "join(directory, \"src/virtual-file-system/VirtualFileSystem.ts\")",
  "join(directory, \"src/virtual-file-system/VirtualFileSystem.js\")"
)

adaptProbe(
  "use the installed Effect module with the copied engine",
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
