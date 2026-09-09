# Effect VirtualFileSystem

Run Effect programs against an in-memory filesystem without touching the host disk. Use it for isolated tests, build
previews, or tools that need reproducible filesystem state.

## Quick start

```sh
npm install @effect-vfs/memory effect@4.0.0-rc.112
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
  program.pipe(Effect.provide(MemoryFileSystem.layer))
)

console.log(settings)
```

The program uses Effect's normal `FileSystem` service. Only the provided layer changes, so the same application code
can use a host filesystem in production and an isolated in-memory filesystem in tests.

## Choose a package

- Use [`@effect-vfs/memory`](packages/memory/README.md) when existing Effect code needs a
  `FileSystem.FileSystem` implementation. This is the usual starting point.
- Use [`@effect-vfs/core`](packages/core/README.md) when you need byte-preserving names, explicit callers and
  permissions, shared volumes, fixtures, quotas, watches, or portable snapshots.

The two `@effect-vfs` packages are prepared for public npm releases at version `0.1.0`. They currently target the
exact peer version `effect@4.0.0-rc.112` while Effect 4 remains a release candidate.

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

Reference repositories are optional and excluded from builds. See [.docs/references.md](.docs/references.md).

`@repo/virtual-build` is a private example package that demonstrates Vite build and rebuild flows over virtual files.

## Core development context

Start with the [development context](.docs/context/README.md) for the current scope, researched contracts,
Effect compatibility requirements, open decisions, and implementation evidence plan.
The accepted implementation milestones are complete. See the
[implemented profile and evidence ledger](.docs/context/implemented-profile.md) for operations, limits, tests, and
exclusions.

## License

MIT
