# @effect-vfs/core

## 0.3.1

### Patch Changes

- [#89](https://github.com/lloydrichards/effect-virtual-fs/pull/89) [`a533d31`](https://github.com/lloydrichards/effect-virtual-fs/commit/a533d3160c7d3c11941d16b998bb692cf9a759d6) Thanks [@lloydrichards](https://github.com/lloydrichards)! - The public API now carries compiled `@example` blocks, and the docs build executes them and asserts their printed output, so a snippet cannot drift from what the code actually does

- [#100](https://github.com/lloydrichards/effect-virtual-fs/pull/100) [`3888ff3`](https://github.com/lloydrichards/effect-virtual-fs/commit/3888ff389f721f0cf6df7ffb080e5a719adee6b4) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Snapshot records now use `_tag` as their variant discriminator, and timestamp decoding accepts bounded alternate bigint spellings.

- [#81](https://github.com/lloydrichards/effect-virtual-fs/pull/81) [`097ba94`](https://github.com/lloydrichards/effect-virtual-fs/commit/097ba948194efa164b98bf33ae923941e31c8933) Thanks [@lloydrichards](https://github.com/lloydrichards)! - `applySnapshotDelta` now orders directory entries by byte value regardless of the runtime.

  Applied snapshots previously sorted entry names with `localeCompare`, so the same delta could yield differently ordered entries on ICU and non-ICU Node builds. Entries now follow the byte order used everywhere else in the delta layer. Deltas themselves are unaffected, since they never carried entry order.

- [#86](https://github.com/lloydrichards/effect-virtual-fs/pull/86) [`3e7a58b`](https://github.com/lloydrichards/effect-virtual-fs/commit/3e7a58be83691603d8787c5fafe784937af02536) Thanks [@lloydrichards](https://github.com/lloydrichards)! - `FsError` and `ConfigurationError` now carry a message, so a failed cause reads as more than a bare tag.

  `FsError` reports the operation and code, for example `open failed with NotFound`; it deliberately omits the path, which may be raw bytes or caller data. `ConfigurationError` names the option it rejected.

- [`49c9990`](https://github.com/lloydrichards/effect-virtual-fs/commit/49c99900669e74a8f139e6628b09237a8c8775b8) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Metadata and symlink failures now name the path the caller passed.

  A denied `utimes` reported its path as `/`, because the authorization call passed a hard-coded root. It now carries the caller's path, or omits it when the target is a handle, matching `chmod`. Resolving through a symlink whose target breaks a per-component length limit reported the synthetic expansion of that target rather than the path under traversal, so a link with an over-long component reported the target instead of the link.

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
