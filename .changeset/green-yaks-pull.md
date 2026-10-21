---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
---

Add opt-in synchronous memory-volume execution. Cooperative scheduling remains the default; callers and handles share their volume's mode.

```ts
const volume = yield * Vfs.make({ execution: "sync" })
```

The same option works with fixture, snapshot and overlay constructors and the memory adapter's `layerFromFixture`. Sync mode rejects reentry with `VolumeBusy` and releases scoped ownership before the active operation returns. Live storage does not support this mode. Large operations can block the thread; construction, snapshot processing and stream consumption may still suspend. This does not add a native Node filesystem provider.
