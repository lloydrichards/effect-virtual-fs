---
"@effect-vfs/nfs": minor
---

Filehandles carry the object's core reference key, so over a volume whose commits survive at least a process crash they survive a server restart and `fh_expire_type` reports `FH4_PERSISTENT`. Memory volumes keep volatile handles, reported as `FH4_VOLATILE_ANY | FH4_NOEXPIRE_WITH_OPEN`, that answer `NFS4ERR_FHEXPIRED` after a restart. Sessions, opens and locks are still volatile, so clients still remount after a restart.

- **Handles.** A handle is 57 bytes: a version, the volume identity, the epoch, the inode number and the key's tag. A handle forged by changing another's inode number or tag answers `NFS4ERR_BADHANDLE`, as do handles issued by earlier releases.
- **No registry.** The export keeps no table of handles, so there is no handle capacity to exhaust and a create no longer answers `NFS4ERR_DELAY` for a full registry.
- **Statuses.** A handle from another volume answers `NFS4ERR_STALE` under persistent handles, `PUTFH` on a busy volume answers `NFS4ERR_DELAY` and any failure outside `PUTFH`'s RFC 8881 error list `NFS4ERR_SERVERFAULT`, and `GETFH` or the `filehandle` attribute of a removed object answers `NFS4ERR_STALE` where it used to return a handle.

### Migration

`NfsServerLimits.maxFilehandles` is removed from the schema, both presets and `NfsServerLimitOverrides`, and a server given it fails with a `ConfigurationError`. Delete the field:

```ts
// before
NfsServer.make({ volume, caller, limits: { maxOpens: 8192, maxFilehandles: 65_536 } })

// after
NfsServer.make({ volume, caller, limits: { maxOpens: 8192 } })
```
