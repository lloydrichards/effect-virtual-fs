---
type: Contract
title: Direct Node provider
description: Defines the checked shared-volume Node provider, independent handle protocol and limits before mounted qualification.
status: stable
tags: [node, adapters, handles]
sources:
  - id: binding
    resource: ../../packages/core/src/SynchronousAdapter.ts
    title: Core-owned synchronous adapter binding
  - id: provider
    resource: ../../packages/node/src/NodeVirtualProvider.ts
    title: Direct Node provider
  - resource: ../../packages/node/src/internal/fileHandle.ts
    title: Node handle protocol
  - resource: ../../packages/node/test/Provider.test.ts
    title: Direct provider behavior
  - resource: ../../packages/node/test/Lifetime.test.ts
    title: Reentry and ownership lifetime
  - resource: ../../packages/node/README.md
    title: Runtime profile and commands
  - resource: https://github.com/nodejs/node/blob/v26.11.1/lib/internal/vfs/provider.js
    title: Pinned Node provider protocol
---

# Direct Node provider

`@effect-vfs/node` adapts one existing synchronous core volume to Node's `VirtualProvider` protocol. It depends on core and
Effect, while the [Effect FileSystem adapter](memory-adapter-compatibility.md "contrasts with") remains separate. The
[package boundary](../decisions/package-boundaries.md "constrained by") keeps native imports, numeric flags, errors and
metadata conversion outside portable core.

`SynchronousAdapter.bind` uses core-owned volume identity. A copied object or another installed core copy is rejected.
Only constructor-qualified sync memory engines can bind; cooperative and asynchronous commit backends remain ineligible.
There is no public arbitrary-Effect synchronous runner. Its scope owns every private handle scope. Explicit close checks
reentry before resource changes and releases ownership before success. Later finalization is safe. External reentrant
scope closure invalidates handles and drains orphan release before the active operation returns, as required by the
[live execution policy](../architecture/volume-caller-handle-model.md "constrained by").[^binding]

The Node wrapper owns its cursor and uses shared engine handle identity. Positioned I/O leaves the cursor unchanged;
append chooses EOF even with an explicit position; truncation preserves the cursor. Namespace replacement does not
redirect existing handles. Scalar calls normalize Node read/write option forms and string writes before I/O, retain
the original result buffer, and treat ArrayBuffer-view offsets as bytes. Vector calls reject every invalid or absent slot
before changing content, buffers or cursors. Node owns synthetic descriptor allocation above the provider protocol.

The direct profile includes sync/promise primitives, metadata hooks and whole-file derived methods. Whole-file helpers
perform open, write and close separately; failure can leave a newly created or truncated file or partial contents, but no pending write
continues after synchronous return. Unknown numeric open
bits fail before mutation. Copy errors retain the `copyfile` syscall, source path and destination. Readonly policy applies to provider and handle mutations with EROFS. Memory sync/datasync checks
health without crash-durability claims. Metadata observations retain exact bigint inode and nanosecond values, and use
structural public Node interfaces rather than importing internal Node constructors. Unrepresentable names fail rather
than silently decode with replacement characters. Initial routing is text-only. Watches, handle stream helpers and statfs
are explicitly unsupported.[^provider]

The protocol baseline is Node 26.11.1 with `--experimental-vfs`. Direct provider tests and the built-package consumer run
in a separate native Node job. The Bun core and memory suites remain distinct. Construction never mounts a filesystem or
installs global hooks. Mounted fs calls, descriptor registration, streams and loaders remain with #311; direct tests do
not establish those capabilities.
