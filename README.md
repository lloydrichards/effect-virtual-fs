# Effect VirtualFileSystem

Use an in-memory filesystem with Effect. The packages cover the standard `FileSystem` service, direct access to a
shared virtual volume, SQLite persistence, and a read-only NFSv4.1 export.

## Quick start

```sh
npm install @effect-vfs/memory effect@4.0.0-rc.114
```

```ts
import { MemoryFileSystem } from "@effect-vfs/memory"
import { Effect, FileSystem } from "effect"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString("/settings.json", JSON.stringify({ mode: "preview" }))
  return yield* fs.readFileString("/settings.json")
})

const settings = await Effect.runPromise(
  program.pipe(Effect.provide(MemoryFileSystem.layerCrypto))
)

console.log(settings) // {"mode":"preview"}
```

The program uses Effect's `FileSystem` service. `layerCrypto` provides a fresh virtual volume and the `Crypto` service
it needs. Use `MemoryFileSystem.layer` when your application already provides `Crypto`.

## Choose a package

- Use [`@effect-vfs/memory`](packages/memory/README.md) when existing Effect code needs a
  `FileSystem.FileSystem` implementation. This is the usual starting point.
- Use [`@effect-vfs/core`](packages/core/README.md) when you need byte-preserving names, explicit callers and
  permissions, shared volumes, fixtures, quotas, watches, or portable snapshots.
- Use [`@effect-vfs/persistence`](packages/persistence/README.md) for named SQLite checkpoints or experimental live
  image commits.
- Use [`@effect-vfs/nfs`](packages/nfs/README.md) to expose one live volume through the preview read-only NFSv4.1
  profile. It is not a conformant or production NFS server.

Check each package's peer dependencies before upgrading Effect 4. The packages currently target
`effect@4.0.0-rc.114` exactly.

For architecture and behavioral contracts, start with the [project knowledge overview](.okf/profiles/project-overview.md).

## Repository development

```sh
bun install
bun run type-check
bun run test
bun run build
```

Run the private scratchpad with:

```sh
bun run --filter @repo/scratchpad dev
```

Reference repositories under `.reference/` are optional and excluded from builds.

`@repo/virtual-build` is a private example package that demonstrates Vite build and rebuild flows over virtual files.

## License

MIT
