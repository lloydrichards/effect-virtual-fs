---
"@effect-vfs/core": patch
---

Concurrent `stat`, lookup, snapshot, and overlay observations no longer wait for one another, while pending mutations still take priority.
