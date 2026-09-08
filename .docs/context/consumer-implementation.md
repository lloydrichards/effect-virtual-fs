# Virtual consumer evidence

Implemented 9 September 2026 under the continued implementation request. The private `@repo/virtual-build` app
imports the built core package. Its three tests build and evaluate a relative module, rebuild after a dependency
mutation, load a bounded virtual ESM package, reject missing dependencies, and restore externally stored snapshot
bytes before another build. Source files remain in the volume. See the [consumer README](../../apps/virtual-build/README.md)
for the exact resolver subset and commands.

The initial missing implementation failure was an import/setup failure, not a behavioral regression. The first
implemented plugin could not resolve Vite's normalized library entry. Setting `rolldownOptions.input` explicitly
preserves the virtual identifier. The resulting tests evaluate 42, then 43, and the string virtual-package. No
continuous watch/HMR, arbitrary dependency resolution, or browser runtime acceptance is claimed.

The external benchmark loaded selected installed Effect/Vite/Rolldown package trees: 2,431 regular files,
2,554 entries and 50,721,951 source bytes. Encoding produced 68,108,683 bytes (1.343 times source payload).
[Raw measurement](../evidence/consumer/measurement.json) records each timing and runtime. It excludes nested
node_modules and nonregular entries, and is not a complete transitive project graph or a heap bound.

[Validation](../evidence/consumer/results.json) records lint, actual-export and prototype contracts, executable
models, workspace types, forced tests, and builds. Logs identify cache hits separately; forced tests execute all
158 tests (60 core, 95 adapter, three consumer). The demo output is also retained. Formatting is checked separately.
Bun 1.4.0 is installed, differing from packageManager's 1.2.21; Node is 24.10.0. Existing dependency versions were
retained; Vite 8.2.2 was already in the lockfile and is now a direct private consumer dependency.
