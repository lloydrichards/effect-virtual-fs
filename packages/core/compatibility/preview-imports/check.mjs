// The existing constructors and native binding must reach the same preview engine.
const source = new URL("../../src/", import.meta.url)

const files = new Map()

for await (const path of new Bun.Glob("**/*.ts").scan(source.pathname)) {
  const url = new URL(path, source)
  files.set(url.href, await Bun.file(url).text())
}

const dependencies = (url) => {
  const raw = files.get(url)

  if (raw === undefined) throw new Error(`Missing core module: ${url}`)
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, "")

  return [...text.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map((match) =>
    match[1] ?? match[2]
  )
}

for (const entry of ["VirtualFileSystem.ts", "LiveVolume.ts", "SynchronousAdapter.ts"]) {
  const pending = [new URL(entry, source).href]
  const seen = new Set()
  let preview = false

  while (pending.length > 0) {
    const url = pending.pop()

    if (seen.has(url)) continue
    seen.add(url)

    for (const specifier of dependencies(url)) {
      if (specifier.startsWith("@effect-vfs/effect-preview")) preview = true
      else if (specifier.startsWith(".")) pending.push(new URL(specifier.replace(/\.js$/, ".ts"), url).href)
      else if (specifier !== "effect" && !specifier.startsWith("effect/")) {
        throw new Error(`Unexpected core runtime dependency: ${specifier}`)
      }
    }
  }

  if (!preview) throw new Error(`${entry} does not consume the preview`)
}

process.stdout.write(`Preview import audit passed for the core constructors and native binding.\n`)
