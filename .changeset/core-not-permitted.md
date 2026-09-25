---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
"@effect-vfs/nfs": minor
---

`VfsError` gains a `NotPermitted` code (EPERM) beside `AccessDenied` (EACCES). A non-owner `chmod` (including `writeFile`'s `finalMode`), `chown`, explicit or mixed `utimes` by a non-owner, removing another owner's entry from a sticky directory, and an unprivileged create with an explicit `owner` now fail `NotPermitted`. Mode-bit denials stay `AccessDenied`. `chmod` and `chown` failures now name the path.

NFS answers `NFS4ERR_PERM` for `NotPermitted` on CREATE, OPEN, and SETATTR, the operations whose RFC 8881 Section 15.2 lists include it, so a non-owner mode or explicit-times SETATTR no longer answers `NFS4ERR_ACCESS`. A sticky-directory REMOVE or RENAME still answers `NFS4ERR_ACCESS`. Memory maps it to `PermissionDenied` with the description `NotPermitted (EPERM)`.

### Migration

An exhaustive match over the code union needs a `NotPermitted` arm. Code that caught `AccessDenied` for ownership failures should catch both:

```ts
Effect.catchIf(
  (error) => error.code === "AccessDenied" || error.code === "NotPermitted",
  () => Effect.succeed(forbidden)
)
```
