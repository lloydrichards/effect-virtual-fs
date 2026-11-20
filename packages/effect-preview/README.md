# Effect VirtualFileSystem preview

This private workspace package supplies the filesystem engine for `@effect-vfs/core`. Memory, Node and LiveVolume
use it through core. It shares Effect 4.1.4 with the workspace. The exact revision of [Effect PR #9960](https://github.com/Effect-TS/effect/pull/9960)
and the checksums of the imported files are in [the upstream manifest](upstream/manifest.json).

## Build and test

From the repository root:

```sh
bun install --frozen-lockfile
bun run build
bun run test --maxWorkers=2
bun run --cwd packages/effect-preview type-check
```

With Node 26.11.1 on your path, run the provider, standalone consumer and mounted filesystem suites:

```sh
bun run test:node
bun run --cwd packages/node test:mounted
```

## Refresh from upstream

Supply a local Effect checkout and full commit hashes for the new head and the base of the filesystem changes.
Use the base in the manifest when refreshing the same commit series.

```sh
bun run --cwd packages/effect-preview refresh /path/to/effect-checkout HEAD_SHA BASE_SHA
bun run --cwd packages/effect-preview sync
bun run --cwd packages/effect-preview sync:check
```

When the upstream series is rebased onto a newer Effect runtime, pass `--keep-compatibility` to refresh only the
filesystem sources and tests. The manifest records the separate base and commit for the unchanged compatibility patches.
Refresh those patches when updating the workspace runtime.

Review the snapshot and generated diff, then rerun the build and tests above. The generator reads the checked-in
snapshot offline, rewrites imports for the installed Effect runtime, and emits `src/`, `test/` and `typetest/`.
Update the snapshot or generator when changing those directories. Review new upstream dependencies and explicitly
remove obsolete generated files when upstream removes a module.

The preview type check runs the type assertions and verifies that regeneration detects source drift, unexpected
generated files and corrupted inputs.
