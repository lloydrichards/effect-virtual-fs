---
"@effect-vfs/memory": minor
---

TreeTransfer sinks now accept `required` preservation guarantees. Unsupported destination capabilities or disabled preservation options fail with `UnsupportedFidelity` before the destination changes. Existing options and defaults remain in effect.

```ts
const options: TreeTransfer.WriteOptions = {
  times: "all",
  required: { hardLinks: "exact", timestampPrecision: "nanosecond", times: "all" }
}
```

Caller transfers also preserve supplied symlink modes, and both live sinks apply a supplied access time with `times: "all"` when modification time is omitted.
