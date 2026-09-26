---
"@effect-vfs/nfs": minor
---

NFS filehandles now survive a server restart when the backing volume preserves committed data. Memory volumes still use volatile handles. Clients must still remount after a restart because sessions, opens, and locks remain volatile.

`NfsServerLimits.maxFilehandles` is removed because the server no longer keeps a filehandle registry. Remove the option from server configuration:

```ts
// Before
NfsServer.make({ volume, caller, limits: { maxOpens: 8192, maxFilehandles: 65_536 } })

// After
NfsServer.make({ volume, caller, limits: { maxOpens: 8192 } })
```

Filehandles issued by earlier releases now return `NFS4ERR_BADHANDLE`. Update any client that stores filehandles across a server upgrade.
