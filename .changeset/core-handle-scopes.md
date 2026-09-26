---
"@effect-vfs/core": patch
---

File and directory opens now release their handles when their scope closes during a pending open, and a `VolumeBusy` close remains retryable.
