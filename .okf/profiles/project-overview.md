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
generated: { by: codex/okf, at: 2026-09-10T00:00:00Z }
---

# Project knowledge overview

Effect Virtual FS provides a runtime-neutral filesystem core, an Effect `FileSystem` adapter, SQLite-backed named checkpoints, and a bounded virtual-build consumer.

Start with the [system boundaries](/architecture/system-boundaries.md "described by") to understand ownership, then use the [implemented filesystem profile](implemented-filesystem.md "implemented by") to reach current behavior. Work outside that contract is listed under [deferred capabilities](deferred-capabilities.md "excludes") and must remain distinguishable from implemented support.

Repository changes follow the [evidence and validation workflow](/workflows/evidence-and-validation.md "governed by") and the [release-readiness workflow](/workflows/release-readiness.md "governed by").
