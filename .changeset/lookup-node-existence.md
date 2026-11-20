---
"@effect-vfs/core": patch
"@effect-vfs/node": patch
---

Speed up mounted Node existence checks by looking up the path without building file stats.
