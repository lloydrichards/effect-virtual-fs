---
"@effect-vfs/core": patch
---

Metadata and symlink failures now name the path the caller passed.

A denied `utimes` reported its path as `/`, because the authorization call passed a hard-coded root. It now carries the caller's path, or omits it when the target is a handle, matching `chmod`. Resolving through a symlink whose target breaks a per-component length limit reported the synthetic expansion of that target rather than the path under traversal, so a link with an over-long component reported the target instead of the link.
