---
"@effect-vfs/core": patch
"@effect-vfs/memory": patch
"@effect-vfs/nfs": patch
"@effect-vfs/persistence": patch
"@effect-vfs/node": patch
---

Qualify the filesystem packages against Effect 4.0.7 and update the persistence package's S3 client. Restrict Effect peers to the compatible 4.0 patch line while the newer crypto API requires a separate migration.

Implement Effect's new `lstat` method in the memory adapter and its testing decorator.

Follow Effect's updated finalizer failure semantics: when transfer or copy cleanup fails, the original failure remains in the cause as a defect alongside the cleanup defect. Failures without a cleanup defect remain typed failures.
