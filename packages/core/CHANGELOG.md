# @effect-vfs/core

## 0.3.0

### Minor Changes

- [`ca776e0`](https://github.com/lloydrichards/effect-virtual-fs/commit/ca776e0501a1ffe47989b05f64431eba97ca4d76) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Expose stable object references and coordinated mutation revisions for adapters that need path-independent identity and reliable cache invalidation.

- [`3dd7516`](https://github.com/lloydrichards/effect-virtual-fs/commit/3dd75165544e93e2898b6a25c3735e29465865df) Thanks [@lloydrichards](https://github.com/lloydrichards)! - `BytePath` values now support byte-wise Effect equality, hashing, and pipe composition.

- [`111a8c4`](https://github.com/lloydrichards/effect-virtual-fs/commit/111a8c4035252c81eec392a534e8dcfc7b84dbe1) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Opaque snapshot and snapshot-delta values now use Effect-style string TypeIds.

### Patch Changes

- [`133cd1c`](https://github.com/lloydrichards/effect-virtual-fs/commit/133cd1ca6d99da5c8f4bdab391a34a5d32e9b5df) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Volume watch registration is now coordinated with mutations so committed events are not lost while a watcher starts.

## 0.2.0

### Minor Changes

- [`fdd20a8`](https://github.com/lloydrichards/effect-virtual-fs/commit/fdd20a815ca0a35c4c07eaa4678be8e9300c4d04) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Create, inspect, Schema-encode, decode, and apply portable snapshot deltas with finite resource policies and Effect's
  platform-neutral `Crypto.Crypto` service for base identity.

  For example:

  ```ts
  const delta = yield * Vfs.diffSnapshots(base, target)
  const bytes = yield * Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())(delta)
  const restored = yield * Vfs.applySnapshotDelta(
    base,
    yield * Schema.decodeEffect(Vfs.SnapshotDeltaFromBytes())(bytes)
  )
  ```

- [`5b54bcb`](https://github.com/lloydrichards/effect-virtual-fs/commit/5b54bcb375d6391c808a096820b3d0f879d255b8) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Filesystem, snapshot, and snapshot-delta byte limits now use Effect's `ByteSize` type.

  Pass values such as `ByteSize.mebibytes(4)` instead of raw byte counts when configuring `VolumeOptions`,
  `Snapshot.DecodeLimits`, or `SnapshotDeltaLimits`.

## 0.1.0

### Minor Changes

- [`68d4902`](https://github.com/lloydrichards/effect-virtual-fs/commit/68d4902658ae2c95647216a829475269213a4473) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Add snapshot-based overlay workspaces with shared immutable file contents, final-difference summaries, and matching complete capture.
