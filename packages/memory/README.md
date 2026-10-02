# @effect-vfs/memory

`@effect-vfs/memory` implements Effect's `FileSystem` service over a virtual volume. Provide its layer to run existing
Effect programs with disposable filesystem state, without changing their file operations.

The adapter supports files, directories, links, scoped handles, temporary resources, globbing, and watches. The
underlying state and permissions come from `@effect-vfs/core`.

## Install

```sh
npm install @effect-vfs/memory@latest
npm install "@effect/platform-bun@$(npm view @effect-vfs/memory peerDependencies.effect)"
```

## Replace the host filesystem

Write application code against Effect's `FileSystem` service, then choose the
implementation when you run it. The same program can use a platform filesystem
in production and an isolated in-memory filesystem in tests or tools.

This complete program creates a small build artifact without writing to disk:

```ts
import { MemoryFileSystem } from "@effect-vfs/memory"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Effect, FileSystem } from "effect"

const buildManifest = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem

  yield* fs.makeDirectory("/dist", { recursive: true })
  yield* fs.writeFileString(
    "/dist/manifest.json",
    JSON.stringify({ files: ["index.js", "index.css"] }, null, 2)
  )

  return yield* fs.readFileString("/dist/manifest.json")
})

const manifest = await Effect.runPromise(
  buildManifest.pipe(Effect.provide(MemoryFileSystem.layer), Effect.provide(BunCrypto.layer))
)

console.log(manifest)
// { "files": ["index.js", "index.css"] }
```

`layer` creates a fresh volume containing `/tmp` and requires an Effect `Crypto` service; use `MemoryFileSystem.make` when you
need the service directly.

## Seed a test filesystem

`layerFromFixture` provides a fresh seeded filesystem for each independent layer build:

```ts
import { MemoryFileSystem } from "@effect-vfs/memory"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Effect, FileSystem } from "effect"

const seeded = MemoryFileSystem.layerFromFixture({
  entries: [
    { kind: "directory", path: "/project" },
    {
      kind: "file",
      path: "/project/package.json",
      bytes: new TextEncoder().encode("{\"version\":\"1.2.3\"}")
    }
  ]
})

const readVersion = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return JSON.parse(yield* fs.readFileString("/project/package.json")).version
})

console.log(
  await Effect.runPromise(
    readVersion.pipe(Effect.provide(seeded), Effect.provide(BunCrypto.layer))
  )
) // 1.2.3
```

Declare parent directories explicitly. The constructor adds no entries, including `/tmp`. Include `/tmp` when the
program needs the default temporary directory. For caller identity and volume limits, pass the constructor's options.

## Share an existing volume

`MemoryFileSystem.bind(volume)` constructs the adapter over an existing core volume without changing that volume.
`layerFromVolume(volume)` supplies the same adapter as a layer. Add `@effect-vfs/core` as a direct dependency when
creating volumes yourself. Several adapters bound to one volume see the same files.

## Guides and limits

- [Test with an isolated filesystem](../../apps/docs/app/content/guides/testing-with-an-isolated-filesystem.mdx) covers seeded tests, failures, and watches.
- [API reference](../../apps/docs/app/content/api/memory/memory-file-system.mdx) lists constructors and options.
- [Compatibility and limits](../../apps/docs/app/content/reference/compatibility-and-limits.mdx) describes path, handle, glob, and watch behavior.

The package is experimental. Public APIs may change between minor releases. The adapter does not access host files or
provide crash durability. Permissions and quotas come from the core volume. Watch overflow fails the stream; use
`MemoryFileSystem.isWatchOverflow` to recognize it, open a new watch, and rescan the affected path.

## Credits and license

The memory adapter draws on [Effect #6573](https://github.com/Effect-TS/effect/pull/6573),
[Effect #6555](https://github.com/Effect-TS/effect/pull/6555), and
[effect-smol #456](https://github.com/Effect-TS/effect-smol/pull/456). Licensed under MIT.
