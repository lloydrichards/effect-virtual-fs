---
"@effect-vfs/persistence": minor
---

R2 live-image stores now enforce the configured image limit during S3 reads. Custom transports can provide an optional `readBounded` operation to enforce the same limit.
