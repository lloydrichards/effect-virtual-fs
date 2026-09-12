# Effect VirtualFileSystem

Run Effect programs against an in-memory filesystem without touching the host disk. Use it for isolated tests, build
previews, or tools that need reproducible filesystem state.

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
- Use [`@effect-vfs/persistence`](packages/persistence/README.md) to save named SQLite checkpoints and restore
  them as fresh volumes in a later process.

The core, memory, and persistence packages are versioned at `0.0.1`. All packages target the
exact peer version `effect@4.0.0-rc.114` while Effect 4 remains a release candidate.

## Explore project knowledge

The [OKF bundle](.okf/index.md) connects the current architecture, behavioral contracts, accepted decisions,
research, and validation guidance. With [Bun](https://bun.sh) installed, start from the project overview and explore
its neighboring concepts interactively:

```sh
npx --yes okf-graph@0.2.0 concept .okf profiles/project-overview --interactive
```

Concept IDs are paths inside `.okf` without the `.md` extension. You can also validate the bundle or inspect a
focused neighborhood directly:

```sh
npx --yes okf-graph@0.2.0 validate .okf
npx --yes okf-graph@0.2.0 graph neighbors .okf contracts/snapshots-and-fixtures
```

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

## Core development context

Start with the [project knowledge overview](.okf/profiles/project-overview.md) for the current system boundary, then
follow its graph links into the implemented profile, focused contracts, accepted decisions, and draft research.

## License

MIT
