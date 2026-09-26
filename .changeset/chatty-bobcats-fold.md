---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
---

Volume constructors and the memory filesystem layer now require an Effect Crypto service for secure volume identifiers and reference keys. Provide a platform Crypto layer when building these services, for example `Effect.provide(BunCrypto.layer)`.
