---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
"@effect-vfs/nfs": minor
---

Ownership failures now return `NotPermitted` (EPERM) instead of `AccessDenied` (EACCES). Mode-bit denials still return `AccessDenied`. If you handle ownership failures by error code, accept the new code:

```ts
Effect.catchIf(
  (error) => error.code === "AccessDenied" || error.code === "NotPermitted",
  () => Effect.succeed(forbidden)
)
```

Exhaustive matches on `VfsError.code` also need a `NotPermitted` case. NFS maps it to `NFS4ERR_PERM` for CREATE, OPEN, and SETATTR; `MemoryFileSystem` maps it to `PermissionDenied`.
