# Effect VirtualFileSystem

An experimental workspace for an Effect-based virtual filesystem and its adapters.

## Packages

- `@effect-vfs/memory` is the first publishable package. It implements Effect's `FileSystem` service with an isolated
  in-memory volume.
- `@effect-vfs/core` is a private standalone backend with an initial directory-only implementation. See its
  [supported operations](packages/core/README.md); files, snapshots, and adapter migration remain future work.

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
The first core directory slice is implemented. Accepted decisions and implementation evidence are distinguished
from proposals for later features.

## Status

`@effect-vfs/memory` begins at experimental version `0.1.0`. Publishing automation will be added after the
`@effect-vfs` npm organization and trusted publishing are configured.

## License

MIT
