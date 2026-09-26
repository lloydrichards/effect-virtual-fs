---
"@effect-vfs/core": minor
---

`Caller.setattr` changes a target's size, owner, mode, and times in one operation. If any attribute fails validation or permission checks, none of the attributes change. Pass `expected: { revision }` to reject an update when the target has changed since you read it.

```ts
const metadata = yield * caller.stat("/bin/tool")
yield * caller.setattr("/bin/tool", {
  mode: 0o755,
  expected: { revision: metadata.revision }
})
```
