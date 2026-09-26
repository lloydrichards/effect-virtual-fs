---
"@effect-vfs/core": minor
---

`ReferenceKey` lets you save an object reference and resolve it after reopening a live volume. A key from another volume or epoch, a removed object, or an altered key fails with a distinct `VfsError` code.

```ts
const key = yield * volume.referenceKey(reference)
const sameObject = yield * volume.resolveReferenceKey(key)
```

Live images written by earlier releases cannot be opened because they lack the key data. Regenerate those images before upgrading. Keys from a restored snapshot or overlay do not resolve against the original volume.
