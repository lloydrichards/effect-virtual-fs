---
type: Project Profile
title: Project knowledge overview
description: Provides the primary graph entry point for current architecture, implemented behavior, and explicitly deferred work.
status: stable
tags: [project, navigation, profile]
sources:
  - resource: ../../README.md
    title: Repository overview
  - resource: ../../package.json
    title: Workspace definition
  - resource: ../../apps/docs/app/api-pages.ts
    title: Generated API page registry
  - resource: ../../apps/docs/package.json
    title: Documentation application manifest
generated: { by: codex/okf-dream, at: 2026-11-16T22:02:33Z }
---

# Project knowledge overview

Effect Virtual FS provides a runtime-neutral core with snapshots, overlays, portable deltas, and adapters for Effect and Node. The [direct Node provider](../contracts/node-provider.md "implemented by") and [mounted Node contract](../contracts/node-mounted.md "implemented by") describe the two Node entry points. Persistence supplies named SQLite checkpoints and live-image stores. The [NFS profile ladder](../decisions/nfs/nfs-profile-ladder.md "described by") records which native clients, storage guarantees, and restart behavior each export supports. The virtual-build application exercises package consumption. The documentation site publishes generated API references for core, memory, persistence, and NFS.

Start with the [system boundaries](../architecture/system-boundaries.md "described by") to understand ownership, then use the [implemented filesystem profile](implemented-filesystem.md "implemented by") to reach current behavior. Work outside that contract is listed under [deferred capabilities](deferred-capabilities.md "excludes") and must remain distinguishable from implemented support.

Repository changes follow the [evidence and validation workflow](../workflows/evidence-and-validation.md "governed by") and the [release-readiness workflow](../workflows/release-readiness.md "governed by").
