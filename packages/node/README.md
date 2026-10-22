# @effect-vfs/node

A direct Node `VirtualProvider` over an existing `@effect-vfs/core` memory volume. Effect callers and provider calls share
files, links, metadata and open-object lifetime.

The initial tested runtime is **Node 26.11.1 with `--experimental-vfs`** and Effect 4.0.5. The package depends on core and
Effect; it does not require the Effect Node platform at runtime. Node's VFS API is experimental.

## Bind a volume

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { NodeVirtualProvider } from "@effect-vfs/node"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import * as Effect from "effect/Effect"

const program = Effect.scoped(Effect.gen(function*() {
  const volume = yield* Vfs.make({ execution: "sync" })
  const provider = yield* NodeVirtualProvider.bind(volume)
  const caller = yield* volume.caller()

  provider.writeFileSync("/message.txt", "shared")
  const bytes = yield* caller.readFile("/message.txt")
  return new TextDecoder().decode(bytes)
}))

const message = await Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer)))
```

`bind(volume, options)` requires an Effect scope. Closing it invalidates the provider and closes its handles. Explicit
handle close releases ownership before returning; later scope cleanup is safe. A rejected reentrant close returns `EBUSY`
and leaves the handle open. Cooperative volumes, asynchronous commit backends, copied volume objects and volumes from
another installed core copy are rejected.

The optional `caller` selects core identity and umask. `readonly: true` rejects mutations through this provider with
`EROFS`; other callers can still change the shared volume.

## Direct provider contract

- Sync and promise operations cover open, metadata, directories, links, access, whole-file I/O, append and copy. Promise
  methods use the same synchronous memory operations and reject failures as promises.
- Numeric open flags preserve access, create, exclusive, truncate, append, final-component no-follow and directory bits.
  Unknown bits fail before mutation. Sync/datasync flags and methods check handle health but promise no crash durability.
- Handles have their own Node cursor. Positioned I/O leaves it unchanged. Append writes at EOF even with an explicit
  position. Truncate preserves the cursor. Both scalar and vector I/O are available.
- Whole-file helpers perform open, write and close separately. A failed write can leave a newly created or truncated
  file or partially written contents. No pending write continues after a synchronous call returns.
- Read and write calls accept positional arguments or buffer options. Reads also accept an options bag with an optional
  buffer, and writes accept strings with a position and encoding. ArrayBuffer views use byte offsets; promise results
  retain the original buffer or string. Vector calls validate every slot before I/O, including sparse arrays.
- Copy failures report `copyfile` with the source `path` and destination `dest`.
- Handles retain an unlinked or replaced object until close. Node allocates numeric virtual descriptors above this
  protocol; provider handles do not invent descriptor numbers.
- Stats, bigint stats and directory entries are structural implementations of the public Node interfaces. Bigint
  observations retain nanosecond times and inode values. They do not promise `instanceof fs.Stats` or `fs.Dirent`.
- Paths and names must be representable as well-formed UTF-8 text. Provider input paths are strings. Invalid byte names
  encountered in directory listings or symlink targets fail with `EILSEQ`, including when buffer output is requested.
- Errors carry Node `code`, negative platform `errno`, `syscall`, and applicable `path` and `dest` fields.

`supportsSymlinks` is true. `supportsWatch` is false, and watch hooks fail with `ENOSYS`. Handle stream helpers and statfs
also fail explicitly. Unsupported copy flags and junction symlinks are rejected.

Construction does not mount a filesystem or install global hooks. Direct provider qualification is tracked by
[#310](https://github.com/lloydrichards/effect-virtual-fs/issues/310). The separate mounted suite under
[#311](https://github.com/lloydrichards/effect-virtual-fs/issues/311) exercises Node routing and loaders as described below.

## Development checks

With Node 26.11.1 on `PATH`, run these commands from the repository root:

```sh
bun run --cwd packages/core build
bun run --cwd packages/node build
bun run --cwd packages/node type-check
bun run --cwd packages/node test
bun run --cwd packages/node test:consumer
```

The direct Node suite runs separately from the Bun workspace suite. It does not mount a provider. The consumer check imports the
built package through its public exports.

## Mounted Node profile

The separate `test:mounted` suite exercises real `node:fs` sync, callback and promise routing on Node 26.11.1 with
`--experimental-vfs`. It covers synthetic descriptors, native promise `FileHandle` wrappers, path and handle streams,
shared Effect/Node writes, unlink/rename lifetime, and isolated CJS/ESM loading. It does not change the Effect
`FileSystem` service profile. CI selects Ubuntu 24.04; additional Node releases require separate qualification.

Node owns numeric descriptors and the native stream wrappers. The provider owns the backing private handle scopes.
Every caller that opens a descriptor, promise handle or stream must close it before ending the provider's Effect scope.
Neither scope closure nor `unmount()` removes Node's descriptor registrations on the caller's behalf. Teardown order is:

1. Stop producers, destroy or finish streams, and wait for their `close` events.
2. Close promise handles and numeric descriptors through Node while the provider binding is still live.
3. End the provider's Effect scope, then unmount routing in a `finally` block.

The qualification fixture implements this order on success, failure and Effect interruption. A nested descriptor close
that receives `EBUSY` must be retried after the active operation returns. Do not close the owning scope reentrantly while
Node resources remain open. A test-only subprocess inspects the pinned runtime's descriptor registry to prove removal;
the package imports no Node internal modules.

The resource-owning fixture in `mounted/fixture.ts` is an executable example. It records resources opened by the caller;
it does not discover descriptors opened elsewhere in the process. Keep third-party consumers inside that lifetime and
wait for them to stop before teardown. The pinned `@types/node` version omits `mount` and `unmount`, so the fixture uses a
local declaration for those runtime methods rather than changing the public Node types.

The mounted prefix comes from Node. Do not construct it or use it as a security sandbox. CJS and ESM modules cache by
resolved identity while mounted. The tests demonstrate explicit CJS cache deletion and ESM generation URLs for reload,
plus cache invalidation on unmount/remount. Missing virtual dependencies do not fall back to host `node_modules`.

Limits remain explicit: watches are unsupported; paths require UTF-8 text; memory sync/datasync provide no crash
durability; inode numbers describe the backing volume and are not globally unique across mounts. Node cursors preserve
position after truncate, unlike the Effect file wrapper. Native routing can rewrite provider errors: on the pinned
runtime, `stat` beneath a regular file reports `ENOENT` rather than the direct provider's `ENOTDIR`. The direct provider's
stream helper methods remain unsupported; mounted `FileHandle` streams use Node's native wrapper and synthetic fd.

Build the packages, then run the mounted suite independently of the direct suite:

```sh
bun run --cwd packages/core build
bun run --cwd packages/node build
bun run --cwd packages/node test:mounted
```

The suite prints Node, OS, architecture, Effect version and source revision. Loader cases run against the built public
package in fresh processes. A dirty working tree is reported and must not be mistaken for a committed CI candidate.
