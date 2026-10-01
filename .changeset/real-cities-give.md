---
"@effect-vfs/core": patch
---

Durable handle cleanup now commits reclamation immediately, including when admission is full, and stops the volume if cleanup cannot be stored.
