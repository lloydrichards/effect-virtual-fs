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
  - id: packed-consumer
    resource: ../../packages/core/compatibility/packed/check.sh
    title: Isolated core and memory tarball install
  - id: persistence-package
    resource: ../../packages/persistence/package.json
    title: Persistence package manifest
  - id: nfs-package
    resource: ../../packages/nfs/package.json
    title: NFS package manifest
  - id: persistence-readme
    resource: ../../packages/persistence/README.md
    title: Dedicated clients, adapter peers and hosted D1 qualification
  - id: d1-qualification
    resource: ../../packages/persistence/test/fixtures/d1-worker.ts
    title: Disposable hosted D1 qualification Worker
generated: { by: codex/okf, at: "2026-11-17T22:04:09+01:00" }
---

# Release readiness

Core is the publication root. Memory, persistence, and nfs depend on core, so `@effect-vfs/core` must be available before consumers that reference its released range. Changesets keeps core, memory, persistence, and nfs in one fixed version group and updates internal dependencies at patch level.

Before publishing, follow the [pull-request validation sequence](evidence-and-validation.md "depends on"). The release job uses Node 24 and invokes Changesets on pushes to `main`. When Changesets publishes, the release script builds the workspace first.

Package-specific build gates matter. Core and persistence check emitted NodeNext consumption. Memory additionally bundles a browser-target entry and runs a Node smoke against that artifact. These establish export, module-resolution, and bundling compatibility; they do not establish full browser or worker runtime filesystem behavior.

The pinned Node host job installs the candidate core and memory tarballs together outside the workspace. It verifies that memory resolves the candidate core package, checks strict NodeNext declarations, and runs a seeded filesystem workload with observed writes. This gate qualifies the candidate packages. Repeat the installation against the published versions after release.

Release notes and version changes should reflect user-visible behavior. A release-ready claim must state any runtime matrix that was actually exercised rather than inheriting old local results. A release that states an NFS profile maturity must list the clients, suites, and versions behind it, as the [NFS interoperability and fault evidence decision](../decisions/nfs/nfs-interoperability-evidence.md "constrained by") requires; the preview app's conformance baseline is the record for the read-only profile. This workflow is [constrained by package boundaries](../decisions/package-boundaries.md "constrained by").

Persistence has separate runtime and storage gates. Keep PostgreSQL and D1 peers optional for unrelated entrypoints, and qualify native-client composition through the existing packed consumer fixture. PostgreSQL's dedicated-client setup, receive budget and complete-owner replacement must remain explicit in release docs. Local Miniflare/workerd contracts do not replace the hosted D1 qualification and intended-deployment ownership/cancellation checks described by the [persistence ownership decision](../decisions/persistence-store-helpers.md "constrained by"). Do not release the D1 adapter until those checks are recorded; SQLite, PostgreSQL and D1 continue to report `memory-only`.

The supplied-client R2 API change is accepted as a breaking pre-1.0 release in 0.12.0. Migration notes must move `Options.client` into the supplied `R2LiveImageStore.Client` service. This release choice does not select v1.0 readiness for the independent Effect port or strengthen storage durability.
