---
"@effect-vfs/nfs": patch
---

Repeated NFS `OPEN` requests now respect share deny modes held by the same open owner.
