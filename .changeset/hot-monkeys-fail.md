---
"@effect-vfs/core": minor
"@effect-vfs/nfs": minor
---

Qualified live image stores can report their durability tier. The experimental writable NFS profile accepts only a volume that reports `survives-power-loss` and has an explicit identity policy.

For example, an application can qualify its single-gateway R2 store with `durability: "survives-power-loss"` and call `NfsServer.make({ volume, writable: true, peer, policy })`.
