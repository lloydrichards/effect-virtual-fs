---
"@effect-vfs/node": patch
---

Preserve the file position after an empty append so the next sequential read continues at the same byte.
