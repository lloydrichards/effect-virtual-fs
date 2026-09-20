---
"@effect-vfs/memory": patch
---

Prevent directory copies from writing through destination symlinks or copying root into a descendant. Report volume pressure as `Busy` and capacity rejection as `Unknown` with the core error retained as the cause.
