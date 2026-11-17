---
"@effect-vfs/persistence": minor
---

D1 live-image storage now supports bounded images through a supplied native Effect D1 client and explicit migrations.

Install the optional `@effect/sql-d1` peer and apply the packaged D1 migration before opening a store:

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

Applications enforce single ownership. Distinct store keys may share a primary-serving client while each store drains its own pending writes before handoff. The image cap is 1 MiB and the guarantee is `memory-only`.
