---
"@effect-vfs/core": minor
"@effect-vfs/persistence": patch
"@effect-vfs/memory": patch
---

Reject null caller options and preserve admission and availability errors before validating reference keys.

Live-image providers may return `{ _tag: "Rejected", cause }` when no storage write was attempted. R2 and SQLite preserve pre-write hashing defects and allow retry without disabling the volume. Uncertain storage outcomes still disable access.

Whole-file `Caller.writeFile` now returns the committed file's `ObjectReference`, including overwrites and no-op writes. Callers that ignore the result continue to work. Copy cleanup uses this identity without looking the path up again, preserving concurrent replacements. Copy also preserves empty symlink targets and restores directory modes when handle acquisition fails.

```ts
const reference = yield * caller.writeFile("/file", bytes, { access: "write", create: "exclusive" })
```
