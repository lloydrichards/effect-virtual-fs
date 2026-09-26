# @effect-vfs/persistence

## 0.6.0

### Minor Changes

- [#215](https://github.com/lloydrichards/effect-virtual-fs/pull/215) [`06a9086`](https://github.com/lloydrichards/effect-virtual-fs/commit/06a90860558f8231c5f9426ff212dad861d08d04) Thanks [@lloydrichards](https://github.com/lloydrichards)! - `Caller` now accepts a path, object reference, or open handle as a `Target`, and the packages use one `VfsError` family. This changes existing calls and error handling across the fixed release group.

  Replace `*Reference`, `*Handle`, and `*Bytes` methods with the corresponding `Caller` method. Use `Vfs.Entry(directory, name)` for an entry relative to a directory. Use `Vfs.Target.Path` for path options such as `followFinalSymlink`:

  ```ts
  // Before
  const work = yield * fs.lookupReference(root, encoder.encode("work"))
  const metadata = yield * fs.lstat("/link")

  // After
  const work = yield * fs.lookup(Vfs.Entry(root, "work"))
  const metadata = yield * fs.stat(
    Vfs.Target.Path({ path: "/link", followFinalSymlink: false })
  )
  ```

  `stat` now returns `Metadata` with a `revision`; `readDirectory` returns entries and a directory revision; `readLink` and `realPath` return bytes; `pread` returns `{ bytes, eof }`; and `access` returns the granted bits. Update callers that use the old return values. Match failures on `VfsError.code` and `operation`; `error.path` is now a `BytePath`.

  `Volume.layer`, `Caller.layer`, and the other volume layers replace manual service wiring. Volume construction no longer requires a `Crypto` service. Remove `CurrentFileSystem`, `makeCrypto`, and `layerCrypto` from applications that used them.

- [#219](https://github.com/lloydrichards/effect-virtual-fs/pull/219) [`fee1d21`](https://github.com/lloydrichards/effect-virtual-fs/commit/fee1d21dbc9cc0b2fed5a71dbd2ba7bbdf16f1d5) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Persistence errors now name the full entry point in `operation`, such as `CheckpointStore.load` instead of `load`. Update comparisons against `CheckpointError.operation` and `VfsError.operation`:

  ```ts
  // Before
  error.operation === "load"

  // After
  error.operation === "CheckpointStore.load"
  ```

  The live stores use names such as `SqliteLiveImageStore.loadOrCreate` and `R2LiveImageStore.loadOrCreate` instead of a bare store name.

### Patch Changes

- [#225](https://github.com/lloydrichards/effect-virtual-fs/pull/225) [`7a47c57`](https://github.com/lloydrichards/effect-virtual-fs/commit/7a47c571ee15d00db71f78164d1994e5344b65df) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Snapshot and live image bytes now use newline-delimited JSON. Bytes saved by earlier releases no longer load, even though the format header still says `version: 1`. Regenerate stored checkpoints and live images from their source volumes or fixtures before upgrading:

  ```ts
  const volume = yield * Vfs.fromFixture(fixture)
  yield * checkpoints.save("baseline", yield * volume.snapshot)
  ```

  `encodeSnapshotStream` and `decodeSnapshotSink` process snapshot bytes in chunks. Existing `encodeSnapshot` and `decodeSnapshot` calls still work with a single byte array:

  ```ts
  const bytes = yield * Vfs.encodeSnapshot(snapshot, limits)
  const decoded = yield * Stream.run(Stream.succeed(bytes), Vfs.decodeSnapshotSink(limits))
  ```

  `DecodeLimits` gains `maxLineBytes`, which defaults to `maxEncodedBytes`. `encodeSnapshot` now checks the same limits as decoding. Snapshot entries can also be read with `snapshotEntries(snapshot, root)` without restoring a volume.

- [#230](https://github.com/lloydrichards/effect-virtual-fs/pull/230) [`7e55719`](https://github.com/lloydrichards/effect-virtual-fs/commit/7e55719806017f42b4eb8cbd3b71630ae7b6e3ad) Thanks [@lloydrichards](https://github.com/lloydrichards)! - A late live-store commit no longer unfreezes a store that another commit froze.
- Updated dependencies [[`ed86941`](https://github.com/lloydrichards/effect-virtual-fs/commit/ed869410b0fddee9b74f981003614bde5688ba36), [`ee41936`](https://github.com/lloydrichards/effect-virtual-fs/commit/ee419360725c0d5ff8313c4f8e4544263b6b927c), [`967878b`](https://github.com/lloydrichards/effect-virtual-fs/commit/967878bd34e4e3d018c69d271108ff9cb7f5ef68), [`7e55719`](https://github.com/lloydrichards/effect-virtual-fs/commit/7e55719806017f42b4eb8cbd3b71630ae7b6e3ad), [`649dfbe`](https://github.com/lloydrichards/effect-virtual-fs/commit/649dfbea39e5c683ae1e1430775f18bbec60f815), [`1004c17`](https://github.com/lloydrichards/effect-virtual-fs/commit/1004c176e0fa5eeae1f31dab30e9fcfa43c7a868), [`730ce13`](https://github.com/lloydrichards/effect-virtual-fs/commit/730ce13d3f5514f9069887478ee12d36aaeafc58), [`c75d5f0`](https://github.com/lloydrichards/effect-virtual-fs/commit/c75d5f0693cd47aac6de183a59c296885ef93aec), [`c9ff94a`](https://github.com/lloydrichards/effect-virtual-fs/commit/c9ff94ab8edc5a75c60eac00aa6c9371b953face), [`0362a15`](https://github.com/lloydrichards/effect-virtual-fs/commit/0362a157405a9db3d8f13f555e300222167e356d), [`60e4a61`](https://github.com/lloydrichards/effect-virtual-fs/commit/60e4a6151704a81ca35b1c0cce13b5ddb70c3331), [`1585192`](https://github.com/lloydrichards/effect-virtual-fs/commit/15851928691c633845161471b2f6dab8f792d761), [`06a9086`](https://github.com/lloydrichards/effect-virtual-fs/commit/06a90860558f8231c5f9426ff212dad861d08d04), [`bfff016`](https://github.com/lloydrichards/effect-virtual-fs/commit/bfff016dc75b22473aa022455decc87f1c9887c2), [`c9cce23`](https://github.com/lloydrichards/effect-virtual-fs/commit/c9cce232b55f9bf24745a133527ba562afbc5743), [`7a47c57`](https://github.com/lloydrichards/effect-virtual-fs/commit/7a47c571ee15d00db71f78164d1994e5344b65df), [`45deedb`](https://github.com/lloydrichards/effect-virtual-fs/commit/45deedb3ff694ebd2c7037e85973030b634170dc), [`7e55719`](https://github.com/lloydrichards/effect-virtual-fs/commit/7e55719806017f42b4eb8cbd3b71630ae7b6e3ad)]:
  - @effect-vfs/core@0.6.0

## 0.5.0

### Minor Changes

- [`1be5c58`](https://github.com/lloydrichards/effect-virtual-fs/commit/1be5c589a430ea99646544e1af03be64b513e3c0) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Add an experimental R2 live image store for single-owner volumes, with conditional whole-image commits and restart validation.

### Patch Changes

- Updated dependencies [[`5750a62`](https://github.com/lloydrichards/effect-virtual-fs/commit/5750a621a08cfa2785b1c8818f2a1576187ba5e1)]:
  - @effect-vfs/core@0.5.0

## 0.4.0

### Minor Changes

- [#130](https://github.com/lloydrichards/effect-virtual-fs/pull/130) [`cd40df5`](https://github.com/lloydrichards/effect-virtual-fs/commit/cd40df5027a9b822093e7f79655caa8234b890e2) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Add a provider-neutral SQLite live-image Layer for bounded volumes. Applications supply the SQLite client and Effect platform services. Reopening after a process restart retains acknowledged file contents, names, hard links, and volume identity. Applications can supply `syncDatabaseDirectory` to sync the verified database parent during startup. The provider has not yet been qualified for operating-system crashes or power loss.

### Patch Changes

- [#141](https://github.com/lloydrichards/effect-virtual-fs/pull/141) [`e2524fd`](https://github.com/lloydrichards/effect-virtual-fs/commit/e2524fd14a81da454c45a99d285e1b66e89423cf) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Reduce SQLite live-image temporary-file growth and document rollback-journal space requirements.
- Updated dependencies [[`34b912a`](https://github.com/lloydrichards/effect-virtual-fs/commit/34b912ad2f9a9aa55d4b3d76fdc4d1bc98540539), [`9acfa79`](https://github.com/lloydrichards/effect-virtual-fs/commit/9acfa796e0a76686b91fcfb045ac5b5426ba337b), [`49313a0`](https://github.com/lloydrichards/effect-virtual-fs/commit/49313a0ddc0b5fca4d4d850f4ded4e1439435938), [`a1f3e76`](https://github.com/lloydrichards/effect-virtual-fs/commit/a1f3e76f3689b2095f4efb36ac0406da227b56bc), [`77daba8`](https://github.com/lloydrichards/effect-virtual-fs/commit/77daba8ed9cbc0c99e19beace63120834d1bba0e), [`f54cccc`](https://github.com/lloydrichards/effect-virtual-fs/commit/f54cccc7dd0fd581b86e568fda155f90b5a08842), [`ced5052`](https://github.com/lloydrichards/effect-virtual-fs/commit/ced5052b374a8b1235cc32826e408404ee0f296c), [`62e04d2`](https://github.com/lloydrichards/effect-virtual-fs/commit/62e04d27f813e98fa090df2c80822242bbd0c005)]:
  - @effect-vfs/core@0.4.0

## 0.3.1

### Patch Changes

- [#89](https://github.com/lloydrichards/effect-virtual-fs/pull/89) [`a533d31`](https://github.com/lloydrichards/effect-virtual-fs/commit/a533d3160c7d3c11941d16b998bb692cf9a759d6) Thanks [@lloydrichards](https://github.com/lloydrichards)! - The public API now carries compiled `@example` blocks, and the docs build executes them and asserts their printed output, so a snippet cannot drift from what the code actually does
- Updated dependencies [[`a533d31`](https://github.com/lloydrichards/effect-virtual-fs/commit/a533d3160c7d3c11941d16b998bb692cf9a759d6), [`3888ff3`](https://github.com/lloydrichards/effect-virtual-fs/commit/3888ff389f721f0cf6df7ffb080e5a719adee6b4), [`097ba94`](https://github.com/lloydrichards/effect-virtual-fs/commit/097ba948194efa164b98bf33ae923941e31c8933), [`3e7a58b`](https://github.com/lloydrichards/effect-virtual-fs/commit/3e7a58be83691603d8787c5fafe784937af02536), [`49c9990`](https://github.com/lloydrichards/effect-virtual-fs/commit/49c99900669e74a8f139e6628b09237a8c8775b8)]:
  - @effect-vfs/core@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [[`ca776e0`](https://github.com/lloydrichards/effect-virtual-fs/commit/ca776e0501a1ffe47989b05f64431eba97ca4d76), [`3dd7516`](https://github.com/lloydrichards/effect-virtual-fs/commit/3dd75165544e93e2898b6a25c3735e29465865df), [`111a8c4`](https://github.com/lloydrichards/effect-virtual-fs/commit/111a8c4035252c81eec392a534e8dcfc7b84dbe1), [`133cd1c`](https://github.com/lloydrichards/effect-virtual-fs/commit/133cd1ca6d99da5c8f4bdab391a34a5d32e9b5df)]:
  - @effect-vfs/core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [[`fdd20a8`](https://github.com/lloydrichards/effect-virtual-fs/commit/fdd20a815ca0a35c4c07eaa4678be8e9300c4d04), [`5b54bcb`](https://github.com/lloydrichards/effect-virtual-fs/commit/5b54bcb375d6391c808a096820b3d0f879d255b8)]:
  - @effect-vfs/core@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies [[`68d4902`](https://github.com/lloydrichards/effect-virtual-fs/commit/68d4902658ae2c95647216a829475269213a4473)]:
  - @effect-vfs/core@0.1.0
