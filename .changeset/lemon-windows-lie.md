---
"@effect-vfs/nfs": minor
---

The NFS export now supports advisory byte-range read locks. Clients can acquire a lock through an open stateid, release an exact range with `LOCKU`, and recover capacity when a lease expires. Configure `maxLockOwners` and `maxLocks` to bound the in-memory state; write-lock requests still return `NFS4ERR_ROFS`.
