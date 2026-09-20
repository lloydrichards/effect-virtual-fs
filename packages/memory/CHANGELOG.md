# @effect-vfs/memory

## 0.4.0

### Minor Changes

- [`49313a0`](https://github.com/lloydrichards/effect-virtual-fs/commit/49313a0ddc0b5fca4d4d850f4ded4e1439435938) Thanks [@lloydrichards](https://github.com/lloydrichards)! - `Volume.usage`, `watch`, `snapshot`, `caller`, and overlay observations now include `FsError` in their failure types. `MemoryFileSystem.bind` also exposes `FsError` if its volume is unavailable. In-memory volumes do not emit storage failures.

- [#139](https://github.com/lloydrichards/effect-virtual-fs/pull/139) [`f54cccc`](https://github.com/lloydrichards/effect-virtual-fs/commit/f54cccc7dd0fd581b86e568fda155f90b5a08842) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Volumes now bound work waiting for admission and retain a finite number of events per watch subscriber. An excess operation fails with retryable `VolumeBusy` before it changes the volume. A subscriber that loses events receives a `Rescan` change and must rescan; it can continue using the same core watch. Configure the limits with `maxPendingOperations` and `maxWatchEvents`.

  The memory `FileSystem.watch` stream ends on overflow with a platform error identified by `MemoryFileSystem.isWatchOverflow`. Open a new memory watch before rescanning its path. NFS maps `VolumeBusy` to `NFS4ERR_DELAY`; its public export remains read-only.

- [#109](https://github.com/lloydrichards/effect-virtual-fs/pull/109) [`47f0840`](https://github.com/lloydrichards/effect-virtual-fs/commit/47f08405376d8cd11ec49f0305ef15504c4814fc) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Add `MemoryFileSystem.makeCrypto` and `MemoryFileSystem.layerCrypto`, self-contained variants that carry their own `Crypto` implementation. An in-memory filesystem no longer needs a platform crypto layer:

  ```ts
  import { MemoryFileSystem } from "@effect-vfs/memory"
  import { Effect, FileSystem } from "effect"

  const program = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem

    return yield* fs.exists("/tmp")
  }).pipe(Effect.provide(MemoryFileSystem.layerCrypto))
  ```

  The built-in implementation mints the volume's identity and incarnation from a reproducible sequence, not a cryptographically secure one. `make` and `layer` are unchanged and still take a `Crypto.Crypto` service, so use those with `NodeCrypto`, `BunCrypto`, or your own implementation when those values must be unpredictable.

### Patch Changes

- Updated dependencies [[`34b912a`](https://github.com/lloydrichards/effect-virtual-fs/commit/34b912ad2f9a9aa55d4b3d76fdc4d1bc98540539), [`9acfa79`](https://github.com/lloydrichards/effect-virtual-fs/commit/9acfa796e0a76686b91fcfb045ac5b5426ba337b), [`49313a0`](https://github.com/lloydrichards/effect-virtual-fs/commit/49313a0ddc0b5fca4d4d850f4ded4e1439435938), [`a1f3e76`](https://github.com/lloydrichards/effect-virtual-fs/commit/a1f3e76f3689b2095f4efb36ac0406da227b56bc), [`77daba8`](https://github.com/lloydrichards/effect-virtual-fs/commit/77daba8ed9cbc0c99e19beace63120834d1bba0e), [`f54cccc`](https://github.com/lloydrichards/effect-virtual-fs/commit/f54cccc7dd0fd581b86e568fda155f90b5a08842), [`ced5052`](https://github.com/lloydrichards/effect-virtual-fs/commit/ced5052b374a8b1235cc32826e408404ee0f296c), [`62e04d2`](https://github.com/lloydrichards/effect-virtual-fs/commit/62e04d27f813e98fa090df2c80822242bbd0c005)]:
  - @effect-vfs/core@0.4.0

## 0.3.1

### Patch Changes

- [#89](https://github.com/lloydrichards/effect-virtual-fs/pull/89) [`a533d31`](https://github.com/lloydrichards/effect-virtual-fs/commit/a533d3160c7d3c11941d16b998bb692cf9a759d6) Thanks [@lloydrichards](https://github.com/lloydrichards)! - The public API now carries compiled `@example` blocks, and the docs build executes them and asserts their printed output, so a snippet cannot drift from what the code actually does
- Updated dependencies [[`a533d31`](https://github.com/lloydrichards/effect-virtual-fs/commit/a533d3160c7d3c11941d16b998bb692cf9a759d6), [`3888ff3`](https://github.com/lloydrichards/effect-virtual-fs/commit/3888ff389f721f0cf6df7ffb080e5a719adee6b4), [`097ba94`](https://github.com/lloydrichards/effect-virtual-fs/commit/097ba948194efa164b98bf33ae923941e31c8933), [`3e7a58b`](https://github.com/lloydrichards/effect-virtual-fs/commit/3e7a58be83691603d8787c5fafe784937af02536), [`49c9990`](https://github.com/lloydrichards/effect-virtual-fs/commit/49c99900669e74a8f139e6628b09237a8c8775b8)]:
  - @effect-vfs/core@0.3.1

## 0.3.0

### Patch Changes

- [`9b00200`](https://github.com/lloydrichards/effect-virtual-fs/commit/9b00200f954a7dee9aa3c2c4766c0fa8c2492410) Thanks [@lloydrichards](https://github.com/lloydrichards)! - `File` now rejects negative seeks without moving the cursor and validates `readAlloc` sizes without runtime coercion.
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
