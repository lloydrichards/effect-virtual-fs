---
"@effect-vfs/core": patch
"@effect-vfs/memory": patch
"@effect-vfs/persistence": patch
---

Stop creating tracing spans in package operations. Applications can add spans around the operations they want to trace.
