---
"@effect-vfs/core": minor
---

Add reference-based mutation operations for changing filesystem objects and directory entries without resolving absolute paths.

Callers can now create, link, rename, remove, open, and modify objects relative to a live directory or object reference while receiving stable identities and directory revision transitions.
