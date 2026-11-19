---
"@effect-vfs/persistence": minor
---

R2 live-image stores enforce `maxImageBytes` while reading through the S3 adapter.

If you supply a custom R2 transport, implement the optional `readBounded(key, maxImageBytes)` operation to enforce the limit during the read.
