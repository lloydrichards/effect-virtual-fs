---
"@effect-vfs/memory": patch
---

Recursive `makeDirectory`, `readDirectory`, `glob` and `remove` run on the core tree operations: a recursive `makeDirectory` that fails partway creates nothing, recursive listings hold no directory handles and no longer refresh directory access times, `TreeTransfer.fromCaller` holds no directory handles and keeps its relatime reads, a recursive `remove` leaves a subtree another caller renames out of the path, and `remove` with `force` now fails when an entry below the path goes missing midway instead of reporting success over a partial tree.
