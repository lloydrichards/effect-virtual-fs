# @effect-vfs/node

## 0.3.0

### Minor Changes

- [#326](https://github.com/lloydrichards/effect-virtual-fs/pull/326) [`d29c273`](https://github.com/lloydrichards/effect-virtual-fs/commit/d29c273929be4c8be69633156319ad5be45b1b0f) Thanks [@wikirik-agent](https://github.com/wikirik-agent)! - Require Effect `~4.1.4`. Core, memory and NFS replace `Crypto` requirements with `Digest` and `SecureRandom`; persistence stores require `Digest`. Existing `NodeCrypto.layer` and `BunCrypto.layer` wiring continues to work.

  The memory filesystem and testing decorator now expose `readDirectoryEntries`.

### Patch Changes

- Updated dependencies [[`d29c273`](https://github.com/lloydrichards/effect-virtual-fs/commit/d29c273929be4c8be69633156319ad5be45b1b0f)]:
  - @effect-vfs/core@0.11.0

## 0.2.0

### Minor Changes

- [`893381c`](https://github.com/lloydrichards/effect-virtual-fs/commit/893381c8df0a9decd25ac019357e76b50cebac35) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Add `@effect-vfs/node`, a direct Node `VirtualProvider` over shared synchronous memory volumes, and the checked core adapter binding.

  ```ts
  const volume = yield * Vfs.make({ execution: "sync" })
  const provider = yield * NodeVirtualProvider.bind(volume)
  provider.writeFileSync("/message.txt", "shared with Effect callers")
  ```

  Binding is scoped. Handles preserve Node cursors, positioned I/O and open-unlinked lifetime. The initial profile targets Node 26.11.1 with `--experimental-vfs`; watches and mounted filesystem/loader integration remain outside this release's qualification.

### Patch Changes

- [#325](https://github.com/lloydrichards/effect-virtual-fs/pull/325) [`e9ccff1`](https://github.com/lloydrichards/effect-virtual-fs/commit/e9ccff1798bc384ac001f8d120e227929f2629a3) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Qualify the filesystem packages against Effect 4.0.7 and update the persistence package's S3 client. Restrict Effect peers to the compatible 4.0 patch line while the newer crypto API requires a separate migration.

  Implement Effect's new `lstat` method in the memory adapter and its testing decorator.

  Follow Effect's updated finalizer failure semantics: when transfer or copy cleanup fails, the original failure remains in the cause as a defect alongside the cleanup defect. Failures without a cleanup defect remain typed failures.
- Updated dependencies [[`3e205c4`](https://github.com/lloydrichards/effect-virtual-fs/commit/3e205c43672c2964b1bff930ca68051cbfb4a0d2), [`97d7ae2`](https://github.com/lloydrichards/effect-virtual-fs/commit/97d7ae293d70c800f1fca47db036458b88c82aaa), [`893381c`](https://github.com/lloydrichards/effect-virtual-fs/commit/893381c8df0a9decd25ac019357e76b50cebac35), [`730c02b`](https://github.com/lloydrichards/effect-virtual-fs/commit/730c02b1777c91c66b8a9441bbf1b47529fd8171), [`e9ccff1`](https://github.com/lloydrichards/effect-virtual-fs/commit/e9ccff1798bc384ac001f8d120e227929f2629a3), [`724d317`](https://github.com/lloydrichards/effect-virtual-fs/commit/724d317a1108f7df38d12b490c2dbbdf76559dbe)]:
  - @effect-vfs/core@0.10.0
