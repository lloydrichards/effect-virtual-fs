---
"@effect-vfs/memory": minor
---

`TreeTransfer` can copy trees to and from an Effect `FileSystem`, including the host filesystem. Unsupported entries fail by default; set `unsupported: "skip"` to omit them and inspect the transfer report.

```ts
const source = TreeTransfer.fromCaller(workspace, "/dist")
yield * Stream.run(source, TreeTransfer.toFileSystem(fs, "./dist"))
```

`toFileSystem` rejects symbolic links that leave the copied tree unless `escaping: "allow"` is set.
