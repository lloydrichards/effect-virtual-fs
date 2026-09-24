---
"@effect-vfs/memory": minor
---

Add `TreeTransfer.fromFileSystem` and `TreeTransfer.toFileSystem`, which copy directory trees to and from any Effect `FileSystem`, such as the host filesystem. `toFileSystem` rejects symbolic links that leave the copied tree unless `escaping: "allow"` is set. Both fail on entries they cannot carry, such as non-UTF-8 names or FIFOs, unless `unsupported: "skip"` is set; skipped entries appear in the report. `TreeTransfer.SinkCapabilities` lists what each destination preserves.

```ts
import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { TreeTransfer } from "@effect-vfs/memory"
import { type FileSystem, Stream } from "effect"

const exportDist = (fs: FileSystem.FileSystem, workspace: Vfs.Caller) =>
  Stream.run(TreeTransfer.fromCaller(workspace, "/dist"), TreeTransfer.toFileSystem(fs, "./dist"))
```
