// Resolve workspace imports to source rather than externalizing core or relying on tree shaking.
const root = new URL("../../../../", import.meta.url)

const pending = [new URL("packages/memory/src/internal/copyOperations.ts", root).href]

const seen = new Set()

const transpiler = new Bun.Transpiler({ loader: "ts" })

const forbidden = /(?:treeTransfer|snapshot|image|fixture|codec)/i

while (pending.length > 0) {
  const file = pending.pop()

  if (seen.has(file)) continue
  const name = file.slice(root.href.length)

  if (forbidden.test(name)) throw new Error(`Copy runtime imports optional feature: ${name}`)
  seen.add(file)
  const source = await Bun.file(new URL(file)).text()

  for (const dependency of transpiler.scanImports(source)) {
    const specifier = dependency.path

    if (specifier.startsWith("effect/")) continue

    if (specifier.startsWith("@effect-vfs/")) {
      const [, workspace, ...path] = specifier.split("/")
      pending.push(new URL(`packages/${workspace}/src/${path.join("/") || "index"}.ts`, root).href)
    } else if (specifier.startsWith(".")) {
      pending.push(new URL(specifier.replace(/\.js$/, ".ts"), file).href)
    } else throw new Error(`Unreviewed external copy dependency: ${specifier} in ${name}`)
  }
}

process.stdout.write(`Copy runtime import audit passed: ${seen.size} workspace modules; no transfer, snapshot, image, fixture or codec modules.\n`)
