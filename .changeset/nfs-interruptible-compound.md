---
"@effect-vfs/nfs": patch
---

Bound server shutdown against a compound stalled between operations.

`compound` ran its whole body inside `Effect.uninterruptible`. The read loop that calls it is forked into the server scope, so closing that scope interrupts the loop and awaits it — and an interrupt cannot enter an uninterruptible region. A VFS operation that never settled, such as a `READ` against a stalled backing store, held scope closure open indefinitely.

The blanket region is now a mask, and each operation in the compound is dispatched through `restore`. The sweep, the compound parse, the replay-cache hit path, and the replay-slot commit stay uninterruptible, so a compound can be abandoned between operations but never torn in half. An interrupt restores the slot's sequence ID, cached reply, and retained byte accounting, so the client's retry is accepted as a first attempt rather than refused as misordered or as a false retry.

`CLOSE` and client revocation now drop an open from the open map inside the same uninterruptible region as the handle close. Previously the deletion sat outside that region in both, so an interrupt delivered at the boundary left a closed handle in the map for the handler scope's finalizer to close a second time.

The boundary this sets is between operations: an operation that mutates server state guards itself within its own operation. Shutdown is therefore bounded by the longest single operation, not by the compound. Two paths remain unbounded, both for the same reason — an export call that never settles: one operation's own uninterruptible region, and the periodic lease sweep, which runs uninterruptibly and closes each expired client's opens. A deadline on export calls would bound both and remains open.
