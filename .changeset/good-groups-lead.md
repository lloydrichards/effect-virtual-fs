---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
---

`Volume.usage`, `watch`, `snapshot`, `caller`, and overlay observations now include `FsError` in their failure types. `MemoryFileSystem.bind` also exposes `FsError` if its volume is unavailable. In-memory volumes do not emit storage failures.
