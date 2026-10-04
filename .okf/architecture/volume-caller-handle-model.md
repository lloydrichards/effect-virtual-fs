---
type: Architecture
title: Volume, caller, and handle model
description: Assigns shared filesystem state to a volume, authority and lookup context to callers, and cursor and lifetime state to scoped handles.
status: stable
tags: [architecture, state, authority, resources]
sources:
  - id: core-source
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Core public contracts
  - id: volume-engine
    resource: ../../packages/core/src/internal/virtualFileSystem.ts
    title: Internal virtual filesystem implementation
  - id: resolution
    resource: ../../packages/core/src/internal/resolution.ts
    title: Tagged target and entry resolution
  - id: tokens
    resource: ../../packages/core/src/internal/tokenRegistry.ts
    title: Opaque token validation and scoped handle lifecycle
  - id: resolution-tests
    resource: ../../packages/core/test/internal/resolution.test.ts
    title: Direct resolution and error-order tests
  - id: token-tests
    resource: ../../packages/core/test/internal/tokenRegistry.test.ts
    title: Direct token liveness and lifecycle tests
generated: { by: codex/okf, at: "2026-10-04T21:24:00+02:00" }
---

# Volume, caller, and handle model

A `Volume` is one isolated, live filesystem. It owns the namespace, file identity, content, metadata, capacity accounting, mutation coordination, change observation, and snapshot capture. Consumers sharing a volume observe the same committed state.

A `Caller` carries independent credentials, supplementary groups, umask, and current-directory identity. Directory identity survives rename. Deriving or binding another caller does not share mutable caller context, and authority is explicit rather than inherited from the host process.

A `FileHandle` is a scoped capability tied to one volume and open file. It owns its access mode, bigint cursor, and lifetime. Separate opens have independent cursors. A `DirectoryHandle` is a scoped directory capability used for metadata and as a relative lookup base. Unrestricted open files may remain usable after rename or unlink until their final handle closes. Confined handles require current in-root membership.

Explicit close reports a repeated-close error, while scope cleanup is idempotent. The capability's reusable `stat`, `sync`, and `close` effects observe current state each time; volume `watch` and `snapshot` effects also acquire or observe fresh state on execution.

The public module owns the documented capability contracts. The internal live-volume engine keeps the shared graph, coordination gate, quotas, revisions, clock, and watch state together so each mutation remains one coordinated state transition. Its `resolution` module reads through the engine's draft-aware node getter and the caller's identity. `Node`, `Parent`, and `OrCreate` modes return tagged results, retain path diagnostics, and preserve search permission and symlink check order. Recursive directory creation uses an engine callback in the same transition.[^resolution]

The `tokenRegistry` module owns the shared WeakMaps, reference interning, and handle lifecycle. Token resolution reports `unknown`, `foreign`, `stale`, or `live`. An absent inode or an unlinked directory makes an object reference stale; an unlinked file retained by an existing handle remains observable. Watch registration, reopening, relinking, and traversal apply their own named-object requirements after token resolution. Directory handles may observe a retained detached directory, while relative lookup from it fails `NotFound`. A file handle supplied as a directory base remains invalid.[^tokens]

Handle lifecycle is `acquiring`, `open`, `releasedPendingCommit`, or `closed`. Cleanup during acquisition records the release request before publication; if a commit publishes later, it records the retained inode for a finalizer rerun rather than opening the handle. The registry owns scope acquisition, finalization and one release operation. Engine callbacks retain and release inodes, reclaim content, and publish handle changes at the appropriate installation point. A staged explicit file close leaves its handle usable until installation; local directory cleanup disables the handle before reclamation, even if storage rejects that cleanup.[^tokens]

The model is [constrained by schema and capability modeling](../decisions/core/schema-data-and-capability-interfaces.md "constrained by"), [independent resource lifetimes](../decisions/core/independent-resource-lifetimes.md "constrained by"), [explicit close semantics](../decisions/core/explicit-close-and-scope-cleanup.md "constrained by"), [scope-free root callers](../decisions/core/scope-free-root-callers.md "constrained by"), and [reusable capability effects](../decisions/core/reusable-capability-effects.md "constrained by"). Detailed rules belong to the [resource and authority contract](../contracts/resources-and-authority.md "refined by"), [regular-file I/O contract](../contracts/regular-file-io.md "refined by"), [permissions and metadata contract](../contracts/permissions-and-metadata.md "refined by"), and [mutation and observation contract](../contracts/mutation-and-observation.md "refined by").

[^resolution]: `resolution.ts` implements traversal and addressing-mode policies; `internal/resolution.test.ts` exercises it directly over a `VolumeState`.

[^tokens]: `tokenRegistry.ts` implements token identity and lifecycle; `internal/tokenRegistry.test.ts` exercises liveness, staged release, and cleanup before late publication. The engine supplies the durable transition callbacks.

[Confined callers](../contracts/confined-callers.md "refined by") add optional identity roots and retain imported authority through capability conversions.
