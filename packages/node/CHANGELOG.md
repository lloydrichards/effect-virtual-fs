# @effect-vfs/node

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

- Updated dependencies [[`3e205c4`](https://github.com/lloydrichards/effect-virtual-fs/commit/3e205c43672c2964b1bff930ca68051cbfb4a0d2), [`97d7ae2`](https://github.com/lloydrichards/effect-virtual-fs/commit/97d7ae293d70c800f1fca47db036458b88c82aaa), [`893381c`](https://github.com/lloydrichards/effect-virtual-fs/commit/893381c8df0a9decd25ac019357e76b50cebac35), [`730c02b`](https://github.com/lloydrichards/effect-virtual-fs/commit/730c02b1777c91c66b8a9441bbf1b47529fd8171), [`724d317`](https://github.com/lloydrichards/effect-virtual-fs/commit/724d317a1108f7df38d12b490c2dbbdf76559dbe)]:
  - @effect-vfs/core@0.10.0
