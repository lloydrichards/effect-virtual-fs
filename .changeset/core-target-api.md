---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
"@effect-vfs/nfs": minor
"@effect-vfs/persistence": minor
---

The public API of `@effect-vfs/core` is rebuilt around a `Target` type, Effect services, and one error family. This is a breaking release for every package in the group.

- **One verb per operation.** `Caller` has about twenty POSIX-named verbs that each take a `Target` (a path, an object reference, or an open handle) or an `Entry` (a child of a directory target). The `*Reference`, `*Handle` and `*Bytes` twins, `lstat`, and the `relativeTo`/`followFinalSymlink` option keys are gone: `Target.Path({ path, relativeTo, followFinalSymlink })` carries them, and a bare path, reference, or handle is accepted where a target is.
- **Bytes out.** `readDirectory` returns entries with references and the directory's revision; `readLink` and `realPath` return bytes; `stat` returns `Metadata` with a `revision`; `pread` returns `{ bytes, eof }`; `access` returns the granted bits instead of failing.
- **One `VfsError`.** `FsError`, `ConfigurationError`, `ImageError`, `SnapshotDeltaError` and `LiveVolumeError` are replaced by `VfsError` with a merged `code` union, an `operation`, and optional `field`, `path` (as bytes) and `cause`. Every rejected option fails as `InvalidArgument` with a `field`, and `VfsError.make` builds an error whose type carries its code, so a store can fail with `StoreFailure` without a cast.
- **No `Crypto` on construction.** `make`, `fromSnapshot`, `makeOverlay`, `fromFixture` and `LiveVolume.open` need no `Crypto` service and no longer fail with `PlatformError`; memory's `makeCrypto` and `layerCrypto` are gone because `make` and `layer` need nothing.
- **Services and layers.** `Volume.layer`, `layerFromSnapshot`, `layerFromFixture`, `layerOverlay`, `layerLive` and `Caller.layer` replace hand-rolled wiring; `CurrentFileSystem` is removed.
- **Codes.** Both addressing modes follow Linux's check order: search permission on a directory before any name in it is looked up, then the name, trailing slashes and rename's structural rules, then write permission. Three trailing-slash rules now match Linux, a string entry name must be well-formed like a string path, and a removed directory that a handle still holds takes no new children.
- **Modules.** `Volume`, `Caller`, `Target`, `FileHandle`, `Metadata`, `VfsError`, `Fixture`, `Watch`, `Snapshot`, `SnapshotDelta` and `BytePath` are importable subpaths; `BytePath` gains `join`, `parent`, `basename`, `toString`, `Order` and more.

### Migration

```ts
// before
const before = Effect.gen(function*() {
  const root = yield* fs.rootReference
  const work = yield* fs.lookupReference(root, encoder.encode("work"))
  const { value } = yield* fs.observeMetadata(work)
  yield* fs.mkdirReference(root, encoder.encode("out"), { mode: 0o755 })
  const meta = yield* fs.lstat("/link")
  const names = yield* fs.readDirectory("/")
})
await Effect.runPromise(before.pipe(Effect.provide(NodeCrypto.layer)))

// after
const after = Effect.gen(function*() {
  const root = yield* fs.root
  const work = yield* fs.lookup(Vfs.Entry(root, "work"))
  const value = yield* fs.stat(work) // carries .revision
  yield* fs.mkdir(Vfs.Entry(root, "out"), { mode: 0o755 })
  const meta = yield* fs.stat(Vfs.Target.Path({ path: "/link", followFinalSymlink: false }))
  const names = (yield* fs.readDirectory("/")).value.map((entry) => decoder.decode(entry.name))
})
await Effect.runPromise(after) // no Crypto layer
```

Match errors on `code` and `operation` (`Effect.catchTag("VfsError", ...)`); `error.path` is a `BytePath`. Memory's platform error map and NFS's status map cover the whole code union.
