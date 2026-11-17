import { Effect, FileSystem } from "effect"

export const manifestPath = "/dist/manifest.json"

export const rebuildManifest = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const stale = "/dist/stale.json"
  const manifest = yield* fs.readFileString("/src/manifest.json")

  if (!(yield* fs.exists(manifestPath)) || (yield* fs.readFileString(manifestPath)) !== manifest) {
    yield* fs.writeFileString(manifestPath, manifest)
  }

  if (yield* fs.exists(stale)) yield* fs.remove(stale)
})
