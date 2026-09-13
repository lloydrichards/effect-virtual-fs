---
"@effect-vfs/core": patch
---

Volume watch registration is now coordinated with mutations so committed events are not lost while a watcher starts.
