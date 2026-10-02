---
"@effect-vfs/core": patch
---

Durable handle cleanup persists reclaimed space even when the pending-operation limit is full, and stops the volume if persistence fails.
