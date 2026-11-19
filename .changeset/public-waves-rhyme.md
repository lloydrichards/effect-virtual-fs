---
"@effect-vfs/persistence": patch
---

R2 live-image stores drain pending requests before closing so writes finish before ownership handoff.
