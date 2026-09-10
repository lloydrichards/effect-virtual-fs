---
type: Architecture
title: Volume, caller, and handle model
description: Assigns shared filesystem state to a volume, authority and lookup context to callers, and cursor and lifetime state to scoped handles.
status: stable
tags: [architecture, state, authority, resources]
sources:
  - id: core-source
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Core public implementation
generated: { by: codex/okf, at: 2026-09-10T00:00:00+00:00 }
---

# Volume, caller, and handle model

A `Volume` is one isolated, live filesystem. It owns the namespace, file identity, content, metadata, capacity accounting, mutation coordination, change observation, and snapshot capture. Consumers sharing a volume observe the same committed state.

A `Caller` carries independent credentials, supplementary groups, umask, and current-directory identity. Directory identity survives rename. Deriving or binding another caller does not share mutable caller context, and authority is explicit rather than inherited from the host process.

A `FileHandle` is a scoped capability tied to one volume and open file. It owns its access mode, bigint cursor, and lifetime. Separate opens have independent cursors. A `DirectoryHandle` is a scoped directory capability used for metadata and as a relative lookup base. Open files may remain usable after rename or unlink until their final handle closes.

Explicit close reports a repeated-close error, while scope cleanup is idempotent. The capability's reusable `stat`, `sync`, and `close` effects observe current state each time; volume `watch` and `snapshot` effects also acquire or observe fresh state on execution.

The model is [constrained by schema and capability modeling](/decisions/schema-data-and-capability-interfaces.md "constrained by"), [independent resource lifetimes](/decisions/independent-resource-lifetimes.md "constrained by"), [explicit close semantics](/decisions/explicit-close-and-scope-cleanup.md "constrained by"), [scope-free root callers](/decisions/scope-free-root-callers.md "constrained by"), and [reusable capability effects](/decisions/reusable-capability-effects.md "constrained by"). Detailed rules belong to the [resource and authority contract](/contracts/resources-and-authority.md "refined by"), [regular-file I/O contract](/contracts/regular-file-io.md "refined by"), [permissions and metadata contract](/contracts/permissions-and-metadata.md "refined by"), and [mutation and observation contract](/contracts/mutation-and-observation.md "refined by").
