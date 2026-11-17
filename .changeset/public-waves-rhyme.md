---
"@effect-vfs/persistence": patch
---

Wait for pending R2 requests before closing a live-image store so interrupted writes cannot outlive local ownership handoff.
