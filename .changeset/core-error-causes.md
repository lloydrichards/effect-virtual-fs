---
"@effect-vfs/core": minor
---

A `VfsError` now carries the failure it classifies as `cause`, such as the Schema error behind an `InvalidArgument` or the image error behind a rejected live commit. The cause appears wherever the error is logged, serialized, or pretty-printed, and an error that carries one no longer compares `Equal` to a copy built without it, so match on `code` and `operation` instead. An interrupted mutation on a live volume no longer leaves its uncommitted changes visible to later reads.
