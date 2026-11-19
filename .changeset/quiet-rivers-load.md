---
"@effect-vfs/persistence": minor
---

Use R2 live-image storage with a custom client without loading the AWS SDK. Import `layer` and `Client` from `@effect-vfs/persistence/R2Store` to configure the store.

If you use the AWS SDK, import `fromS3` from `@effect-vfs/persistence/R2S3Transport` and call `fromS3(s3, bucket)`. The existing `R2LiveImageStore` entry point still exports both the store and adapter.
