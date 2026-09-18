---
"@effect-vfs/core": minor
---

Volumes now expose an ordered durability level, a stable logical identity, and a fresh incarnation for each construction.

Volume construction now requires an Effect `Crypto.Crypto` service so identities come from an explicit platform entropy source. For example:

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Effect } from "effect"

const volume = Vfs.make().pipe(Effect.provide(BunCrypto.layer))
```
