---
"@effect-vfs/core": minor
---

A `ReferenceKey` names an object outside the process: the volume identity, an epoch, the object's inode number, and a tag only the volume can compute. `volume.referenceKey(reference)` returns one and `volume.resolveReferenceKey(key)` returns the same reference traversal would. The schema carries the identity, epoch and tag as base64 and the inode number as a decimal string, so a key can be stored, sent and validated.

- **Epochs.** Every construction draws a new epoch, including `fromSnapshot`, `fromFixture` and `makeOverlay`, so a key never resolves in a restore or overlay, even under the same identity. A live volume keeps its epoch and secret across a reopen, so its keys resolve to the same objects after a restart.
- **Unguessable.** The tag is 16 bytes of HMAC-SHA-256 over the identity, epoch and inode number under a secret the volume draws with its epoch from `globalThis.crypto.getRandomValues`, never from a seedable `Random`, so a key with another inode number or an altered tag fails `InvalidReference`: a holder of one key cannot name a neighbouring object.
- **Failures.** A key from another identity or epoch fails `ForeignReference`, a key whose object is gone `StaleReference`, and a malformed or forged key `InvalidReference`. Resolution is on the volume and checks no permission.
- **Live images.** The runtime block stores the epoch and the key secret, so live images written by earlier releases no longer open; regenerate them as for the previous format change. Two volumes opened from one image share its keys, so keep one writer per image. A construction now draws one more `Random` value, its epoch, after its incarnation.

```ts
const Json = Schema.fromJsonString(Vfs.ReferenceKey)
const text = yield * Schema.encodeEffect(Json)(yield * volume.referenceKey(reference))
const same = yield * volume.resolveReferenceKey(yield * Schema.decodeEffect(Json)(text))
```
