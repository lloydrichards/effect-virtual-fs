---
"@effect-vfs/memory": patch
---

Restore child directory permissions before locking parent directories when an overwriting tree transfer fails or is interrupted.

Record root ownership before applying fallible metadata, and capture FileSystem root-file identity before writing contents. Root acquisition completes before accepting interruption, while FileSystem content writes remain interruptible. Failed root writes and metadata changes now remove the owned destination. FileSystem transfers also complete dangling symbolic-link roots when `escaping: "allow"` is selected.
