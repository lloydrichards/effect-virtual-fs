---
"@effect-vfs/core": minor
---

Add reference-based mutation operations for changing filesystem objects and directory entries without resolving absolute paths.

Callers can now create, link, rename, remove, open, and modify objects relative to a live directory or object reference while receiving stable identities and directory revision transitions.

`Caller.removeReference` removes either a file or an empty directory in one coordinated operation. `Caller.mkdirReference` accepts `exactMode: true` with an explicit mode when the caller has already applied its umask.

`Caller.accessReference` checks permissions on an exact object without resolving a path.

`Caller.openChildReference` can set initial size and ownership atomically. Use `expectedChild: null` to require an absent entry, or pass a reference with its observed revision and timestamps to reject a changed child before opening or truncating it.
