---
"@effect-vfs/core": patch
---

Live-volume mutations no longer copy the whole tree before committing, and objects changed by one operation now report the same revision.
