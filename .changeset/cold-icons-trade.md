---
"@effect-vfs/core": minor
"@effect-vfs/persistence": patch
---

`LiveVolume.makeRegistry` shares live volumes by storage identity across independent scopes, with optional idle reuse and an entry limit.

```ts
const registry = yield * LiveVolume.makeRegistry({
  store: storeForCanonicalIdentity,
  volume: options,
  capacity: 8,
  idleTimeToLive: "5 seconds"
})
const volume = yield * registry.get("workspace")
```

SQLite live stores release their exclusive lock before closing the client, so a registry can reopen the database without waiting for garbage collection on Bun 1.2.21.
