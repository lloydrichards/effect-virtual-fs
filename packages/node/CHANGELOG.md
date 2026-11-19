# @effect-vfs/node

## 0.3.2

### Patch Changes

- [#370](https://github.com/lloydrichards/effect-virtual-fs/pull/370) [`2d3063e`](https://github.com/lloydrichards/effect-virtual-fs/commit/2d3063ebcd2947ac346de6d2154a7e2012681958) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Node read methods infer strings, buffers, or directory entries from literal options ([#358](https://github.com/lloydrichards/effect-virtual-fs/issues/358)).
- Updated dependencies [[`d71a8ba`](https://github.com/lloydrichards/effect-virtual-fs/commit/d71a8ba58464afbba59f68e54fcd68c9bda81bcf), [`dd9989d`](https://github.com/lloydrichards/effect-virtual-fs/commit/dd9989d1e69e53ef1f9b532168328828896acf6d), [`bf8f297`](https://github.com/lloydrichards/effect-virtual-fs/commit/bf8f29740412bfd42c793e8c1d73ad87c3d8c9fb)]:
  - @effect-vfs/core@0.12.0

## 0.3.1

### Patch Changes

- [`eab681b`](https://github.com/lloydrichards/effect-virtual-fs/commit/eab681badcdf493235aedc48dc83f468743c3861) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Preserve the file position after an empty append so the next sequential read continues at the same byte.

- [`6323a58`](https://github.com/lloydrichards/effect-virtual-fs/commit/6323a58c6db4ee834c6917ee1ec7e95653f9dcb3) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Return the bytes already written when a later buffer in a vectored write reaches the volume or file size limit.
- Updated dependencies [[`54d49ca`](https://github.com/lloydrichards/effect-virtual-fs/commit/54d49ca695f057b330b5522411d0c966f0052330), [`204e49c`](https://github.com/lloydrichards/effect-virtual-fs/commit/204e49c485ef90d1223cc5efe71c7456ace51a3f), [`758af16`](https://github.com/lloydrichards/effect-virtual-fs/commit/758af1616ea55623a3f37fdca13098d494496e6b), [`ce0e9f4`](https://github.com/lloydrichards/effect-virtual-fs/commit/ce0e9f4396628e5887614fc5de167739eb417a43), [`aadb459`](https://github.com/lloydrichards/effect-virtual-fs/commit/aadb4591ccb5173e262d68dca23a5c7af24f8633), [`f8a26b3`](https://github.com/lloydrichards/effect-virtual-fs/commit/f8a26b3fb1b8696c2fce2a9d1c06d042e89fb42a), [`8fcc724`](https://github.com/lloydrichards/effect-virtual-fs/commit/8fcc7249bcb09e3e0e4eeb65ebc648a40f190b8f)]:
  - @effect-vfs/core@0.11.1

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
