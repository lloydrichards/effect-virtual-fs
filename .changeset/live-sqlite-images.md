---
"@effect-vfs/persistence": minor
---

Add a provider-neutral SQLite live-image Layer for bounded volumes. Applications supply the SQLite client and Effect platform services. Reopening after a process restart retains acknowledged file contents, names, hard links, and volume identity. The provider has not yet been qualified for operating-system crashes or power loss.
