// The existing constructors and native binding must reach the same preview engine.
const source = new URL("../../src/", import.meta.url)

const files = new Map()

for await (const path of new Bun.Glob("**/*.ts").scan(source.pathname)) {
  const url = new URL(path, source)
  files.set(url.href, await Bun.file(url).text())
}

const removed = ["engine.ts", "adapterBinding.ts", "callerWatch.ts", "watchHub.ts", "previewRuntime.ts", "previewSync.ts"]

for (const path of removed) {
  if (files.has(new URL(`internal/${path}`, source).href)) throw new Error(`Removed implementation returned: ${path}`)
}

const dependencies = (url) => {
  const raw = files.get(url)

  if (raw === undefined) throw new Error(`Missing core module: ${url}`)
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, "")

  if (/\bmake(?:CommunityVolume|CommunityOverlay|Engine)\b/.test(text)) throw new Error(`Legacy runtime in ${url}`)

  return [...text.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map((match) => match[1] ?? match[2])
}

for (const entry of ["VirtualFileSystem.ts", "SynchronousAdapter.ts"]) {
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
      else if (specifier !== "effect" && !specifier.startsWith("effect/")) throw new Error(`Unexpected core runtime dependency: ${specifier}`)
    }
  }

  if (!preview) throw new Error(`${entry} does not consume the preview`)
}

// Check every source, including modules not reached from the constructors.
for (const url of files.keys()) dependencies(url)

process.stdout.write(`Sole-preview import audit passed for ${files.size} core modules.\n`)
