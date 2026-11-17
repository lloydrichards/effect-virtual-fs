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
  - id: v1-checklist
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/279
    title: Core and memory v1 gates
  - id: host-validation
    resource: ../../.github/workflows/pr-validation.yml
    title: Pinned host and candidate package checks
  - id: built-runtimes
    resource: ../../.github/workflows/core-memory-runtimes.yml
    title: Pinned core and memory runtime checks
  - id: filesystem-testing
    resource: ../../packages/memory/src/FileSystemTesting.ts
    title: Delegating filesystem fault and spy hooks
generated: { by: codex/okf, at: "2026-11-17T22:51:38+01:00" }
---

# Release readiness

Core is the publication root. Memory, persistence, and nfs depend on core, so `@effect-vfs/core` must be available before consumers that reference its released range. Changesets keeps core, memory, persistence, and nfs in one fixed version group and updates internal dependencies at patch level.

Before publishing, follow the [pull-request validation sequence](evidence-and-validation.md "depends on"). The release job uses Node 24 and invokes Changesets on pushes to `main`. When Changesets publishes, the release script builds the workspace first.

The [core and memory v1 support proposal](../research/core-memory-v1-policy.md) records the candidate scope and
qualification checklist. Adopt release-specific guarantees after the scope review and candidate checks.

Package-specific build gates matter. Core and persistence check emitted NodeNext consumption. Memory additionally bundles a browser-target entry and runs a Node smoke against that artifact. These establish export, module-resolution, and bundling compatibility; they do not establish full browser or worker runtime filesystem behavior.

The pinned Node host job installs the candidate core and memory tarballs together outside the workspace. It verifies that memory resolves the candidate core package, checks strict NodeNext declarations, and runs a seeded filesystem workload with observed writes. This gate qualifies the candidate packages. Repeat the installation against the published versions after release.

Release notes and version changes should reflect user-visible behavior. A release-ready claim must state any runtime matrix that was actually exercised rather than inheriting old local results. A release that states an NFS profile maturity must list the clients, suites, and versions behind it, as the [NFS interoperability and fault evidence decision](../decisions/nfs/nfs-interoperability-evidence.md "constrained by") requires; the preview app's conformance baseline is the record for the read-only profile. This workflow is [constrained by package boundaries](../decisions/package-boundaries.md "constrained by").

## Core and memory v1 disposition

The [v1 release issue](https://github.com/lloydrichards/effect-virtual-fs/issues/279) remains open. Existing coverage supports work on a release candidate. The adopted scope, complete install evidence, and final migration policy still gate publication.

| Required gate                                                                                          | Evidence and remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope [#273](https://github.com/lloydrichards/effect-virtual-fs/issues/273)                            | The [minimal Effect port draft](../research/minimal-effect-port.md) records local contract review. The community stable export list and supported dependency minimum still need adoption. The upstream engine and provider tracked in [#308](https://github.com/lloydrichards/effect-virtual-fs/issues/308) and [#309](https://github.com/lloydrichards/effect-virtual-fs/issues/309) still need acceptance and qualification at an exact source revision. |
| Shared host contract [#245](https://github.com/lloydrichards/effect-virtual-fs/issues/245)             | The pinned host job covers memory and the Effect host adapter on Node 24.21.0 and Ubuntu 24.04. Use the [adapter contract](../contracts/memory-adapter-compatibility.md) for documented differences, and rerun the job on the candidate.                                                                                                                                                                                                                   |
| Clean installs and port consumer [#274](https://github.com/lloydrichards/effect-virtual-fs/issues/274) | [#408](https://github.com/lloydrichards/effect-virtual-fs/pull/408) delivered isolated candidate tarball checks for both packages. The exact published 0.8.0 baseline, the same workload against the selected Effect port, and the post-publication smoke still need recorded results.                                                                                                                                                                     |
| Filesystem faults and spies [#243](https://github.com/lloydrichards/effect-virtual-fs/issues/243)      | `FileSystemTesting` observes public calls and can fail them before delegation. Reuse it for write-count and pre-delegation assertions. Partial failures and backend recovery require their own evidence.                                                                                                                                                                                                                                                   |
| Supported runtimes [#275](https://github.com/lloydrichards/effect-virtual-fs/issues/275)               | The [built-package runtime matrix](evidence-and-validation.md) exercises Node 24.21.0 and Bun 1.4.4 on Ubuntu 24.04. Qualify the adopted candidate matrix and minimum Effect version. Desktop host, native Node integration, browser, and Worker claims need evidence for their exact configurations.                                                                                                                                                      |
| Workload limits [#276](https://github.com/lloydrichards/effect-virtual-fs/issues/276)                  | The [measured workload policy](../decisions/core/measured-workload-policy.md) bounds the small-workspace profile and separates volume quotas from delta work. Confirm that the selected consumer fits that profile and qualify any higher limits it needs.                                                                                                                                                                                                 |
| Failure and cleanup [#277](https://github.com/lloydrichards/effect-virtual-fs/issues/277)              | The [validation ledger](../evidence/current-validation.md) records fixed-seed state tests, scoped cleanup under pressure, and deliberate regression probes. Rerun the supported checks on the candidate and record each known failure's disposition.                                                                                                                                                                                                       |
| Support and migration policy [#278](https://github.com/lloydrichards/effect-virtual-fs/issues/278)     | [#416](https://github.com/lloydrichards/effect-virtual-fs/pull/416) drafts the policy. Reconcile the published guidance and manifests after scope and candidate qualification.                                                                                                                                                                                                                                                                             |

Carry the candidate revision and the exact dependency and runtime versions into the release record. After publication, install the exact released packages in a clean external project and repeat the consumer workload.

## Persistence release gates

Persistence has separate runtime and storage gates. Keep PostgreSQL and D1 peers optional for unrelated entrypoints, and qualify native-client composition through the existing packed consumer fixture. PostgreSQL's dedicated-client setup, receive budget and complete-owner replacement must remain explicit in release docs. Local Miniflare/workerd contracts do not replace the hosted D1 qualification and intended-deployment ownership/cancellation checks described by the [persistence ownership decision](../decisions/persistence-store-helpers.md "constrained by"). Do not release the D1 adapter until those checks are recorded; SQLite, PostgreSQL and D1 continue to report `memory-only`.

The supplied-client R2 API change is accepted as a breaking pre-1.0 release in 0.12.0. Migration notes must move `Options.client` into the supplied `R2LiveImageStore.Client` service. This release choice does not select v1.0 readiness for the independent Effect port or strengthen storage durability.
