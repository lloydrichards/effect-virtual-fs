---
"@effect-vfs/core": minor
"@effect-vfs/persistence": patch
---

`LiveVolume.makeRegistry` shares live volumes across scopes using canonical storage keys. Optional idle retention avoids reopening stores between borrowers.

```ts
import { LiveVolume } from "@effect-vfs/core"
import { ByteSize, Effect, Layer } from "effect"

// Each key must identify one canonical storage location.
declare const storeFor: (key: string) => Layer.Layer<LiveVolume.LiveImageStore>

const program = Effect.gen(function*() {
  const registry = yield* LiveVolume.makeRegistry({
    store: storeFor,
    volume: { maxImageBytes: ByteSize.megabytes(1), volume: {} },
    capacity: 8,
    idleTimeToLive: "5 seconds"
  })
  return yield* Effect.scoped(Effect.gen(function*() {
    const volume = yield* registry.get("workspace")
    const caller = yield* volume.caller()
    return yield* caller.stat("/")
  }))
}).pipe(Effect.scoped)
```

Keep the registry's scope open until all borrowers finish. Idle entries count toward capacity and retain storage locks.

SQLite live stores now release their exclusive lock before closing the client, allowing a registry to reopen the database on Bun 1.2.21.
