# @effect-vfs/core

`@effect-vfs/core` manages in-memory volumes with byte-preserving paths, callers with explicit permissions, quotas,
watches, fixtures, and portable snapshots. It does not access the host filesystem.

Use core when you need direct control over a shared volume or byte-oriented paths. For Effect's standard
`FileSystem` service, use [`@effect-vfs/memory`](../memory/README.md).

The package implements a documented subset of POSIX behavior. It does not claim full POSIX conformance. See the
[implemented profile](https://github.com/lloydrichards/effect-virtual-fs/blob/main/.okf/profiles/implemented-filesystem.md)
for the exact permission, path, timestamp, quota, and atomicity rules.

## Install

```sh
npm install @effect-vfs/core@latest
```

The package declares its exact Effect version as a peer dependency. Volume constructors and snapshot delta functions require Effect's `Crypto` service. On Node, install the matching
provider and supply `NodeCrypto.layer` when running these effects:

```sh
npm install "@effect/platform-node-shared@$(npm view @effect-vfs/core peerDependencies.effect)"
```

## Create an isolated workspace

A volume owns the files. A caller supplies identity, permissions, and a working directory. Scoped handles close when
their Effect scope ends. This example gives an unprivileged caller access to one directory in a bounded volume.

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { ByteSize, Effect } from "effect"

const utf8 = new TextEncoder()

const program = Effect.scoped(Effect.gen(function*() {
  const volume = yield* Vfs.make({
    maxEntries: 100,
    maxBytes: ByteSize.megabytes(1),
    maxFileBytes: ByteSize.kilobytes(100)
  })

  const admin = yield* volume.caller()
  yield* admin.mkdir("/workspace", { mode: 0o770 })
  yield* admin.chown("/workspace", { uid: 1000, gid: 1000 })

  const developer = yield* volume.caller({
    identity: { uid: 1000, gid: 1000, groups: [], privileged: false },
    umask: 0o027
  })

  yield* developer.writeFile(
    "/workspace/config.json",
    utf8.encode(JSON.stringify({ feature: "preview" })),
    { access: "write", create: "exclusive", mode: 0o666 }
  )

  const file = yield* developer.open("/workspace/config.json", { access: "read" })
  const contents = yield* file.read(100_000)
  const metadata = yield* file.stat

  return {
    config: JSON.parse(new TextDecoder().decode(contents)),
    mode: metadata.mode.toString(8)
  }
}))

const result = await Effect.runPromise(program.pipe(Effect.provide(NodeCrypto.layer)))
console.log(result) // { config: { feature: "preview" }, mode: "640" }
```

The root caller is privileged by default. Privilege is explicit: setting `uid` to `0` does not grant it. New root
callers default to umask `0o022`; the developer's `0o027` mask turns the requested file mode `0o666` into `0o640`.

The root package exports `VirtualFileSystem` as a namespace. The equivalent direct module import is
`import * as Vfs from "@effect-vfs/core/VirtualFileSystem"`.

## Confine a caller to a directory

`caller.withRoot(path)` creates a scoped caller whose `/` is that directory. Absolute symlinks and `..` stay
inside the root. Renaming the root preserves access; deleting it permanently invalidates the caller.

Keep the caller's scope open and pass only the capabilities the consumer needs. Existing hard links can share
file contents across roots. See [Confine a workspace](../../apps/docs/app/content/guides/confined-workspaces.mdx)
for a complete example with Effect's `FileSystem` service and the confinement limits.

## Guides and reference

- [Fixtures and snapshots](../../apps/docs/app/content/guides/fixtures-and-snapshots.mdx) covers seeded trees, codecs, and portable deltas.
- [Overlay workspaces](../../apps/docs/app/content/guides/overlay-filesystems.mdx) covers independent edits and `mergeSnapshotDeltas` conflicts.
- [Snapshot search](../../apps/docs/app/content/guides/snapshot-search.mdx) covers filename globs, content matches, and bounded results.
- [Filesystem model](../../apps/docs/app/content/concepts/filesystem-model.mdx) explains callers, handles, permissions, and byte paths.
- [API reference](../../apps/docs/app/content/api/core/virtual-file-system.mdx) lists constructors, services, and operations.

## Limits

The package is experimental. Public APIs may change between minor releases.

Paths preserve arbitrary non-NUL bytes. Components are limited to 255 bytes, and symlink traversal to 40 links.
Volume options bound entries, file sizes, pending operations, and watch queues. In-memory volumes provide no host or
crash durability. See [compatibility and limits](../../apps/docs/app/content/reference/compatibility-and-limits.mdx)
for the complete contract.
