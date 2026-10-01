---
"@effect-vfs/core": patch
"@effect-vfs/memory": patch
"@effect-vfs/persistence": patch
"@effect-vfs/nfs": patch
---

The packages now require stable Effect `^4.0.0` instead of `4.0.0-rc.117`. Update Effect and any platform or SQLite driver packages to `4.0.0` together. SQL consumers now import `SqlClient` from `effect/sql/SqlClient`.
