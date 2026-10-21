---
"@effect-vfs/core": minor
"@effect-vfs/persistence": patch
---

Reject null caller options and preserve admission and availability errors before validating reference keys.

Live-image providers may return `{ _tag: "Rejected", cause }` when no storage write was attempted. R2 and SQLite preserve pre-write hashing defects and allow retry without disabling the volume. Uncertain storage outcomes still disable access.
