---
"@effect-vfs/core": patch
---

`openDirectory` and `withDirectory` are now interrupted, as file opens already were, when their scope closes while they wait for the volume, instead of returning a handle that is already closed. On a live volume, a file open whose scope closes while its commit is pending is now interrupted and releases the file, instead of returning a handle that is never released and keeping an unlinked file's bytes charged. If that open created the file, including with `create: "exclusive"`, the file stays created, because its commit went through: a retry of an exclusive open reports `AlreadyExists`, and no later `open` of it through an entry reports `created: true`. Explicitly closing a handle also removes its cleanup from the scope that opened it.

A file close refused with `VolumeBusy` now leaves the handle open so the close can be retried, instead of releasing it and failing the retry with `InvalidHandle`. Scope cleanup releases a file handle even when the volume is busy or the close is interrupted.
