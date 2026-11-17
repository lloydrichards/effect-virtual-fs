---
"@effect-vfs/persistence": minor
---

Import `@effect-vfs/persistence/R2Store` to use a custom R2 client without loading the AWS SDK. Import `fromS3` from `@effect-vfs/persistence/R2S3Transport` to adapt an AWS SDK client. The original `R2LiveImageStore` entrypoint continues to export both.
