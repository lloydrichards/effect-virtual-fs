---
"@effect-vfs/memory": patch
---

Recursive directory creation now leaves no partial tree on failure, and recursive removal reports a missing descendant instead of claiming success.
