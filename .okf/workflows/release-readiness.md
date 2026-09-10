---
type: Workflow
title: Release readiness
description: Defines package publication order, required validation, and the limits of build compatibility claims.
status: stable
tags: [release, packages, validation]
sources:
  - id: release-workflow
    resource: ../../.github/workflows/release.yml
    title: Release workflow
  - id: changesets-config
    resource: ../../.changeset/config.json
    title: Changesets configuration
  - id: package-scripts
    resource: ../../package.json
    title: Repository scripts
  - id: core-package
    resource: ../../packages/core/package.json
    title: Core package manifest
  - id: memory-package
    resource: ../../packages/memory/package.json
    title: Memory package manifest
  - id: persistence-package
    resource: ../../packages/persistence/package.json
    title: Persistence package manifest
generated: { by: codex/okf, at: 2026-09-10T12:00:00Z }
---

# Release readiness

Core is the publication root. Memory and persistence depend on core, so `@effect-vfs/core` must be available before consumers that reference its released range. Changesets keeps core, memory, and persistence in one fixed version group and updates internal dependencies at patch level.

Before publishing, use the same ordering as pull-request validation: frozen install, format check, build, lint, Effect-aware lint, type check, and tests, plus any documentation or model checks still maintained in the repository. Build must precede type-aware lint because workspace packages expose declarations from `dist/`.

Package-specific build gates matter. Core and persistence check emitted NodeNext consumption. Memory additionally bundles a browser-target entry and runs a Node smoke against that artifact. These establish export, module-resolution, and bundling compatibility; they do not establish full browser or worker runtime filesystem behavior.

Release notes and version changes should reflect user-visible behavior. A release-ready claim must state any runtime matrix that was actually exercised rather than inheriting old local results. This workflow is [constrained by package boundaries](/decisions/package-boundaries.md "constrained by") and uses the [evidence and validation workflow](evidence-and-validation.md "depends on").
