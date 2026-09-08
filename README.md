# Effect VirtualFileSystem

An experimental workspace for an Effect-based virtual filesystem and its adapters.

## Packages

- `@effect-vfs/memory` is the first publishable package. It implements Effect's `FileSystem` service with an isolated
  in-memory volume.
- `@effect-vfs/core` is a private placeholder for the future standalone backend. It will remain unpublished until its
  interface and supported POSIX profile are defined and tested.

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

## Status

`@effect-vfs/memory` begins at experimental version `0.1.0`. Publishing automation will be added after the
`@effect-vfs` npm organization and trusted publishing are configured.

## License

MIT
