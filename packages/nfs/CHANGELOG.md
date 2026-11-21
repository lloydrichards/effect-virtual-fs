# @effect-vfs/nfs

## 0.12.1

### Patch Changes

- [#432](https://github.com/lloydrichards/effect-virtual-fs/pull/432) [`85bd3f6`](https://github.com/lloydrichards/effect-virtual-fs/commit/85bd3f60ac811fdc1789bb953137de757b944045) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Require Effect 4.1.5 or a later 4.1 patch release. PostgreSQL and Cloudflare D1 users also need the matching Effect SQL package.
- Updated dependencies [[`becb528`](https://github.com/lloydrichards/effect-virtual-fs/commit/becb528b323c2f32b4fd483d9e36c2c6d53a2e78), [`0c4e402`](https://github.com/lloydrichards/effect-virtual-fs/commit/0c4e40210bc8428e1f3f582d98d3499303405b23), [`87fbc99`](https://github.com/lloydrichards/effect-virtual-fs/commit/87fbc99b42df558c86a4d453647f4d0dab1a7e3b), [`fc6ffff`](https://github.com/lloydrichards/effect-virtual-fs/commit/fc6fffff868be7f7fe45b4b60af775a85af98a9f), [`85bd3f6`](https://github.com/lloydrichards/effect-virtual-fs/commit/85bd3f60ac811fdc1789bb953137de757b944045), [`0944870`](https://github.com/lloydrichards/effect-virtual-fs/commit/094487004196d52a8a0d23b94c4510202a06eb63), [`ae730fd`](https://github.com/lloydrichards/effect-virtual-fs/commit/ae730fd7a3ebba404628063b9d1fe882d1f698ba), [`c641e59`](https://github.com/lloydrichards/effect-virtual-fs/commit/c641e59e6f5e90c612d7070dcdb241de6beb4695), [`779494b`](https://github.com/lloydrichards/effect-virtual-fs/commit/779494b6467074fba689a25e3e1c9ff2b13a7ed8), [`1c72f69`](https://github.com/lloydrichards/effect-virtual-fs/commit/1c72f69f2d15b2c1b1c177ed85c0bf1c4b0d647f), [`029bcd2`](https://github.com/lloydrichards/effect-virtual-fs/commit/029bcd2aca61bf88196ca9905e78af06787f13dc), [`a762663`](https://github.com/lloydrichards/effect-virtual-fs/commit/a76266397b644fc52349d618ce9650f2568d238b), [`4ca778a`](https://github.com/lloydrichards/effect-virtual-fs/commit/4ca778ac15a19817266ba4d8ccb9a90bda25e8f5), [`9b2929e`](https://github.com/lloydrichards/effect-virtual-fs/commit/9b2929eee778b646ea723ae03c30de54410c9e19), [`6d8cc06`](https://github.com/lloydrichards/effect-virtual-fs/commit/6d8cc06e271b7cc7fcba688fe620578dee44b538), [`f2e5057`](https://github.com/lloydrichards/effect-virtual-fs/commit/f2e50570be86dc063092b6d20ea8e28744fa8ee2), [`32d6ce8`](https://github.com/lloydrichards/effect-virtual-fs/commit/32d6ce8c8140505df2a5dea74368db4583948075), [`04f520e`](https://github.com/lloydrichards/effect-virtual-fs/commit/04f520e832570dfe09601b2e2227ee2f861445ee), [`1cad38d`](https://github.com/lloydrichards/effect-virtual-fs/commit/1cad38d5ea44fe1027b61cf7f9bca9a376e4b4ad), [`20555af`](https://github.com/lloydrichards/effect-virtual-fs/commit/20555aff6abf4818e6b8d07786141a48e39c875c), [`f1882ea`](https://github.com/lloydrichards/effect-virtual-fs/commit/f1882eaeaff356ff57cf6700309b3e21b2c4539f), [`68e4b60`](https://github.com/lloydrichards/effect-virtual-fs/commit/68e4b60875851c4e1d8af9ccedc2da033f04e941)]:
  - @effect-vfs/core@0.12.1

## 0.12.0

### Minor Changes

- [#377](https://github.com/lloydrichards/effect-virtual-fs/pull/377) [`f9c5f6f`](https://github.com/lloydrichards/effect-virtual-fs/commit/f9c5f6f8e392c5ae35839bddfcc288b5a07d7b82) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Wait for the NFS listener to stop with `server.awaitTermination`. The effect fails with `NfsServerError` if the listener fails and succeeds on scoped shutdown.

  Run the effect in the scope that owns the server.

  ```ts
  const serve = Effect.scoped(Effect.gen(function*() {
    const server = yield* NfsServer.make({ volume, caller })

    yield* server.awaitTermination
  }))
  ```

  If you supply a custom `NfsServer` layer or fixture, include an `awaitTermination` effect in its service value.

### Patch Changes

- [#442](https://github.com/lloydrichards/effect-virtual-fs/pull/442) [`2bb88ca`](https://github.com/lloydrichards/effect-virtual-fs/commit/2bb88cadde8df06a436f9dd439df33f5c3fe1a63) Thanks [@lloydrichards](https://github.com/lloydrichards)! - NFS preserves client capacity when an EXCHANGE_ID reply exceeds the RPC record limit ([#440](https://github.com/lloydrichards/effect-virtual-fs/issues/440)).
- Updated dependencies [[`d71a8ba`](https://github.com/lloydrichards/effect-virtual-fs/commit/d71a8ba58464afbba59f68e54fcd68c9bda81bcf), [`dd9989d`](https://github.com/lloydrichards/effect-virtual-fs/commit/dd9989d1e69e53ef1f9b532168328828896acf6d), [`bf8f297`](https://github.com/lloydrichards/effect-virtual-fs/commit/bf8f29740412bfd42c793e8c1d73ad87c3d8c9fb)]:
  - @effect-vfs/core@0.12.0

## 0.11.1

### Patch Changes

- Updated dependencies [[`54d49ca`](https://github.com/lloydrichards/effect-virtual-fs/commit/54d49ca695f057b330b5522411d0c966f0052330), [`204e49c`](https://github.com/lloydrichards/effect-virtual-fs/commit/204e49c485ef90d1223cc5efe71c7456ace51a3f), [`758af16`](https://github.com/lloydrichards/effect-virtual-fs/commit/758af1616ea55623a3f37fdca13098d494496e6b), [`ce0e9f4`](https://github.com/lloydrichards/effect-virtual-fs/commit/ce0e9f4396628e5887614fc5de167739eb417a43), [`aadb459`](https://github.com/lloydrichards/effect-virtual-fs/commit/aadb4591ccb5173e262d68dca23a5c7af24f8633), [`f8a26b3`](https://github.com/lloydrichards/effect-virtual-fs/commit/f8a26b3fb1b8696c2fce2a9d1c06d042e89fb42a), [`8fcc724`](https://github.com/lloydrichards/effect-virtual-fs/commit/8fcc7249bcb09e3e0e4eeb65ebc648a40f190b8f)]:
  - @effect-vfs/core@0.11.1

## 0.11.0

### Minor Changes

- [#326](https://github.com/lloydrichards/effect-virtual-fs/pull/326) [`d29c273`](https://github.com/lloydrichards/effect-virtual-fs/commit/d29c273929be4c8be69633156319ad5be45b1b0f) Thanks [@wikirik-agent](https://github.com/wikirik-agent)! - Require Effect `~4.1.4`. Core, memory and NFS replace `Crypto` requirements with `Digest` and `SecureRandom`; persistence stores require `Digest`. Existing `NodeCrypto.layer` and `BunCrypto.layer` wiring continues to work.

  The memory filesystem and testing decorator now expose `readDirectoryEntries`.

### Patch Changes

- Updated dependencies [[`d29c273`](https://github.com/lloydrichards/effect-virtual-fs/commit/d29c273929be4c8be69633156319ad5be45b1b0f)]:
  - @effect-vfs/core@0.11.0

## 0.10.0

### Minor Changes

- [`97d7ae2`](https://github.com/lloydrichards/effect-virtual-fs/commit/97d7ae293d70c800f1fca47db036458b88c82aaa) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Require Effect 4.0.5 and support positioned reads, final-component `noFollow`, watch readiness, and permission-aware access checks.

  Explicit read positions accept nonnegative signed-64-bit bigint offsets, including EOF beyond Number.MAX_SAFE_INTEGER, without moving the cursor. Globbing propagates closed-caller and handle failures rather than returning an empty result. Denied link probes propagate without enabling globstar descent.

  Metadata device, inode, and link-count fields now use bigint. Keep these values as bigint when comparing identities, for example `info.dev === 0n`.

  Globbing now matches Unicode characters and absolute patterns, returns depth-first results, prunes exclusions before reading directories, and skips unreadable directories reached through wildcards. Named unreadable directories still fail. Directory reads may update access times. Sort returned paths explicitly when global ordering is required.

  Crypto provider failures are defects. Filesystem and storage I/O failures retain their domain errors. Continue providing the matching runtime `Crypto` layer; the unreleased service split remains deferred.

### Patch Changes

- [#325](https://github.com/lloydrichards/effect-virtual-fs/pull/325) [`e9ccff1`](https://github.com/lloydrichards/effect-virtual-fs/commit/e9ccff1798bc384ac001f8d120e227929f2629a3) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Qualify the filesystem packages against Effect 4.0.7 and update the persistence package's S3 client. Restrict Effect peers to the compatible 4.0 patch line while the newer crypto API requires a separate migration.

  Implement Effect's new `lstat` method in the memory adapter and its testing decorator.

  Follow Effect's updated finalizer failure semantics: when transfer or copy cleanup fails, the original failure remains in the cause as a defect alongside the cleanup defect. Failures without a cleanup defect remain typed failures.
- Updated dependencies [[`3e205c4`](https://github.com/lloydrichards/effect-virtual-fs/commit/3e205c43672c2964b1bff930ca68051cbfb4a0d2), [`97d7ae2`](https://github.com/lloydrichards/effect-virtual-fs/commit/97d7ae293d70c800f1fca47db036458b88c82aaa), [`893381c`](https://github.com/lloydrichards/effect-virtual-fs/commit/893381c8df0a9decd25ac019357e76b50cebac35), [`730c02b`](https://github.com/lloydrichards/effect-virtual-fs/commit/730c02b1777c91c66b8a9441bbf1b47529fd8171), [`e9ccff1`](https://github.com/lloydrichards/effect-virtual-fs/commit/e9ccff1798bc384ac001f8d120e227929f2629a3), [`724d317`](https://github.com/lloydrichards/effect-virtual-fs/commit/724d317a1108f7df38d12b490c2dbbdf76559dbe)]:
  - @effect-vfs/core@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [[`50d5587`](https://github.com/lloydrichards/effect-virtual-fs/commit/50d55877bfc4fc250d8d753cddf927218b39a3f7), [`b88efde`](https://github.com/lloydrichards/effect-virtual-fs/commit/b88efde0a818853a3575ca1d2c32e8c75fff5f4f), [`2fd33e4`](https://github.com/lloydrichards/effect-virtual-fs/commit/2fd33e458b1020ec8ac4f5123bbafafd234e7fa5), [`a1c7840`](https://github.com/lloydrichards/effect-virtual-fs/commit/a1c784077ca27bbbfed0b06ce3a71ab05c504c9e), [`ee57e86`](https://github.com/lloydrichards/effect-virtual-fs/commit/ee57e86544142324d9ad88179e2fe939580790e8)]:
  - @effect-vfs/core@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`d861a32`](https://github.com/lloydrichards/effect-virtual-fs/commit/d861a3202dae7b297559a5de4729f8a7191ee18d), [`33beb85`](https://github.com/lloydrichards/effect-virtual-fs/commit/33beb859f47965971b4275d93b6e2dd19c7e5ad6), [`7b8d32c`](https://github.com/lloydrichards/effect-virtual-fs/commit/7b8d32c2c85601159abf5544fa8cb2e4bbdbf4d6), [`c9c1678`](https://github.com/lloydrichards/effect-virtual-fs/commit/c9c167890271e21587ff3ab60f8d34f978d46f51), [`8c410e7`](https://github.com/lloydrichards/effect-virtual-fs/commit/8c410e7877cf81f0fa1713d7eece13a9dd0caa0d)]:
  - @effect-vfs/core@0.8.0

## 0.7.1

### Patch Changes

- [#247](https://github.com/lloydrichards/effect-virtual-fs/pull/247) [`7beaeab`](https://github.com/lloydrichards/effect-virtual-fs/commit/7beaeabc3b003076bb3f208d1a387fc82eca3030) Thanks [@lloydrichards](https://github.com/lloydrichards)! - The packages now require stable Effect `^4.0.0` instead of `4.0.0-rc.117`. Update Effect and any platform or SQLite driver packages to `4.0.0` together. SQL consumers now import `SqlClient` from `effect/sql/SqlClient`.
- Updated dependencies [[`7beaeab`](https://github.com/lloydrichards/effect-virtual-fs/commit/7beaeabc3b003076bb3f208d1a387fc82eca3030)]:
  - @effect-vfs/core@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [[`68613c2`](https://github.com/lloydrichards/effect-virtual-fs/commit/68613c2704de6b238bad4306088f7f0727e561e3)]:
  - @effect-vfs/core@0.7.0

## 0.6.0

### Minor Changes

- [#216](https://github.com/lloydrichards/effect-virtual-fs/pull/216) [`1004c17`](https://github.com/lloydrichards/effect-virtual-fs/commit/1004c176e0fa5eeae1f31dab30e9fcfa43c7a868) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Ownership failures now return `NotPermitted` (EPERM) instead of `AccessDenied` (EACCES). Mode-bit denials still return `AccessDenied`. If you handle ownership failures by error code, accept the new code:

  ```ts
  Effect.catchIf(
    (error) => error.code === "AccessDenied" || error.code === "NotPermitted",
    () => Effect.succeed(forbidden)
  )
  ```

  Exhaustive matches on `VfsError.code` also need a `NotPermitted` case. NFS maps it to `NFS4ERR_PERM` for CREATE, OPEN, and SETATTR; `MemoryFileSystem` maps it to `PermissionDenied`.

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

- [`0362a15`](https://github.com/lloydrichards/effect-virtual-fs/commit/0362a157405a9db3d8f13f555e300222167e356d) Thanks [@lloydrichards](https://github.com/lloydrichards)! - NFS filehandles now survive a server restart when the backing volume preserves committed data. Memory volumes still use volatile handles. Clients must still remount after a restart because sessions, opens, and locks remain volatile.

  `NfsServerLimits.maxFilehandles` is removed because the server no longer keeps a filehandle registry. Remove the option from server configuration:

  ```ts
  // Before
  NfsServer.make({ volume, caller, limits: { maxOpens: 8192, maxFilehandles: 65_536 } })

  // After
  NfsServer.make({ volume, caller, limits: { maxOpens: 8192 } })
  ```

  Filehandles issued by earlier releases now return `NFS4ERR_BADHANDLE`. Update any client that stores filehandles across a server upgrade.

### Patch Changes

- [#230](https://github.com/lloydrichards/effect-virtual-fs/pull/230) [`7e55719`](https://github.com/lloydrichards/effect-virtual-fs/commit/7e55719806017f42b4eb8cbd3b71630ae7b6e3ad) Thanks [@lloydrichards](https://github.com/lloydrichards)! - NFS SETATTR now applies all requested attributes together or leaves the object unchanged on failure.
- Updated dependencies [[`ed86941`](https://github.com/lloydrichards/effect-virtual-fs/commit/ed869410b0fddee9b74f981003614bde5688ba36), [`ee41936`](https://github.com/lloydrichards/effect-virtual-fs/commit/ee419360725c0d5ff8313c4f8e4544263b6b927c), [`967878b`](https://github.com/lloydrichards/effect-virtual-fs/commit/967878bd34e4e3d018c69d271108ff9cb7f5ef68), [`7e55719`](https://github.com/lloydrichards/effect-virtual-fs/commit/7e55719806017f42b4eb8cbd3b71630ae7b6e3ad), [`649dfbe`](https://github.com/lloydrichards/effect-virtual-fs/commit/649dfbea39e5c683ae1e1430775f18bbec60f815), [`1004c17`](https://github.com/lloydrichards/effect-virtual-fs/commit/1004c176e0fa5eeae1f31dab30e9fcfa43c7a868), [`730ce13`](https://github.com/lloydrichards/effect-virtual-fs/commit/730ce13d3f5514f9069887478ee12d36aaeafc58), [`c75d5f0`](https://github.com/lloydrichards/effect-virtual-fs/commit/c75d5f0693cd47aac6de183a59c296885ef93aec), [`c9ff94a`](https://github.com/lloydrichards/effect-virtual-fs/commit/c9ff94ab8edc5a75c60eac00aa6c9371b953face), [`0362a15`](https://github.com/lloydrichards/effect-virtual-fs/commit/0362a157405a9db3d8f13f555e300222167e356d), [`60e4a61`](https://github.com/lloydrichards/effect-virtual-fs/commit/60e4a6151704a81ca35b1c0cce13b5ddb70c3331), [`1585192`](https://github.com/lloydrichards/effect-virtual-fs/commit/15851928691c633845161471b2f6dab8f792d761), [`06a9086`](https://github.com/lloydrichards/effect-virtual-fs/commit/06a90860558f8231c5f9426ff212dad861d08d04), [`bfff016`](https://github.com/lloydrichards/effect-virtual-fs/commit/bfff016dc75b22473aa022455decc87f1c9887c2), [`c9cce23`](https://github.com/lloydrichards/effect-virtual-fs/commit/c9cce232b55f9bf24745a133527ba562afbc5743), [`7a47c57`](https://github.com/lloydrichards/effect-virtual-fs/commit/7a47c571ee15d00db71f78164d1994e5344b65df), [`45deedb`](https://github.com/lloydrichards/effect-virtual-fs/commit/45deedb3ff694ebd2c7037e85973030b634170dc), [`7e55719`](https://github.com/lloydrichards/effect-virtual-fs/commit/7e55719806017f42b4eb8cbd3b71630ae7b6e3ad)]:
  - @effect-vfs/core@0.6.0

## 0.5.0

### Minor Changes

- [#155](https://github.com/lloydrichards/effect-virtual-fs/pull/155) [`5750a62`](https://github.com/lloydrichards/effect-virtual-fs/commit/5750a621a08cfa2785b1c8818f2a1576187ba5e1) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Qualified live image stores can report their durability tier. The experimental writable NFS profile accepts only a volume that reports `survives-power-loss` and has an explicit identity policy.

  For example, an application can qualify its single-gateway R2 store with `durability: "survives-power-loss"` and call `NfsServer.make({ volume, writable: true, peer, policy })`.

### Patch Changes

- [`7a0a8f6`](https://github.com/lloydrichards/effect-virtual-fs/commit/7a0a8f6b42fed2713be309fbdcd4972dd8f5f384) Thanks [@lloydrichards](https://github.com/lloydrichards)! - NFS ACCESS now reports write permission for mapped callers when the volume permits it.
- Updated dependencies [[`5750a62`](https://github.com/lloydrichards/effect-virtual-fs/commit/5750a621a08cfa2785b1c8818f2a1576187ba5e1)]:
  - @effect-vfs/core@0.5.0

## 0.4.0

### Minor Changes

- [#150](https://github.com/lloydrichards/effect-virtual-fs/pull/150) [`b8574c5`](https://github.com/lloydrichards/effect-virtual-fs/commit/b8574c582d011248e92eeb0388d59e6cc125978b) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Publish @effect-vfs/nfs as a read-only NFSv4.1 beta. Local read-only export has preview evidence; trusted-network export remains experimental. Mutations still return NFS4ERR_ROFS.

- [#119](https://github.com/lloydrichards/effect-virtual-fs/pull/119) [`c051736`](https://github.com/lloydrichards/effect-virtual-fs/commit/c0517366e031eca758ad1e705a499b32bb4bcc43) Thanks [@lloydrichards](https://github.com/lloydrichards)! - The NFS export now supports advisory byte-range read locks. Clients can acquire a lock through an open stateid, release an exact range with `LOCKU`, and recover capacity when a lease expires. Configure `maxLockOwners` and `maxLocks` to bound the in-memory state; write-lock requests still return `NFS4ERR_ROFS`.

### Patch Changes

- [#131](https://github.com/lloydrichards/effect-virtual-fs/pull/131) [`1fc5569`](https://github.com/lloydrichards/effect-virtual-fs/commit/1fc5569213499fd85aac7907781abfe47b77e384) Thanks [@lloydrichards](https://github.com/lloydrichards)! - NFS retries no longer rerun a state change when its reply is lost or cancellation arrives. See [#123](https://github.com/lloydrichards/effect-virtual-fs/issues/123).

- [#139](https://github.com/lloydrichards/effect-virtual-fs/pull/139) [`f54cccc`](https://github.com/lloydrichards/effect-virtual-fs/commit/f54cccc7dd0fd581b86e568fda155f90b5a08842) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Volumes now bound work waiting for admission and retain a finite number of events per watch subscriber. An excess operation fails with retryable `VolumeBusy` before it changes the volume. A subscriber that loses events receives a `Rescan` change and must rescan; it can continue using the same core watch. Configure the limits with `maxPendingOperations` and `maxWatchEvents`.

  The memory `FileSystem.watch` stream ends on overflow with a platform error identified by `MemoryFileSystem.isWatchOverflow`. Open a new memory watch before rescanning its path. NFS maps `VolumeBusy` to `NFS4ERR_DELAY`; its public export remains read-only.

- [#118](https://github.com/lloydrichards/effect-virtual-fs/pull/118) [`f68f12b`](https://github.com/lloydrichards/effect-virtual-fs/commit/f68f12b335770a787f73eda039628ae521f2028f) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Repeated NFS `OPEN` requests now respect share deny modes held by the same open owner.
- Updated dependencies [[`34b912a`](https://github.com/lloydrichards/effect-virtual-fs/commit/34b912ad2f9a9aa55d4b3d76fdc4d1bc98540539), [`9acfa79`](https://github.com/lloydrichards/effect-virtual-fs/commit/9acfa796e0a76686b91fcfb045ac5b5426ba337b), [`49313a0`](https://github.com/lloydrichards/effect-virtual-fs/commit/49313a0ddc0b5fca4d4d850f4ded4e1439435938), [`a1f3e76`](https://github.com/lloydrichards/effect-virtual-fs/commit/a1f3e76f3689b2095f4efb36ac0406da227b56bc), [`77daba8`](https://github.com/lloydrichards/effect-virtual-fs/commit/77daba8ed9cbc0c99e19beace63120834d1bba0e), [`f54cccc`](https://github.com/lloydrichards/effect-virtual-fs/commit/f54cccc7dd0fd581b86e568fda155f90b5a08842), [`ced5052`](https://github.com/lloydrichards/effect-virtual-fs/commit/ced5052b374a8b1235cc32826e408404ee0f296c), [`62e04d2`](https://github.com/lloydrichards/effect-virtual-fs/commit/62e04d27f813e98fa090df2c80822242bbd0c005)]:
  - @effect-vfs/core@0.4.0

## 0.1.0

### Minor Changes

- [#78](https://github.com/lloydrichards/effect-virtual-fs/pull/78) [`9d41ab8`](https://github.com/lloydrichards/effect-virtual-fs/commit/9d41ab8a7a8982e49a8e007e153373a2ed11562f) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Refuse RPCSEC_GSS credentials with `AUTH_TOOWEAK` and accept UNIX-domain socket addresses.

  RPCSEC_GSS is a flavor the server recognises but does not implement, so it now answers `AUTH_TOOWEAK` instead of `AUTH_BADCRED`; unknown or malformed flavors keep `AUTH_BADCRED`. `NfsServer.make` accepts a socket bound to a UNIX-domain socket path as a local address alongside loopback TCP. `NfsServerAddress` is now a union of `NfsServerTcpAddress` and `NfsServerUnixAddress`, so code reading `address.host` or `address.port` must narrow on `"path" in address` first.

  ```ts
  const listening = "path" in server.address
    ? server.address.path
    : `${server.address.host}:${String(server.address.port)}`
  ```

- [#62](https://github.com/lloydrichards/effect-virtual-fs/pull/62) [`aa6fa54`](https://github.com/lloydrichards/effect-virtual-fs/commit/aa6fa54d6c3a340dffb5a1d56bf4be706f83210e) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Complete the required read-only NFSv4.1 operation set for the `read-only-local` profile.

### Patch Changes

- [#102](https://github.com/lloydrichards/effect-virtual-fs/pull/102) [`92f2f0f`](https://github.com/lloydrichards/effect-virtual-fs/commit/92f2f0fa3c1c6d1728d85a0c4e3b68bd5dab4416) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Bound server shutdown against a compound stalled between operations.

  `compound` ran its whole body inside `Effect.uninterruptible`. The read loop that calls it is forked into the server scope, so closing that scope interrupts the loop and awaits it — and an interrupt cannot enter an uninterruptible region. A VFS operation that never settled, such as a `READ` against a stalled backing store, held scope closure open indefinitely.

  The blanket region is now a mask, and each operation in the compound is dispatched through `restore`. The sweep, the compound parse, the replay-cache hit path, and the replay-slot commit stay uninterruptible, so a compound can be abandoned between operations but never torn in half. An interrupt restores the slot's sequence ID, cached reply, and retained byte accounting, so the client's retry is accepted as a first attempt rather than refused as misordered or as a false retry.

  `CLOSE` and client revocation now drop an open from the open map inside the same uninterruptible region as the handle close. Previously the deletion sat outside that region in both, so an interrupt delivered at the boundary left a closed handle in the map for the handler scope's finalizer to close a second time.

  The boundary this sets is between operations: an operation that mutates server state guards itself within its own operation. Shutdown is therefore bounded by the longest single operation, not by the compound. Two paths remain unbounded, both for the same reason — an export call that never settles: one operation's own uninterruptible region, and the periodic lease sweep, which runs uninterruptibly and closes each expired client's opens. A deadline on export calls would bound both and remains open.

- [#67](https://github.com/lloydrichards/effect-virtual-fs/pull/67) [`74ae72e`](https://github.com/lloydrichards/effect-virtual-fs/commit/74ae72e3b9d96479e1d84817eb3ca6f6c90e3b0f) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Graduate the `read-only-local` profile from `experimental` to `preview`.

  The profile now has the repeatable Linux kernel-client evidence that `preview` requires, alongside the existing pinned pynfs run and the documented macOS 26 mount. An opt-in privileged mount gate mounts the preview app with `nfsvers=4.1`, runs sixteen read-side checks, and confirms that a bare mount still ladders down from 4.2 to 4.1. The server's behavior is unchanged; this is a change in how well that behavior is evidenced.

- [#94](https://github.com/lloydrichards/effect-virtual-fs/pull/94) [`1a0affe`](https://github.com/lloydrichards/effect-virtual-fs/commit/1a0affee45f0bc10185380eeea71baa55fa6a819) Thanks [@lloydrichards](https://github.com/lloydrichards)! - Stop a departing connection from waiting on an in-flight compound, and reclaim expired leases without another client's traffic.

  The connection finalizer no longer takes the handler's state gate. `Effect.ensuring` runs a finalizer uninterruptibly and `Semaphore.withPermits` waits via `restore`, so a finalizer that took the gate could not be interrupted out of the wait and was held for as long as another connection's compound ran.

  Expired lease state is now swept on the handler's own schedule rather than only when some other client sends a compound. An abandoned client's opens and retained replay bytes previously stayed charged until the handler scope closed, and because replay bytes come out of a global budget, enough abandoned sessions would refuse replay caching to healthy clients.
