# @effect-vfs/node

## 0.3.3

### Patch Changes

- [#432](https://github.com/lloydrichards/effect-virtual-fs/pull/432) [`85bd3f6`](https://github.com/lloydrichards/effect-virtual-fs/commit/85bd3f60ac811fdc1789bb953137de757b944045) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Require Effect 4.1.5 or a later 4.1 patch release. PostgreSQL and Cloudflare D1 users also need the matching Effect SQL package.

- [#468](https://github.com/lloydrichards/effect-virtual-fs/pull/468) [`0944870`](https://github.com/lloydrichards/effect-virtual-fs/commit/094487004196d52a8a0d23b94c4510202a06eb63) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Speed up mounted Node existence checks by looking up the path without building file stats.

- [#446](https://github.com/lloydrichards/effect-virtual-fs/pull/446) [`11e7b1b`](https://github.com/lloydrichards/effect-virtual-fs/commit/11e7b1b4138d9668fa746dc8f97dc4f3fcfa1830) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Reduce temporary allocations when reading whole files through the Node virtual filesystem provider ([#443](https://github.com/lloydrichards/effect-virtual-fs/issues/443)).

- [#462](https://github.com/lloydrichards/effect-virtual-fs/pull/462) [`6c58ff7`](https://github.com/lloydrichards/effect-virtual-fs/commit/6c58ff76b60185f20e40994e4950c6a3c31cfa2a) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Reduce copying and peak memory when reading files through the built-in Node provider.

- [#457](https://github.com/lloydrichards/effect-virtual-fs/pull/457) [`4ca778a`](https://github.com/lloydrichards/effect-virtual-fs/commit/4ca778ac15a19817266ba4d8ccb9a90bda25e8f5) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Speed up mounted Node directory listings and whole-file reads.

- [#450](https://github.com/lloydrichards/effect-virtual-fs/pull/450) [`32d6ce8`](https://github.com/lloydrichards/effect-virtual-fs/commit/32d6ce8c8140505df2a5dea74368db4583948075) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Reduce path lookups for default whole-file reads through the Node virtual filesystem provider.

- [#458](https://github.com/lloydrichards/effect-virtual-fs/pull/458) [`f1882ea`](https://github.com/lloydrichards/effect-virtual-fs/commit/f1882eaeaff356ff57cf6700309b3e21b2c4539f) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Speed up typed and recursive directory listings on mounted Node filesystems.
- Updated dependencies [[`becb528`](https://github.com/lloydrichards/effect-virtual-fs/commit/becb528b323c2f32b4fd483d9e36c2c6d53a2e78), [`0c4e402`](https://github.com/lloydrichards/effect-virtual-fs/commit/0c4e40210bc8428e1f3f582d98d3499303405b23), [`87fbc99`](https://github.com/lloydrichards/effect-virtual-fs/commit/87fbc99b42df558c86a4d453647f4d0dab1a7e3b), [`fc6ffff`](https://github.com/lloydrichards/effect-virtual-fs/commit/fc6fffff868be7f7fe45b4b60af775a85af98a9f), [`85bd3f6`](https://github.com/lloydrichards/effect-virtual-fs/commit/85bd3f60ac811fdc1789bb953137de757b944045), [`0944870`](https://github.com/lloydrichards/effect-virtual-fs/commit/094487004196d52a8a0d23b94c4510202a06eb63), [`ae730fd`](https://github.com/lloydrichards/effect-virtual-fs/commit/ae730fd7a3ebba404628063b9d1fe882d1f698ba), [`c641e59`](https://github.com/lloydrichards/effect-virtual-fs/commit/c641e59e6f5e90c612d7070dcdb241de6beb4695), [`779494b`](https://github.com/lloydrichards/effect-virtual-fs/commit/779494b6467074fba689a25e3e1c9ff2b13a7ed8), [`1c72f69`](https://github.com/lloydrichards/effect-virtual-fs/commit/1c72f69f2d15b2c1b1c177ed85c0bf1c4b0d647f), [`029bcd2`](https://github.com/lloydrichards/effect-virtual-fs/commit/029bcd2aca61bf88196ca9905e78af06787f13dc), [`a762663`](https://github.com/lloydrichards/effect-virtual-fs/commit/a76266397b644fc52349d618ce9650f2568d238b), [`4ca778a`](https://github.com/lloydrichards/effect-virtual-fs/commit/4ca778ac15a19817266ba4d8ccb9a90bda25e8f5), [`9b2929e`](https://github.com/lloydrichards/effect-virtual-fs/commit/9b2929eee778b646ea723ae03c30de54410c9e19), [`6d8cc06`](https://github.com/lloydrichards/effect-virtual-fs/commit/6d8cc06e271b7cc7fcba688fe620578dee44b538), [`f2e5057`](https://github.com/lloydrichards/effect-virtual-fs/commit/f2e50570be86dc063092b6d20ea8e28744fa8ee2), [`32d6ce8`](https://github.com/lloydrichards/effect-virtual-fs/commit/32d6ce8c8140505df2a5dea74368db4583948075), [`04f520e`](https://github.com/lloydrichards/effect-virtual-fs/commit/04f520e832570dfe09601b2e2227ee2f861445ee), [`1cad38d`](https://github.com/lloydrichards/effect-virtual-fs/commit/1cad38d5ea44fe1027b61cf7f9bca9a376e4b4ad), [`20555af`](https://github.com/lloydrichards/effect-virtual-fs/commit/20555aff6abf4818e6b8d07786141a48e39c875c), [`f1882ea`](https://github.com/lloydrichards/effect-virtual-fs/commit/f1882eaeaff356ff57cf6700309b3e21b2c4539f), [`68e4b60`](https://github.com/lloydrichards/effect-virtual-fs/commit/68e4b60875851c4e1d8af9ccedc2da033f04e941)]:
  - @effect-vfs/core@0.12.1

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
