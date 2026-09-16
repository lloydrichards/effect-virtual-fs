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
  - resource: ../../apps/docs/package.json
    title: Documentation application manifest
generated: { by: claude/okf, at: 2026-09-16T23:00:00+02:00 }
---

# Project knowledge overview

Effect Virtual FS provides a runtime-neutral filesystem core with overlay workspaces and portable snapshot deltas, an Effect `FileSystem` adapter, SQLite-backed named checkpoints, a read-only NFSv4.1 export for local native tools, and a bounded virtual-build consumer. Its static documentation application publishes a landing page and generated API references for the public core, memory, and persistence entrypoints; the NFS package is documented by its README and the [NFS profile ladder](/decisions/nfs/nfs-profile-ladder.md "described by").

Start with the [system boundaries](/architecture/system-boundaries.md "described by") to understand ownership, then use the [implemented filesystem profile](implemented-filesystem.md "implemented by") to reach current behavior. Work outside that contract is listed under [deferred capabilities](deferred-capabilities.md "excludes") and must remain distinguishable from implemented support.

Repository changes follow the [evidence and validation workflow](/workflows/evidence-and-validation.md "governed by") and the [release-readiness workflow](/workflows/release-readiness.md "governed by").
