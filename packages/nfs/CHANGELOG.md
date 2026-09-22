# @effect-vfs/nfs

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
