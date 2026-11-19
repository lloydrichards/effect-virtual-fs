---
"@effect-vfs/persistence": minor
---

Store live filesystem images in PostgreSQL with an Effect PostgreSQL client.

Install the optional `@effect/sql-pg` peer and run the packaged PostgreSQL migration before opening a store.

```ts
import * as PgLiveImageStore from "@effect-vfs/persistence/PgLiveImageStore"
import * as PgClient from "@effect/sql-pg/PgClient"
import { ByteSize, Layer, Redacted } from "effect"

const Client = PgClient.layerFrom(PgClient.makeClient({
  url: Redacted.make("postgresql://localhost/app"),
  multiplex: false
}))
const store = PgLiveImageStore.layer({
  key: "workspace-123",
  maxImageBytes: ByteSize.mebibytes(4)
}).pipe(Layer.provide(Client))
```

Reserve one single-connection client for each store. Set its receive budget to at least `max(16 MiB, maxImageBytes + 90 bytes)`. Close the store and its client before reopening the store. PostgreSQL reports the `memory-only` guarantee, which is below the durability required for writable NFS.
