---
"@effect-vfs/memory": minor
---

Add `TreeTransfer`, which streams directory trees between callers, snapshots, and new volumes. Sources emit core fixture entries rooted at the copied directory and enforce `TreeTransferLimits.default` unless given other limits. `toCaller` rejects an existing destination by default and removes the tree it created if the transfer fails. `toVolume` builds a new volume only when every entry is accepted, and keeps owners and special mode bits only when asked with `owner: true` and `specialBits: true`.

```ts
import type { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { TreeTransfer } from "@effect-vfs/memory"
import { Stream } from "effect"

const copy = (source: Vfs.Caller, workspace: Vfs.Caller) =>
  Stream.run(TreeTransfer.fromCaller(source, "/project"), TreeTransfer.toCaller(workspace, "/workspace"))
```

`MemoryFileSystem` `copy` now runs on the same engine. A copy without `overwrite` removes its partial destination on failure, and hard links inside a copied tree stay linked when overwriting.
