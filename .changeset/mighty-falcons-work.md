---
"@effect-vfs/memory": patch
---

Keep both the copy failure and cleanup defect when FileSystem.copy fails, and guard cleanup against replaced destination entries. Preserve overwrite copies into root and dot-ending directory destinations.
