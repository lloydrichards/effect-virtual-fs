---
"@effect-vfs/core": minor
"@effect-vfs/nfs": patch
---

`Caller` gains `setattr`, which changes a target's size, owner, mode and times as one change: every check passes before any attribute applies, so a failure changes nothing, and a success advances the revision once and publishes one `Update`. Invalid attributes fail first with `InvalidArgument` naming the attribute in `field`, then ownership failures (`NotPermitted`), then write-access failures (`AccessDenied`). The attributes apply as chown then chmod, so a requested mode keeps its setuid and setgid bits when the same call changes the owner. `expected: { revision }` makes the change conditional on the revision the caller last observed; a target that has moved on fails `StaleReference` naming `expected` and nothing applies. `truncate` now rejects a negative length before looking up the target.

```ts
const install = Effect.gen(function*() {
  const caller = yield* Vfs.Caller

  yield* caller.setattr("/bin/tool", { mode: 0o4755, owner: { uid: 0, gid: 0 } })
})
```

NFS SETATTR now applies all of its attributes or none, and on failure reports no attribute set. Like Linux knfsd, it clears setuid, and setgid when group execute is set, from a mode sent with an owner or group change on a non-directory, so a mode of `04755` sent with a new owner ends at `0755`. An owner or group equal to the current one counts as no change, as in knfsd: the owner may re-send a group it is not a member of, and it clears no set-ID bit. When another client changes the file between the owner check and the change, SETATTR checks again, up to three more times, then answers `NFS4ERR_DELAY`.
