# Effect VirtualFileSystem

Use an in-memory filesystem with Effect. The packages cover the standard `FileSystem` service, direct access to a
shared virtual volume, SQLite persistence, and NFSv4.1 exports.

## Quick start

```sh
npm install @effect-vfs/memory@latest
npm install "@effect/platform-bun@$(npm view @effect-vfs/memory peerDependencies.effect)"
```

```ts
import { MemoryFileSystem } from "@effect-vfs/memory"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Effect, FileSystem } from "effect"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString("/settings.json", JSON.stringify({ mode: "preview" }))
  return yield* fs.readFileString("/settings.json")
})

const settings = await Effect.runPromise(
  program.pipe(Effect.provide(MemoryFileSystem.layer), Effect.provide(BunCrypto.layer))
)

console.log(settings) // {"mode":"preview"}
```

The program uses Effect's `FileSystem` service. `layer` provides a fresh virtual volume and requires an Effect `Crypto` service.

## Choose a package

- Use [`@effect-vfs/memory`](packages/memory/README.md) when existing Effect code needs a
  `FileSystem.FileSystem` implementation. This is the usual starting point.
- Use [`@effect-vfs/core`](packages/core/README.md) when you need byte-preserving names, explicit callers and
  permissions, shared volumes, fixtures, quotas, watches, or portable snapshots.
- Use [`@effect-vfs/persistence`](packages/persistence/README.md) for named SQLite checkpoints or experimental live
  image commits.
- Use [`@effect-vfs/nfs`](packages/nfs/README.md) to expose one live volume through the preview read-only NFSv4.1
  profile or the experimental writable profile with qualified storage. It is not a conformant or production NFS server.

The package declares the exact Effect version it supports as a peer dependency. Check that requirement before
upgrading an existing Effect installation.

For architecture and behavioral contracts, start with the [project knowledge overview](.okf/profiles/project-overview.md).

## Repository development

```sh
bun install
bun run type-check
bun run test
bun run build
```

## Examples and documentation

- [Getting started](apps/docs/app/content/getting-started.mdx) runs a program with the memory adapter.
- [Testing guide](apps/docs/app/content/guides/testing-with-an-isolated-filesystem.mdx) covers isolated and seeded tests.
- [Confine a workspace](apps/docs/app/content/guides/confined-workspaces.mdx) gives a caller access within one directory.
- [Snapshot search](apps/docs/app/content/guides/snapshot-search.mdx) finds filenames and content in captured state.
- [Overlay guide](apps/docs/app/content/guides/overlay-filesystems.mdx) combines independent edits with snapshot deltas.
- [Agent toolkit and MCP demo](apps/demo-agent-tools/README.md) exposes a disposable virtual workspace through MCPJam.
- [Virtual build example](apps/virtual-build/README.md) runs Vite over virtual files.

Reference repositories under `.reference/` are optional and excluded from builds.

## License

MIT
