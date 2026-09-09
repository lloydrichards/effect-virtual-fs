# Virtual build consumer

Private acceptance consumer importing built `@effect-vfs/core` exports. Vite and its toolchain run on the host;
module source comes through the core caller's public byte/path APIs. No source tree is staged on disk.

From the repository root:

```sh
bun run build
bun run --filter @repo/virtual-build demo
bun run --filter @repo/virtual-build test
bun run --filter @repo/virtual-build measure
# Run in a fresh Node process to include the verified process peak RSS metric:
node apps/virtual-build/src/measure.ts
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
prepares a fixture, then measures capture, encoding, bounded decoding, and restoration. It records installed package
versions, file/entry counts, payload and encoded sizes, and milliseconds for preparation and each phase. Sorted names
make traversal reproducible for the same installed package contents. Run a frozen install and build first; package
versions and file counts identify the selected workload, which is not a complete transitive project graph.

Under Node, `memory.peakRssBytes` is the process lifetime maximum resident set size through restoration, including
runtime startup, imports, host fixture preparation and all measured phases. The
[Node resource-usage API](https://nodejs.org/docs/latest-v24.x/api/process.html#processresourceusage) reports `maxRSS`
in KiB; the script multiplies it by 1024 to report bytes. The two current-RSS observations are also bytes, not peaks.
The script does not force garbage collection or isolate phases, and fixture inputs and pipeline values can coexist.
This measures the whole benchmark process, not core-only memory, exact JavaScript heap allocation, per-phase peaks,
or a portable memory guarantee. Peak RSS is `null` under Bun because that runtime's metric has not been verified here;
use the direct Node command above for peak-memory evidence. Runtime and platform are recorded with each result.
The original timing/size sample is in `.docs/evidence/consumer/measurement.json`.
