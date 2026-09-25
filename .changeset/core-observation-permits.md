---
"@effect-vfs/core": patch
---

Observations such as `stat`, lookups, `snapshot` and overlay `changes` no longer wait behind one another: they share the volume, while a mutation, a handle cleanup or a watch registration still runs alone and still waits behind a pending durable commit. A mutation waiting for the volume is not overtaken by observations that arrive after it. A watch registration whose scope closes before it completes now leaves no subscriber behind and returns an empty stream.
