---
"@effect-vfs/memory": patch
---

`FileSystem.watch` follows the object its path resolves to: a watched directory keeps reporting after it or an ancestor is renamed instead of going quiet, the stream ends after the watched object is removed, a change that lands as the watch opens can no longer leave it following another object, and changes elsewhere in the volume no longer fill its queue.
