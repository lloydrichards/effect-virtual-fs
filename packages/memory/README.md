# @effect-vfs/memory

`@effect-vfs/memory` implements Effect's `FileSystem` service over a virtual volume. Provide its layer to run existing
Effect programs with disposable filesystem state, without changing their file operations.

The adapter supports files, directories, links, scoped handles, temporary resources, globbing, and watches. The
underlying state and permissions come from `@effect-vfs/core`.

## Install

```sh
npm install @effect-vfs/memory@latest
```

The binding and snapshot examples below import `@effect-vfs/core` directly. Add it as a direct dependency when using
those APIs:

```sh
npm install @effect-vfs/core@latest "@effect/platform-node-shared@$(npm view @effect-vfs/memory peerDependencies.effect)"
```

The second command installs the `NodeCrypto` provider at the version matching the package's Effect peer dependency.

## Replace the host filesystem

Write application code against Effect's `FileSystem` service, then choose the
implementation when you run it. The same program can use a platform filesystem
in production and an isolated in-memory filesystem in tests or tools.

This complete program creates a small build artifact without writing to disk:

```ts
import { MemoryFileSystem } from "@effect-vfs/memory"
import { Effect, FileSystem } from "effect"

const buildManifest = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem

  yield* fs.makeDirectory("/dist", { recursive: true })
  yield* fs.writeFileString(
    "/dist/manifest.json",
    JSON.stringify({ files: ["index.js", "index.css"] }, null, 2)
  )

  return yield* fs.readFileString("/dist/manifest.json")
})

const manifest = await Effect.runPromise(
  buildManifest.pipe(Effect.provide(MemoryFileSystem.layerCrypto))
)

console.log(manifest)
// { "files": ["index.js", "index.css"] }
```

`layerCrypto` creates a fresh volume containing `/tmp` and supplies its own `Crypto` service. Use
`MemoryFileSystem.layer` when your application already provides `Crypto`; use `MemoryFileSystem.make` when you need the
service directly.

## Choose isolated or shared state

Each execution of `MemoryFileSystem.make` creates independent storage. Use
`MemoryFileSystem.bind` when several callers need to see the same files through
an existing `@effect-vfs/core` volume.

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { MemoryFileSystem } from "@effect-vfs/memory"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const isolatedA = yield* MemoryFileSystem.make
  const isolatedB = yield* MemoryFileSystem.make

  yield* isolatedA.writeFileString("/private.txt", "only in A")

  const volume = yield* Vfs.make()
  const sharedA = yield* MemoryFileSystem.bind(volume)
  const sharedB = yield* MemoryFileSystem.bind(volume)

  yield* sharedA.writeFileString("/shared.txt", "visible to both")

  return {
    isolatedBHasFile: yield* isolatedB.exists("/private.txt"),
    sharedContents: yield* sharedB.readFileString("/shared.txt")
  }
})

console.log(await Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))))
// { isolatedBHasFile: false, sharedContents: "visible to both" }
```

Bindings share file and directory changes. Each binding still has its own
caller, descriptor table, file cursors, and resource scopes. A binding does not
create `/tmp` or otherwise change the supplied volume. Its caller defaults to a
privileged uid and gid of `0` with umask `0`.

Reusing `MemoryFileSystem.layer` within one layer graph shares the service
because Effect memoizes layers. Wrap it with `Layer.fresh` when separate parts
of the same graph must receive independent filesystems.

## Save and restore a volume

Snapshots let a test or tool capture a prepared filesystem and restore clean,
independent copies. Snapshot operations live in `@effect-vfs/core`, so keep the
core volume and expose it through `MemoryFileSystem.bind`.

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { MemoryFileSystem } from "@effect-vfs/memory"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { Effect } from "effect"
import * as ByteSize from "effect/ByteSize"

const decodeLimits = {
  maxEncodedBytes: ByteSize.megabytes(1),
  maxRecords: 10_000,
  maxEntries: 10_000,
  maxDecodedBytes: ByteSize.megabytes(1)
}

const program = Effect.gen(function*() {
  const volume = yield* Vfs.make()
  const fs = yield* MemoryFileSystem.bind(volume)

  yield* fs.writeFileString("/config.json", "version 1")
  const encoded = yield* Vfs.encodeSnapshot(yield* volume.snapshot)

  yield* fs.writeFileString("/config.json", "version 2")

  const snapshot = yield* Vfs.decodeSnapshot(encoded, decodeLimits)
  const restoredVolume = yield* Vfs.fromSnapshot(snapshot)
  const restoredFs = yield* MemoryFileSystem.bind(restoredVolume)

  return {
    current: yield* fs.readFileString("/config.json"),
    restored: yield* restoredFs.readFileString("/config.json")
  }
})

console.log(await Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))))
// { current: "version 2", restored: "version 1" }
```

A snapshot contains the reachable namespace, file contents, and metadata. It
does not contain bindings, callers, open handles, file cursors, watches, or
unlinked content. `/tmp` is restored only when it existed in the snapshot.

## Copy directory trees

`TreeTransfer` streams a directory tree between volumes. Sources emit entries
with paths rooted at the copied directory, so ordinary `Stream` operators can
filter or merge them before a sink writes them.

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { TreeTransfer } from "@effect-vfs/memory"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { Effect, Predicate, Stream } from "effect"

const program = Effect.gen(function*() {
  const project = yield* Vfs.fromFixture({
    entries: [
      { kind: "directory", path: "/project" },
      { kind: "directory", path: "/project/node_modules" },
      { kind: "file", path: "/project/index.ts", bytes: new TextEncoder().encode("run()") }
    ]
  })
  const workspace = yield* (yield* Vfs.make()).caller()

  yield* Stream.run(
    TreeTransfer.fromCaller(yield* project.caller(), "/project").pipe(
      Stream.filter((entry) => !Predicate.isString(entry.path) || !entry.path.startsWith("/node_modules"))
    ),
    TreeTransfer.toCaller(workspace, "/workspace")
  )

  return yield* workspace.readDirectory("/workspace")
})

console.log(await Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer))))
// [ "index.ts" ]
```

`toCaller` rejects an existing destination by default and removes the tree it
created if the transfer fails. `toVolume` builds a new volume only when every
entry is accepted. Sources enforce `TreeTransferLimits.default` unless you pass
other limits. `fromCaller` reads through a live caller and updates source access
times; `fromSnapshot` reads a snapshot and never changes the source.

`fromFileSystem` and `toFileSystem` connect a tree to any Effect `FileSystem`,
such as the host filesystem from `@effect/platform-node`. That interface carries
UTF-8 names and millisecond times only, so non-UTF-8 names, owners, change and
birth times, and symbolic-link metadata do not cross it. `toFileSystem` rejects
symbolic links that leave the copied tree unless `escaping: "allow"` is set, and
both fail on entries they cannot carry unless `unsupported: "skip"` is set.
`TreeTransfer.SinkCapabilities` lists what each destination preserves.

## Resource lifetimes

`FileSystem.open`, temporary resources, and watch subscriptions are scoped.
Keep the owning `Effect.scoped` workflow alive while the resource is in use.
Closing the scope closes its handles and subscriptions.

Bindings keep their own Effect-compatible file cursors. Watch streams receive
changes made through any binding and changes made by direct core callers on the
same volume.

## Globbing

Glob patterns are relative to the selected root and use `/` separators. The
adapter supports `*`, `?`, character classes, `**`, and brace alternatives.
Wildcards do not match a leading `.` unless that segment starts with a literal
dot. Empty, `.` and `..` path segments are rejected. Brace expansion is limited
to 256 alternatives.

## Limits

This package provides Effect's `FileSystem` service. It cannot intercept
`node:fs`, child processes, native extensions, or any code that accesses the
host filesystem directly. Relative paths resolve from virtual `/`, not the host
process working directory.

The implementation is ESM-only and does not depend on Node or Bun runtime APIs.
It can run in a browser when the rest of the application supports Effect and
ESM.

The core implements a bounded POSIX profile, not a mounted or persistent
filesystem. It does not provide FUSE mounts, host-tree synchronization, special
files, advisory locks, descriptor duplication, crash durability, or
copy-on-write snapshot optimization. Recursive adapter operations run as a
sequence of core operations rather than one transaction. See the
[implemented profile](https://github.com/lloydrichards/effect-virtual-fs/blob/main/.okf/profiles/implemented-filesystem.md)
for the exact behavior and exclusions.

## Compatibility

The package is experimental. Its public API may change between minor releases
while Effect v4 remains a release candidate.

The test suite checks the portable `FileSystem` contract and the core-backed
adapter. Release checks also compile the NodeNext import path, bundle a browser
consumer, and run a Node import smoke test.

The API began in [Effect PR #6573](https://github.com/Effect-TS/effect/pull/6573).
The portable contract suite began in
[Effect PR #6555](https://github.com/Effect-TS/effect/pull/6555).

## Credits

The original implementation was based on earlier work in
[effect-smol PR #456](https://github.com/Effect-TS/effect-smol/pull/456).

Licensed under the MIT License.
