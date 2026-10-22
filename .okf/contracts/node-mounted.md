---
type: Contract
title: Mounted Node qualification
description: Defines caller-owned mounted descriptor teardown and the pinned fs, stream and loader qualification suite.
status: stable
tags: [node, adapters, handles]
sources:
  - resource: ../../packages/node/mounted/fixture.ts
    title: Resource-owning mounted fixture
  - resource: ../../packages/node/mounted/Lifetime.test.ts
    title: Success, failure, interruption and reentrant cleanup
  - resource: ../../packages/node/mounted/FileSystem.test.ts
    title: Mounted filesystem routing
  - resource: ../../packages/node/mounted/Streams.test.ts
    title: Native path, descriptor and handle streams
  - resource: ../../packages/node/mounted/loader-case.mjs
    title: Isolated loader and routing qualification
  - resource: ../../packages/node/vitest.mounted.config.ts
    title: Separate public routing and internal ownership workers
  - resource: ../../packages/node/README.md
    title: Supported configuration and ownership limits
  - resource: ../../apps/demo-typescript-workbench/src/workbench/workspace.ts
    title: Mounted default-host TypeScript workbench and caller policy
  - resource: ../../apps/demo-typescript-workbench/src/workbench/coordinator.ts
    title: Effect worker ownership and server-held checkpoint recovery
  - resource: ../../apps/demo-typescript-workbench/test/workbench.test.ts
    title: Rebuild, permissions, save points, stale commands and worker termination qualification
  - resource: ../../apps/demo-typescript-workbench/test/workbench-review.test.ts
    title: Request interruption, stale Stop, shutdown and save-point isolation regressions
  - resource: ../../apps/demo-typescript-workbench/test/mounted-cleanup.test.ts
    title: Current workbench routing-removal and cleanup-failure regression
  - resource: ../../.github/workflows/pr-validation.yml
    title: Separate pinned CI configuration
generated: { by: codex/okf, at: "2026-10-22T15:02:00Z" }
---

# Mounted Node qualification

The [direct provider](node-provider.md "depends on") shares the synchronous engine with Effect callers. The mounted suite
qualifies Node's routing and native wrappers separately. It does not change the Effect FileSystem service contract.
The executable baseline is Node 26.11.1 with `--experimental-vfs`; CI selects Ubuntu 24.04. A local macOS arm64 run is
additional evidence, not proof of other Node releases or platforms. Each run prints runtime, OS, architecture, Effect
version, candidate revision and dirty-tree state.

## Ownership

Node owns synthetic numeric descriptor registrations; the provider owns private engine handle scopes. Callers own the
Node descriptors, promise handles and streams they open. Stop producers, drain or destroy streams and wait for closure,
then close handles and numeric descriptors while the provider remains live. Close the provider scope, then unmount
routing in a final cleanup block. `unmount()` does not close descriptors. Scope closure does not remove Node registry
entries. No public API enumerates another caller's descriptors, so the test fixture explicitly records its own resources.

A reentrant descriptor close rejected with EBUSY retains ownership and must be retried after the active engine operation.
Reentrant closure of the whole binding scope while Node descriptors are live violates the mounted ownership contract.
The tests cover normal success, failure and interruption, open-unlinked release, rejected nested closes and no later
mutation. A dedicated ownership worker uses `--expose-internals` to inspect the pinned registry after the actual fixture
teardown for every outcome. Captured numeric, promise-handle and stream descriptors must disappear. A live sibling mount
keeps public layer enumeration available so the test can prove routing removal rather than infer it from a failed stat.
Removing either numeric closes or unmount makes all four lifetime tests fail. Public routing and loader workers do not
expose internals; production code does not import internal Node modules.

## Routing, streams and loaders

Sync, callback and promise operations exercise shared writes, flags, metadata, links, errors, independent cursors,
append/truncate, readonly and UTF-8 name rejection. Path streams and native promise-handle streams route through Node
and synthetic descriptors. Direct provider handle stream helpers remain unsupported.

Isolated built-package processes demonstrate CJS/ESM imports and virtual package lookup. Missing virtual dependencies do
not fall back to host node_modules. Module identities cache while mounted; explicit CJS eviction and ESM generation URLs
reload changed sources. Unmount/remount invalidates the tested module cache entries. This is pinned runtime evidence,
not a hot-reload service or sandbox guarantee.

Watches remain unsupported. Inodes are volume-local, not globally unique between mounts. Memory sync/datasync confer no
crash durability. Node's cursor survives truncate, while the Effect wrapper clamps it. Node routing can replace provider
errors: the pinned wrapper reports ENOENT for stat beneath a regular file, while the direct provider reports ENOTDIR.
Additional Node versions, arbitrary byte-name routing and broader loader configurations require separate qualification.

## Qualified TypeScript consumer

The private `apps/demo-typescript-workbench` workbench qualifies TypeScript 5.9.3's JavaScript compiler with its default
compiler host on Node 26.11.1, macOS arm64. Effect provisions the unmodified compiler, standard libraries and Node
declarations in a snapshot. One synchronous working overlay uses editor, compiler and viewer identities. Each compile
or run creates a fresh mount. Every compiler input must resolve inside it. TypeScript emits CommonJS into the overlay,
Node loads the output, and Effect inspects the same files through the viewer caller.

The Effect Node coordinator owns worker RPC and retains an encoded save point outside the worker. Capture starts a new
overlay generation; restore replaces the worker and invalidates the build. Timeout or Stop terminates the worker and
restores that checkpoint. Generation and revision checks reject stale commands. Failed builds cannot run prior output.
Headless checks cover repeated dependency edits, separate Compile/Run, viewer emission denial and recovery, snapshot
restoration, stale generation rejection, Stop during an in-flight command and bounded stdout/stderr console capture.
Accepted commands belong to the workbench scope rather than the HTTP request, so disconnection cannot split worker and
coordinator state. Stop validates its submitted generation inside the replacement lock. View waits for replacement to
finish. Owner shutdown terminates native execution before protocol teardown, closes command fibers, and rejects later
commands. Review regressions cover interrupted compilation/save, stale Stop during Restore, repeated checkpoint isolation
and shutdown during a synchronous loop.

Cleanup checks mounted routing and CommonJS cache removal after each attempt. The workbench cleanup test keeps a live
sibling mount to prove routing removal and injects an unmount failure to reject the build. The obsolete comparison
implementation and its tests have been removed. These consumer assertions do not enumerate
Node's descriptor registry; that stronger check belongs to the mounted lifetime suite above.

The browser uses React/Vite and Atom RPC with shared Schema contracts; an Effect Node HTTP server forwards commands to the
worker. Monaco supplies editing, while the mounted compiler supplies diagnostics and emitted files. All tabs share one
local workspace. Execution observes a trusted synchronous CommonJS entrypoint and captures console output, not arbitrary
asynchronous process lifecycle. This is not qualification of TypeScript's native compiler, arbitrary npm tools, concurrent
compilation, hosted execution, another platform or a JavaScript sandbox.
