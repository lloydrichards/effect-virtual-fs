---
"@effect-vfs/persistence": minor
---

R2 live-image stores now take their client through an Effect layer. If you currently set `Options.client`, provide the client as a service when you build the store.

```ts
import * as R2Store from "@effect-vfs/persistence/R2Store"
import { ByteSize, Layer } from "effect"

const store = (client: R2Store.R2Client) =>
  R2Store.layer({
    key: "workspace-123",
    maxImageBytes: ByteSize.mebibytes(4)
  }).pipe(Layer.provide(Layer.succeed(R2Store.Client, client)))
```

The application owns the client. SQLite's supplied-client API is unchanged.

SQLite and R2 live-image stores now reject concurrent initialization, freeze after uncertain or cancelled writes, and return `InvalidArgument` for oversized initial input ([#238](https://github.com/lloydrichards/effect-virtual-fs/issues/238)).
