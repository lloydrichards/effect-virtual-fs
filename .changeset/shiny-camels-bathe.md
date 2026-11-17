---
"@effect-vfs/persistence": minor
---

SQLite and R2 live-image stores now reject concurrent initialization, freeze after uncertain or cancelled writes, and return `InvalidArgument` for oversized initial input ([#238](https://github.com/lloydrichards/effect-virtual-fs/issues/238)).

Breaking pre-1.0 change: R2 live-image layers now require the supplied client through Effect instead of `Options.client`.

Move the client into a provided service:

```ts
import { S3Client } from "@aws-sdk/client-s3"
import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
import { ByteSize, Layer } from "effect"

const s3 = new S3Client({
  region: "auto",
  endpoint: "https://ACCOUNT_ID.r2.cloudflarestorage.com",
  credentials: { accessKeyId: "ACCESS_KEY_ID", secretAccessKey: "SECRET_ACCESS_KEY" }
})
const R2ClientLayer = Layer.succeed(
  R2LiveImageStore.Client,
  R2LiveImageStore.fromS3(s3, "workspace-images")
)
const Store = R2LiveImageStore.layer({
  key: "workspace-123",
  maxImageBytes: ByteSize.mebibytes(4)
}).pipe(Layer.provide(R2ClientLayer))
```

The supplied transport remains application-owned. SQLite's supplied-client API is unchanged.
