---
type: Research
title: Minimal Effect filesystem port
description: Proposes reusable Effect dependencies, a reduced memory engine and separate Node VFS qualification.
status: draft
tags: [architecture, effect, compatibility]
sources:
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/273
    title: Staged scope and dependency gates
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/308
    title: Upstream engine ownership and acceptance
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/309
    title: Upstream FileSystem method and resource profile
generated: { by: codex/okf, at: "2026-10-21T21:12:09+00:00" }
---

# Minimal Effect filesystem port

The local preparation uses published Effect 4.0.5. The upstream design was researched against unreleased `v4/next-minor` revision `3c0eb2b1d2ebfc03f8a1a77a143b459bd66655c6`; the later API comparison uses `5c4b648deaf19676eb81c5f7e452b5bd5c3ae344`. Neither source revision establishes release availability or maintainer acceptance.

## Local preparation and upstream ownership

Local #304 adapts published metadata, positioned reads, final-component noFollow, access checks and watch readiness. It retains the published Crypto service and a local MIT-adapted portable glob. Release-dependent substitutions belong to upstream #308 and #309: Bytes and split crypto providers for the engine, and derived glob, public readDirectoryEntries and lstat for the provider. Optional Mac adoption requires preserving the existing truncated authentication format. Bounded snapshot search remains separate.

The accepted [persistent-state decision](../decisions/core/persistent-volume-state.md "refined by") uses reference-marked private inode HashMap records and explicit directory slots. The [collection evidence](../evidence/collection-reuse.md "evidenced by") records accepted historical CPU and retained-heap costs against Effect 4.0.0. Those measurements do not qualify 4.0.5 or justify a new collection module.

Local #306 removes copy's runtime TreeTransfer dependency. Local #307 extracts one private engine while community construction retains identities, snapshots, overlays, durable stores and watch hubs. Permission and confinement mechanics remain coordinated inside the engine; public Caller, credential and authority APIs remain community features. The [engine ownership map](../architecture/volume-caller-handle-model.md "described by") records each remaining dependency and its intended Effect home. Independent upstream contracts remain a #308 gate.

## Compatibility gates

Effect service compatibility, shared filesystem semantics and native Node integration are separate claims. The minimum engine covers byte names, files, directories, symlinks, hard links, metadata, handles, private identity and allocation limits. It excludes public snapshots, overlays, deltas, codecs, search, transfer, authenticated references, persistence and NFS under the [package boundary decision](../decisions/package-boundaries.md "constrained by").

#303 proposes an independent BytePath value and codecs in Effect-TS/effect#9730. Public manipulation helpers are deferred. Filesystem-specific assembly stays private; generic byte operations should reuse upstream Bytes once ported. Hex128 remains local Schema composition unless independent demand justifies extraction.

#302 owns scheduling, reentry and finalizer qualification. Local FIFO coordination is preserved during extraction, not accepted as an upstream generic algorithm. A failed synchronous call must not mutate later. The reduced candidate must pass those gates before #308; arbitrary Effect implementations cannot be presumed synchronous.

#309 owns every target FileSystem method and option, structured error translation, fresh/shared construction, scoped files, streams, sinks, temporary cleanup and copy. Its proposed initial watch fails on consumption with PlatformError reason Unknown, module FileSystem, method watch and description WatchUnsupported. Community watches remain supported. Maintainers must accept the limited upstream profile.

#310 and #311 own a separate Node provider and mounted filesystem/loader qualification. Node handles require their own cursor and lifetime wrapper. Initial routing is well-formed UTF-8 text; arbitrary-byte routing requires separate evidence. Memory sync and datasync imply no crash durability. Node/Bun checks and browser bundle smoke do not establish browser execution or native Node integration.

The [parent issue](https://github.com/lloydrichards/effect-virtual-fs/issues/273) owns task dependencies. This proposal remains draft until upstream scope and ownership are accepted. It does not establish v1 stability.
