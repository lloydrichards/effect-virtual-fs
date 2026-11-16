---
"@effect-vfs/core": patch
---

Return `FileTooLarge` from path truncate when a signed 64-bit length exceeds both the file quota and JavaScript's safe integer range, matching handle truncate and setattr.
