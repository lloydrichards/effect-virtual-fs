---
type: Decision
title: Overlay base and writable-state ownership
description: Restricts v1 overlays to one immutable snapshot base and fresh privately owned writable state.
status: stable
tags: [overlay, ownership, isolation, snapshots]
sources:
  - id: research
    resource: ../research/overlay-filesystem.md
    title: Overlay ownership alternatives and implementation constraints
generated: { by: codex/okf, at: 2026-09-10T11:03:16Z }
---

# Overlay base and writable-state ownership

Accepted by the user on 2026-09-10; implementation is pending. Each v1 workspace starts from one immutable `Snapshot` and owns fresh writable state privately. It accepts neither a live base volume nor an externally writable changes volume.

Workspace writes leave the base and sibling workspaces unchanged. Later edits to the volume that supplied the snapshot never appear in existing workspaces. Every workspace mutation uses its own capabilities, authority and coordination.

A newer project state requires a new snapshot and workspace. Carrying edits onto that base requires separate merge/rebase behavior. Live layer stacking and delta import are outside v1 under [staged delivery](staged-overlay-delivery.md "constrained by"). Constructor names and package placement remain open.

The fixed base gives change inspection a stable comparison point. Logical isolation coexists with the separately accepted sharing of unchanged file contents.
