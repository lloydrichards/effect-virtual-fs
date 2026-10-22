---
"@effect-vfs/core": minor
"@effect-vfs/node": minor
---

Add `@effect-vfs/node`, a direct Node `VirtualProvider` over shared synchronous memory volumes, and the checked core adapter binding.

```ts
const volume = yield * Vfs.make({ execution: "sync" })
const provider = yield * NodeVirtualProvider.bind(volume)
provider.writeFileSync("/message.txt", "shared with Effect callers")
```

Binding is scoped. Handles preserve Node cursors, positioned I/O and open-unlinked lifetime. The initial profile targets Node 26.11.1 with `--experimental-vfs`; watches and mounted filesystem/loader integration remain outside this release's qualification.
