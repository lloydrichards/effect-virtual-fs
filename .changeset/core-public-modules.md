---
"@effect-vfs/core": minor
---

Public schemas are now importable from their own modules, including `Metadata`, `Watch`, `Snapshot`, and `BytePath`. The main `VirtualFileSystem` export still re-exports them.

```ts
import { Metadata } from "@effect-vfs/core/Metadata"
import { Change } from "@effect-vfs/core/Watch"
import { Schema } from "effect"

const decodeMetadata = Schema.decodeUnknownEffect(Metadata)
const isCreate = Schema.is(Change.cases.Create)
```
