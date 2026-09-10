# Overlay agent workspace demo

This example gives two simulated agents virtual project files without granting host filesystem access. It contrasts
two ways to organize their work:

- separate overlays give each agent an isolated, disposable workspace;
- separate callers on one overlay let an author and reviewer collaborate through shared files.

Run the entry point directly from the repository root:

```sh
bun apps/overlay-demo/src/demo.ts
```

The guided workflow in [`src/demo.ts`](src/demo.ts) uses only the public `@effect-vfs/core` interface. It shows the
shared workspace's path-level watch events, then captures a complete snapshot and its matching final-difference
summary.

The example labels author and reviewer actions because it orchestrates those calls itself. Filesystem watch events
contain an operation and path, not actor identity. Portable compact deltas are separate future work and are not
needed for this in-process collaboration flow.
