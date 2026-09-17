---
"@effect-vfs/core": patch
"@effect-vfs/memory": patch
"@effect-vfs/persistence": patch
---

The public API now carries compiled `@example` blocks, so every published symbol worth demonstrating ships with a snippet that is type-checked and executed on each docs build.

Coverage spans the volume constructors, `Caller`, `Volume`, `OverlayVolume`, and `CurrentFileSystem`; the snapshot and delta workflow end to end; the errors and option bags whose defaults are invisible from the type; byte paths, handles, and metadata; and the memory and persistence entry points. Behaviour that was previously prose only is now demonstrated, including the `Layer.fresh` workaround for layer memoization and the umask applied to a requested create mode.

`CheckpointStore.make` and `CheckpointStore.layer` are now declared as static methods rather than static properties, so they appear on the generated API page. Call signatures are unchanged.
