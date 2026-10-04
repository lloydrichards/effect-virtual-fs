---
"@effect-vfs/core": minor
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
