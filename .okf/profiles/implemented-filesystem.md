---
type: Implementation Profile
title: Implemented filesystem
description: Summarizes the current public core, Effect adapter, snapshot, overlay, delta, NFS export, build-consumer, and named-checkpoint capabilities without reproducing detailed contracts.
status: stable
tags: [profile, implementation, filesystem]
sources:
  - id: core-source
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Core public implementation
  - id: memory-source
    resource: ../../packages/memory/src/MemoryFileSystem.ts
    title: Memory adapter public implementation
  - id: persistence-source
    resource: ../../packages/persistence/src/CheckpointStore.ts
    title: Checkpoint store public implementation
  - id: live-store-source
    resource: ../../packages/persistence/src/SqliteLiveImageStore.ts
    title: SQLite live image store public implementation
  - id: live-vm-gate
    resource: ../../packages/persistence/scripts/utm-vm-crash-gate.sh
    title: Guest OS hard-stop recovery gate
  - id: nfs-source
    resource: ../../packages/nfs/src/NfsServer.ts
    title: NFS server public implementation
generated: { by: codex/okf, at: 2026-09-20T00:00:00Z }
---

# Implemented filesystem

The repository implements a runtime-neutral Effect filesystem core for regular files, directories, symbolic links, and hard links. The public core includes volume construction, callers, directory-relative lookup, file and directory handles, byte-preserving paths, metadata and permission operations, watches, fixtures, and isolated versioned snapshots. It also exposes runtime-only [object references](../contracts/object-references.md "refined by") and [mutation revisions](../contracts/mutation-revisions.md "refined by") for stable identity and coherent live observations.

Live volumes bound admitted work and each watch subscriber's retained events. Overflow emits `Rescan`; the [mutation and observation contract](../contracts/mutation-and-observation.md "refined by") defines recovery and adapter behavior.

The core also creates writable [overlay workspaces](../contracts/overlay-workspaces.md "refined by") from immutable snapshots. They share untouched regular-file payloads, retain private writable state, expose identity-based final-difference summaries, and capture a matching summary plus complete version 1 snapshot.

The supported behavior is a [bounded POSIX profile](bounded-posix.md "constrained by"), not POSIX certification. Detailed rules are organized in `.okf/contracts/index.md`, with central ownership described by [resources and authority](../contracts/resources-and-authority.md "refined by") and durable state by [snapshots and fixtures](../contracts/snapshots-and-fixtures.md "refined by").

`@effect-vfs/memory` binds a core volume to Effect's existing `FileSystem` service and preserves adapter-specific compatibility behavior. `make` and `layer` create a fresh volume containing `/tmp`; `bind` exposes an existing volume without changing its tree. See the [memory adapter compatibility contract](../contracts/memory-adapter-compatibility.md "refined by").

Snapshots use a strict version 1 JSON/base64 representation. Capture and restore isolate storage, retain reachable namespace and metadata, and exclude live handles, caller state, subscriptions, and unreachable content. The [virtual-build consumer contract](../contracts/virtual-build-consumer.md "refined by") demonstrates build and rebuild through public exports, including a bounded virtual-package import case.

The core can also create, inspect, Schema-encode, decode, and apply [portable snapshot deltas](../contracts/snapshot-deltas.md "refined by"). A delta reconstructs an exact target only from a semantically matching immutable base. Path-oriented summaries do not infer renames, and finite shared policies bound creation, codec, and application work.

`@effect-vfs/persistence` adds named, create-only SQLite checkpoints over encoded snapshots. Applications supply the SQLite client and run the migration explicitly. Loading returns an opaque snapshot for restoration into a fresh volume. This implements the [checkpoint persistence decision](../decisions/named-checkpoint-persistence.md "implements") and is specified by the [checkpoint persistence contract](../contracts/checkpoint-persistence.md "refined by").

The package also exports a scoped SQLite live-image store built on an application-supplied Effect `SqlClient`. It commits bounded whole images under exclusive ownership and passes process-restart tests. A repeatable UTM gate now checks guest OS hard stops against a recorded Debian/ext4 virtual disk configuration. Physical power-loss behavior, lost or reordered storage writes, and temporary journal-space bounds remain unqualified, so volumes opened through it still report `memory-only`. [Issue #129](https://github.com/lloydrichards/effect-virtual-fs/issues/129) tracks qualification; the [live durable volume proposal](../research/live-durable-volume.md "qualified by") records the design.

`@effect-vfs/nfs` exports one live volume read-only to NFSv4.1 clients. The [NFS read-only-local profile](nfs/nfs-read-only-local.md "refined by") serves loopback TCP or a UNIX-domain socket and is interoperable with Linux and macOS kernel clients. The [NFS read-only-networked profile](nfs/nfs-read-only-networked.md "refined by") maps trusted credentials and peers to VFS callers and permits non-loopback binding behind policy and explicit opt-in. Both are protocol-complete for reads but not conformant; networked mode remains experimental.

Anything beyond this summary must be checked against the focused contract or current source. The intentionally unsupported surface is listed in [deferred capabilities](deferred-capabilities.md "excludes").
