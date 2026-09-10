---
type: Decision
title: Named checkpoint persistence
description: Stores create-only named opaque snapshots in application-configured SQLite without coupling core to storage.
status: stable
tags: [persistence, sqlite, snapshots]
sources:
  - id: design-issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/10
    title: Checkpoint persistence design issue
  - id: implementation
    resource: ../../packages/persistence/src/CheckpointStore.ts
    title: Checkpoint store implementation
  - id: behavior-tests
    resource: ../../packages/persistence/test/CheckpointStore.test.ts
    title: Checkpoint behavior tests
  - id: restart-test
    resource: ../../packages/persistence/test/Restart.test.ts
    title: Separate-process restart test
generated: { by: codex/okf, at: "2026-09-10T09:09:38Z" }
---

# Named checkpoint persistence

`@effect-vfs/persistence` depends on core; core remains independent of storage I/O. Applications supply the Effect SQL client, database location, and migration timing. The store saves and loads opaque snapshots as existing encoded bytes under create-only names: duplicate saves fail `AlreadyExists`, missing loads fail `NotFound`, and database errors remain distinct.

Names are opaque, nonempty UTF-8 strings of at most 255 bytes without NUL or lone surrogates. Construction captures explicit decode limits, and save enforces the same limits as load. SQLite uniqueness resolves concurrent creation. Commit may precede observed completion or interruption, so retry can report an existing checkpoint.

Loaded snapshots retain [image-local identity](./snapshot-local-file-identity.md "preserves") and [owned bytes](./copying-byte-ownership.md "preserves"). This milestone excludes listing, replacement, deletion, history, automatic saving, and additional backends.
