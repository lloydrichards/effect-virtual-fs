---
"@effect-vfs/core": minor
---

`FsError` and `ImageError` now carry the failure they classify as `cause`, such as the Schema error behind an `InvalidArgument` or the image error behind a rejected live commit. The cause appears wherever these errors are logged, serialized, or pretty-printed, and an error that carries one no longer compares `Equal` to a copy built without it, so match on `code` and `operation` instead. An interrupted mutation on a live volume no longer leaves its uncommitted changes visible to later reads.
