---
"@effect-vfs/persistence": minor
---

PostgreSQL live-image storage now supports explicit migrations and a supplied native Effect PostgreSQL client.

Install the optional `@effect/sql-pg` peer and run the packaged PostgreSQL migration before opening a store:

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

Supply a dedicated single-connection client per store. Do not share it with application queries or another store. Configure its receive budget for at least `max(16 MiB, maxImageBytes + 90 bytes)` and close both store and client before reopening. The v1 guarantee is `memory-only`, so writable NFS remains unavailable.
