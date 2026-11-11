---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
"@effect-vfs/persistence": minor
"@effect-vfs/nfs": minor
"@effect-vfs/node": minor
---

Require Effect 4.1, whose `Digest` and `SecureRandom` services replace `Crypto`.

Volume constructors and layers, snapshot deltas, `TreeTransfer.toVolume` and the NFS server now require `Digest.Digest | SecureRandom.SecureRandom` where they required `Crypto.Crypto`; the R2 and SQLite live image stores require only `Digest.Digest`. Identities, incarnations, epochs and reference-key secrets come from `SecureRandom`, and hashing from `Digest`, with unchanged bytes. `NodeCrypto.layer` and `BunCrypto.layer` provide both, so programs that already provide one keep working:

```ts
const program = Vfs.make().pipe(Effect.provide(NodeCrypto.layer))
```

`Digest.layerWebCrypto` and `SecureRandom.layerWebCrypto` provide them without a platform package. `BunServices.layer` does not include them.

The memory adapter supplies Effect 4.1's required `readDirectoryEntries` and keeps its portable glob, so glob results are unchanged. `FileSystemTesting.Handlers` gains a `readDirectoryEntries` handler; its glob traversal still passes through the `readDirectory`, `stat` and `readLink` handlers.
