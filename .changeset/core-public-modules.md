---
"@effect-vfs/core": minor
---

Public schemas now live in per-concept modules, importable as subpaths: `Volume`, `Caller`, `FileHandle`, `Metadata`, `Fixture`, `Watch`, plus `Snapshot`, `SnapshotDelta` and `BytePath`, which had generated API pages but no subpath. `VirtualFileSystem` keeps re-exporting every schema, and its declaration file no longer imports from `internal/`. `Change` is a `Schema.TaggedUnion` instead of an interface, `FsCode` is exported from `VirtualFileSystemError`, and `LiveVolume`'s exports carry categories in the API reference.

```ts
import { Metadata } from "@effect-vfs/core/Metadata"
import { Change } from "@effect-vfs/core/Watch"
import { Schema } from "effect"

const decodeMetadata = Schema.decodeUnknownEffect(Metadata)
const isCreate = Schema.is(Change.cases.Create)
```
