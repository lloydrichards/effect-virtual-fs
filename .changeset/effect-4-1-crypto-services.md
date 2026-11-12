---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
"@effect-vfs/persistence": minor
"@effect-vfs/nfs": minor
"@effect-vfs/node": minor
---

Require Effect `~4.1.4`. Core, memory and NFS replace `Crypto` requirements with `Digest` and `SecureRandom`; persistence stores require `Digest`. Existing `NodeCrypto.layer` and `BunCrypto.layer` wiring continues to work.

The memory filesystem and testing decorator now expose `readDirectoryEntries`.
