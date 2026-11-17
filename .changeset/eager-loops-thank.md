---
"@effect-vfs/core": patch
---

Reuse cached snapshots after stat, access, and file-handle sync so repeated captures avoid rescanning unchanged files ([#365](https://github.com/lloydrichards/effect-virtual-fs/issues/365)).
