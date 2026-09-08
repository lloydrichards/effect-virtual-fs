# Virtual build consumer

Private acceptance consumer importing built `@effect-vfs/core` exports. Vite and its toolchain run on the host;
module source comes through the core caller's public byte/path APIs. No source tree is staged on disk.

From the repository root:

```sh
bun run build
bun run --filter @repo/virtual-build demo
bun run --filter @repo/virtual-build test
bun run --filter @repo/virtual-build measure
```

The plugin supports explicit JavaScript paths, relative imports, and packages directly under virtual `/node_modules`
with `type: "module"` and a single string `exports: "./file.js"`. It rejects unsupported bare specifiers and missing
virtual files without a host fallback. This is a bounded package demonstration, not Node resolution: extension
inference, conditional exports, CommonJS, package subpaths, installation, HMR, and filesystem watch mode are absent.
Rebuild means a fresh Vite build after mutation. The build returns its chunk in memory with `write: false`.

The tests evaluate both build outputs (42 then 43), remove dependencies to prove failures, and evaluate a package
available only in the volume. A separate test stores one encoded snapshot in a temporary host directory, restores
it, and builds again. The temporary directory contains only the snapshot and is removed by scope cleanup.

Vite library entries are normally normalized into host paths. The plugin uses explicit `rolldownOptions.input`
to retain the virtual entry, then `resolveId` and `load` for virtual module identity and bytes. References:
[Vite plugin API](https://vite.dev/guide/api-plugin), [JavaScript API](https://vite.dev/guide/api-javascript).

`measure` is an external benchmark, not a core import/export operation or build source fallback. It walks the
installed Effect, Vite, and Rolldown package directories, excluding nested node_modules and nonregular entries,
prepares a fixture, then measures capture, encoding, bounded decoding, and restoration. It records payload and
encoded sizes. This is a selected real dependency workload, not the complete transitive dependency graph, a heap
profile, or a portable performance guarantee. Results are in `.docs/evidence/consumer/measurement.json`.
