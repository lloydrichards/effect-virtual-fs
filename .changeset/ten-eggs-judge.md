---
"@effect-vfs/memory": patch
---

`File` now rejects negative seeks without moving the cursor and validates `readAlloc` sizes without runtime coercion.
