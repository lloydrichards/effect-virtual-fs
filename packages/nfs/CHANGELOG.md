# @effect-vfs/nfs

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
