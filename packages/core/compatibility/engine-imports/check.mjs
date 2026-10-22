// Audit source imports after type erasure; neither core externals nor tree shaking can hide a feature edge.
const root = new URL("../../../../", import.meta.url)

const entries = ["packages/core/src/internal/engine.ts"]

if (process.argv.includes("--adapter")) {
  entries.push("packages/memory/src/internal/fileSystemAdapter.ts", "packages/memory/test/support/minimalFileSystem.ts")
}

// Every retained runtime module has a local purpose and an explicit upstream disposition in
// .okf/architecture/volume-caller-handle-model.md. New dependencies require an ownership review.
const engineModules = new Set([
  "packages/core/src/internal/engine.ts",
  "packages/core/src/internal/bytePath.ts",
  "packages/core/src/internal/bytes.ts",
  "packages/core/src/FileHandle.ts",
  "packages/core/src/Metadata.ts",
  "packages/core/src/VfsError.ts"
])

const transpiler = new Bun.Transpiler({ loader: "ts" })

const forbidden = /(?:core\/src\/internal\/(?:metadata|volumeState|resolution|tokenRegistry|confinement|directoryEntries|path|turnstile|testSeams)\.ts$|snapshot|image|fixture|treeTransfer|overlay|callerWatch|watchHub|hex128|hmac|liveVolume|\/(?:Caller|Volume|Watch|VirtualFileSystem|index)\.ts$)/i

// Follow type imports too: an erased Caller/VirtualFileSystem edge still reverses contract ownership.
const contractPending = [new URL(entries[0], root).href]

const contractSeen = new Set()

while (contractPending.length > 0) {
  const file = contractPending.pop()

  if (contractSeen.has(file)) continue
  const name = file.slice(root.href.length)

  if (!engineModules.has(name)) throw new Error(`Engine contract imports community module: ${name}`)
  contractSeen.add(file)

  const source = (await Bun.file(new URL(file)).text()).replace(/\/\*[\s\S]*?\*\//g, "")
  const imports = /(?:\bimport\s+(?:type\s+)?(?:[^;"']+?\s+from\s+)?|\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+|\bimport\s*\(\s*)["']([^"']+)["']/g

  for (const match of source.matchAll(imports)) {
    const specifier = match[1]

    if (specifier.startsWith("effect/")) continue

    if (!specifier.startsWith(".")) throw new Error(`Unreviewed engine contract dependency: ${specifier} in ${name}`)
    contractPending.push(new URL(specifier.replace(/\.js$/, ".ts"), file).href)
  }
}

process.stdout.write(`Engine contract import audit passed: ${contractSeen.size} workspace modules, including type imports.\n`)


for (const entry of entries) {
  const pending = [new URL(entry, root).href]
  const seen = new Set()

  while (pending.length > 0) {
    const file = pending.pop()

    if (seen.has(file)) continue
    const name = file.slice(root.href.length)

    if (forbidden.test(name)) throw new Error(`Minimal engine imports community feature: ${name}`)

    if (entry === entries[0] && !engineModules.has(name)) {
      throw new Error(`Undocumented engine dependency: ${name}. Review its ownership before extending the allowlist.`)
    }

    seen.add(file)
    const source = await Bun.file(new URL(file)).text()

    for (const dependency of transpiler.scanImports(transpiler.transformSync(source))) {
      const specifier = dependency.path

      if (specifier === "effect/Crypto" || specifier.startsWith("effect/crypto/")) {
        throw new Error(`Minimal construction imports Crypto: ${name}`)
      }

      if (specifier.startsWith("effect/")) continue
      let target

      if (specifier.startsWith("@effect-vfs/")) {
        const [, workspace, ...path] = specifier.split("/")
        target = new URL(`packages/${workspace}/src/${path.join("/") || "index"}.ts`, root)
      } else if (specifier.startsWith(".")) {
        target = new URL(specifier.replace(/\.js$/, ".ts"), file)
        // The test-only adapter bridge consumes built declarations; audit the owning source as well.
        target = new URL(target.href.replace(/\/packages\/([^/]+)\/dist\//, "/packages/$1/src/"))
      } else throw new Error(`Unreviewed external engine dependency: ${specifier} in ${name}`)
      pending.push(target.href)
    }
  }

  process.stdout.write(`Minimal import audit passed: ${entry}, ${seen.size} workspace modules.\n`)
}
