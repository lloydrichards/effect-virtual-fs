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
    title: Isolated loader and descriptor registry qualification
  - resource: ../../packages/node/README.md
    title: Supported configuration and ownership limits
  - resource: ../../.github/workflows/pr-validation.yml
    title: Separate pinned CI configuration
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
mutation. A subprocess uses `--expose-internals` solely to inspect the pinned Node registry after explicit closes.
Production code does not import internal Node modules.

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
