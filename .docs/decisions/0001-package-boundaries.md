# Package boundaries

## Decision

`@effect-vfs/memory` ships first as a faithful extraction of Effect PR #6573. It implements Effect's existing
`FileSystem` interface and remains the compatibility adapter.

`@effect-vfs/core` is private until it exposes a standalone virtual filesystem with a documented POSIX profile. The
backend will own volumes, caller contexts, handles, errors, limits, fixtures, and snapshots. It will depend on Effect
for execution and resource management, but not on `@effect-vfs/memory`.

Future bindings depend on `@effect-vfs/core` and receive specific package names when they exist. We will not create a
generic empty bindings package.

## Release order

1. Publish `@effect-vfs/memory` at `0.1.0`.
2. Design and implement the private `@effect-vfs/core` package.
3. Change `@effect-vfs/memory` to adapt `@effect-vfs/core` while preserving its public Effect contract.
4. Publish `@effect-vfs/core` after its compatibility claims have executable evidence.
