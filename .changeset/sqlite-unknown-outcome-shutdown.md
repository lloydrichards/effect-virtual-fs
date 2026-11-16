---
"@effect-vfs/persistence": patch
---

Preserve `OutcomeUnknown` during shutdown when persistent SQLite I/O errors prevent a frozen live image store from releasing its exclusive lock.
