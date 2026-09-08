# Effect VirtualFileSystem

An experimental workspace for an Effect-based virtual filesystem and its adapters.

## Packages

- `@effect-vfs/core` is the private backend: files, byte-preserving namespace operations, permissions, scoped handles,
  logical quotas, fixtures, isolated snapshots and strict encoding/restoration.
- `@effect-vfs/memory` binds Effect's `FileSystem` service to core, with fresh or shared volumes.
- `@repo/virtual-build` demonstrates Vite build/rebuild and bounded package imports from virtual files.

## Development

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

Reference repositories are optional and excluded from builds. See [.docs/references.md](.docs/references.md).

## Core development context

Start with the [development context](.docs/context/README.md) for the current scope, researched contracts,
Effect compatibility requirements, open decisions, and implementation evidence plan.
The accepted private implementation milestones are complete. See the [implemented profile and evidence ledger](.docs/context/implemented-profile.md)
for operations, limits, tests, and exclusions. Both library packages remain private; no publication is configured by this work.

## License

MIT
