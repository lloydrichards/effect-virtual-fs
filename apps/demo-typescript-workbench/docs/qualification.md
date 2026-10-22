# Architecture and qualification

The workbench is a trusted local developer demo. React, Vite and Effect Atom send shared Schema commands over HTTP RPC. An Effect Node coordinator owns worker RPC and an encoded save point. The worker owns one synchronous Effect VFS overlay.

## Mounted compilation

The fixture provisions TypeScript 5.9.3, its standard libraries, Node declarations and two editable source files inside the VFS. Both source files are compiler roots, including when a dependency is loaded with CommonJS `require`. TypeScript uses its ordinary default compiler host and emits into `/dist`. The worker rejects a build if any compiler input escapes the mount or if cleanup fails.

Node executes the emitted CommonJS entrypoint through a fresh viewer-bound mount. Closing the provider precedes unmounting; successful cleanup checks that mounted paths and CommonJS cache entries disappear. The editor identity writes source; the compiler writes generated output; the viewer reads both and cannot write either.

This adapts the React/Vite, Atom RPC and worker patterns in [Stack Effect's official templates](https://github.com/lloydrichards/stack-effect/tree/main/catalogs/official/templates). Browser workers support Monaco editing; a native Node worker hosts the mounted filesystem and compiler.

## Save points and stale results

Save point writes editor buffers, captures the complete filesystem and starts a fresh overlay generation. The coordinator retains encoded bytes outside the worker. Restore, Stop and execution timeout replace the worker from that checkpoint and invalidate the build. Reset returns to the starting fixture.

Accepted commands belong to the workbench scope, so HTTP disconnection cannot interrupt their state update. Generation and revision checks reject stale mutations. Replacement validates its generation inside a semaphore, and client tickets ignore responses superseded by Stop. Dirty editor buffers immediately disable Run.

## Executable evidence

Run the [README validation commands](../README.md#validation) using Node 26.11.1 with `--experimental-vfs`.

- [Worker qualification](../test/workbench.test.ts) exercises mounted compiler inputs, repeated builds, separate Compile/Run, denied emission and recovery, stale results, timeout recovery, console bounds and reset.
- [Module-graph regression](../test/module-graph.test.ts) changes a static import to `require`, edits the helper and checks that current output runs. It also rejects errors in a helper outside the static import graph.
- [Ownership regressions](../test/workbench-review.test.ts) cover interrupted compile/save requests, stale Stop during Restore, repeated checkpoint isolation and shutdown during a synchronous loop.
- [Cleanup regression](../test/mounted-cleanup.test.ts) keeps a sibling mount live, proves routing removal and injects an unmount failure that must reject compilation and Run.
- The [standalone compatibility probe](../../../packages/node/mounted/typescript-probe.mjs) records the original default-host read/emit/run experiment. The owning [Node mounted suite](../../../packages/node/mounted) retains descriptor-registry qualification.

The test files run sequentially to avoid competing native compilers on small CI runners. Their wall-clock budgets include compiler startup and snapshot transfer; they do not change the program execution deadline. The pinned Ubuntu Node 26 job runs the app build, Effect diagnostics and all runtime tests.

## Limits

Only a synchronous CommonJS entrypoint is observed. Console output is limited to 32,000 characters; direct process writes and asynchronous tasks are outside this version. The app run limit is three seconds. A checkpoint restores files, not execution state. All tabs share one workspace, lost on server restart. The mount is not a security sandbox, and Node VFS remains experimental. Qualification of other Node releases, platforms or arbitrary packages requires separate evidence.
