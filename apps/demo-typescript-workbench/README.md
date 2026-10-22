# TypeScript workbench

A local developer demo: edit TypeScript, compile it with the default TypeScript host through a mounted Effect VFS, and run the emitted JavaScript with Node. Project files stay in memory.

## Run

Use **Node 26.11.1** with `--experimental-vfs`. From the repository root:

```sh
bun install
bun run --cwd packages/core build
bun run --cwd packages/node build
PATH=/opt/homebrew/opt/node@26/bin:$PATH bun run --cwd apps/demo-typescript-workbench dev
```

Open [the workbench](http://127.0.0.1:4310/). Both servers bind to `127.0.0.1`. `PORT` selects the frontend port; the RPC server uses `PORT + 2` (4312 by default). All tabs share one workspace. Restarting the server loses its save point.

For the production browser bundle, run `build`, then `start`, using the same Node version. The workspace package is `@repo/typescript-workbench`.

## Try it

1. Choose **Compile & Run**. Read the Node output, then select `/dist/index.js` to inspect actual emitted JavaScript.
2. Edit `/src/format.ts`. Run again and see the changed dependency execute. Separate **Compile** and **Run** let you inspect the intermediate files.
3. Choose **Save point** to capture the filesystem, including any editor buffers and generated files. A new working overlay starts from that snapshot.
4. Introduce a type error and compile. Problems shows the actual compiler diagnostic. Run stays disabled; previous output is labelled stale.
5. Choose **Restore** to replace the working overlay from the server-held save point. Compile again before running.
6. Expand **Caller permissions**, compile as Viewer, and observe actual denied emission. Compile as Compiler to recover.
7. Try `while (true) {}`. Run times out after three seconds, terminates the worker and restores the save point. **Stop & restore** can also interrupt an active command.

**Reset example** returns to the immutable starting fixture. There is one replaceable save point, rather than a history of named versions.

## Architecture

The implementation adapts Stack Effect's React/Vite, `AtomRpc.Service`, shared Schema RPC, Effect Node server and worker patterns to this repository's Bun workspace. See [the research](../../research/stack-effect-vite-worker-atom.md).

React + Atom → typed HTTP RPC → Effect Node coordinator → Effect worker RPC → one authoritative synchronous VFS overlay.

The worker provisions TypeScript 5.9.3, its standard libraries, Node declarations and source inside the mount. No custom compiler host or browser compiler emits the project. Editor writes use the editor identity; compilation mounts the compiler or viewer identity; execution mounts the viewer identity. Inspection reads use the Effect viewer. The native mount is scoped, closed and unmounted after every compile or run; cleanup checks routing and CommonJS cache removal.

The coordinator retains the encoded checkpoint outside the worker. Generation and revision checks reject stale commands; the client ignores responses superseded by Stop. Failed builds cannot run old JavaScript. Restore and Save point invalidate the build even when generated files are retained.

Monaco supplies syntax highlighting and editing. Problems comes from the mounted compiler. The editor loads separately; its production chunk is about 925 kB gzipped. This is a local demo, not a bundle-size benchmark.

## Execution limits

This is a **trusted local tool**, not a JavaScript sandbox. The supported run completes a synchronous CommonJS entrypoint and captures `console` output, bounded to 32,000 characters. Direct process writes are drained separately. Asynchronous background work, package installation, shell execution and debugging are outside this version. A save point restores files, not module globals or past execution. Node's VFS remains experimental.

## Validation

With Node 26.11.1 on PATH:

```sh
bun run --cwd apps/demo-typescript-workbench test
bun run --cwd apps/demo-typescript-workbench type-check
bun run --cwd apps/demo-typescript-workbench lint:effects
bun run --cwd apps/demo-typescript-workbench build
```

`test/workbench.test.ts` qualifies the current Effect RPC worker, repeated builds, Node declarations, separate Compile/Run, real permission denial and recovery, checkpoint restoration, stale commands, Stop, timeout recovery and output bounds. `test/mounted-cleanup.test.ts` qualifies routing removal and rejects a build when unmount reports failure. The obsolete comparison server, protocol and tests have been removed.

`test/workbench-review.test.ts` adds request interruption, stale Stop during Restore, owner shutdown and save-point isolation regressions. Accepted commands belong to the workbench scope, so disconnecting a browser does not interrupt a filesystem transaction. Stop explicitly replaces the worker.

See [the correctness review](../../research/vfs-typescript-workbench-review.md), [the workbench qualification](../../research/vfs-typescript-workbench-qualification.md) and [the original compatibility probe](../../research/build-two-futures-probe.md).
