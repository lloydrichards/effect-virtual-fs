# Architecture

Start with [system boundaries](system-boundaries.md) for the separation between the runtime-neutral core and its consumers.

- [Volume, caller, and handle model](volume-caller-handle-model.md) explains where mutable state and authority live.
- [Code Mode example ownership](codemode-example.md) explains per-execution overlays, retained inspection, and interpreter limits.
- [Package dependency model](package-dependency-model.md) records dependency direction and package ownership.
- [Implemented filesystem profile](../profiles/implemented-filesystem.md) summarizes the supported system built on these boundaries, including the read-only NFS export.
