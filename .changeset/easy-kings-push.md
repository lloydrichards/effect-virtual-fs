---
"@effect-vfs/persistence": minor
---

Store live filesystem images in Cloudflare D1 with an Effect D1 client.

Install the optional `@effect/sql-d1` peer and apply the packaged D1 migration before opening a store.

```ts
import * as D1LiveImageStore from "@effect-vfs/persistence/D1LiveImageStore"
import * as D1Client from "@effect/sql-d1/D1Client"
import { ByteSize, Layer } from "effect"

const store = (db: D1Client.D1ClientConfig["db"]) =>
  D1LiveImageStore.layer({
    key: "workspace-123",
    maxImageBytes: ByteSize.kibibytes(512)
  }).pipe(Layer.provide(D1Client.layer({ db })))
```

Keep one active owner per store key. Stores with distinct keys can share a client that serves requests from the primary. Drain each store’s pending writes before handoff. D1 caps images at 1 MiB and reports the `memory-only` guarantee.
