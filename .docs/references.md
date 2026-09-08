# Reference repositories

Reference checkouts live under `.reference/`. They are research inputs only and are excluded from workspaces, builds,
formatting, linting, and publishing.

Run `scripts/bootstrap-references.sh` to create the pinned checkouts:

- `open_effect` at `14df59217416ba28a8b6a8fd0ab9ac1c891f14f3`, the hardened MemoryFileSystem implementation.
- `effected` at `40f04b6cc06fc0894fb543298a8852441986d8c9`, including the community `packages/memfs` adaptation.

The local `open_effect` commit `9953327e13bbf09ed6e2492daf89f442006776b3` contains the original
`VirtualFileSystem-design.md`, `VirtualFileSystem-research.md`, and acceptance-test outline. Those design sources are
copied into this repository because that commit is not on the remote feature branch.
