---
"@effect-vfs/core": minor
---

File, directory, and handle reads now use relatime: they refresh access time when it is no newer than modification or status-change time, or when it is at least 24 hours old. Repeated reads that do not refresh access time avoid a live-image commit.

```ts
const first = yield * caller.readFile("/notes")
const second = yield * caller.readFile("/notes") // no access-time update if relatime does not require one
```
