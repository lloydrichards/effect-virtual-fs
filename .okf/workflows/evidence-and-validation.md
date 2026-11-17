---
type: Workflow
title: Evidence and validation
description: Defines how changes are verified, how regressions earn durable evidence, and which routine outputs are discarded.
status: stable
tags: [testing, evidence, validation]
sources:
  - id: pr-validation
    resource: ../../.github/workflows/pr-validation.yml
    title: Pull request validation workflow
  - id: package-scripts
    resource: ../../package.json
    title: Repository scripts
  - resource: ../decisions/repository-validation.md
    title: Repository validation policy
  - id: nfs-gate
    resource: ../../.github/workflows/nfs-linux-mount.yml
    title: Label-gated privileged NFS mount workflow
  - id: nfs-pynfs
    resource: ../../.github/workflows/nfs-pynfs.yml
    title: Pinned pynfs pull-request workflow
  - id: sqlite-hosted-gate
    resource: ../../.github/workflows/sqlite-crash-gate.yml
    title: Hosted SQLite process and I/O fault gate
  - id: sqlite-vm-gate
    resource: ../../packages/persistence/scripts/utm-vm-crash-gate.sh
    title: Local UTM guest OS hard-stop gate
generated: { by: codex/okf, at: 2026-11-17T09:47:12Z }
---

# Evidence and validation

Claims should be no broader than the check that supports them. A passing type consumer proves selected API composition, not filesystem behavior. A browser-target bundle proves bundling, not browser runtime operation. A focused regression proves its observable case, not complete standards conformance.

For a behavior change, identify the requirement or accepted decision, add a focused regression when appropriate, prove that the regression fails for the intended defect, repair narrowly, then run the relevant package and repository checks. Preserve structured errors and rejected-state invariants; do not validate behavior by parsing incidental error prose.

The main pull-request job uses Bun 1.4.4. It runs a frozen install, checks formatting, and builds the workspace. The docs build regenerates the committed API reference, so CI checks it for changes immediately afterward. The build also emits the workspace declarations that type-aware lint needs. If a consumer reports missing `dist/*.d.ts`, reproduce this build order before changing its source. CI then runs the anti-slop policy check and Oxlint, Effect-aware lint, type checking, tests, and the core and NFS [benchmark correctness checks](package-benchmarks.md "uses"). Tests and type checks also depend on upstream package builds through Turbo.

The [repository validation policy](../decisions/repository-validation.md "constrains") makes workspace and export coverage
explicit. `bun run lint:repository` checks that inventory, package direction and runtime import cycles. `bun run lint`
includes those checks and isolated fixtures for every enabled custom lint rule. `bun run lint:effects` derives applicable
projects from the inventory and accepts workspace directories or names for focused runs. `bun run type-check` also checks
the lint implementation. `bun run test:tooling` exercises the inventory, import graph, packed output checks and public
documentation checker. `bun run check:consumers` checks packed exports with TypeScript 5.9.3 and 7.0.2 after building.
These compiler versions are qualified separately; this does not establish a continuous compiler support range.

Public documentation checks run in the docs prebuild hook and require explicit API-page coverage, declaration metadata,
valid supplied stability tags and supported public links. The example checker discovers published source modules from
the export inventory, compiles their examples and executes supported output assertions under the selected runtime.
Preview regeneration checks preserve snapshot ownership and verify generated-file drift and input integrity.

Library builds require unused-local and unused-parameter checks. They retain runtime namespaces rather than enabling
`erasableSyntaxOnly`, which would reject existing model declarations and require a separate compatibility decision.
Use `bun run validate` for the integrated local sequence. The generated API status check expects intended documentation
changes to be committed; while editing, verify regeneration is repeatable before reviewing the generated diff.

Separate jobs target Ubuntu 24.04. The host filesystem contract runs on Node 24.21.0. The direct Node provider, mounted filesystem, and TypeScript workbench jobs run on Node 26.11.1. Record the runtime each check exercised when citing its results.

Outside the main workflow, the NFS Linux mount gate is a separate workflow that runs on demand or when a pull request carries the `nfs-gate` label, and records the kernel client it ran against. The unprivileged pinned pynfs gate runs as its own workflow on pull requests that change the core, the NFS package, or the preview app, and fails on any difference from the classified known-failures file. The [NFS interoperability and fault evidence decision](../decisions/nfs/nfs-interoperability-evidence.md "refined by") fixes which NFS checks run where.

SQLite failure qualification has two separate gates. The opt-in hosted Linux workflow repeats process death, a real disk-full write, and injected SQLite VFS write and sync failures. A local UTM script forcibly stops a dedicated Linux guest between a provider write and recovery, retaining its virtual disk across boots. Both record the actual runtime and storage configuration. Neither a green hosted runner nor a VM hard stop proves physical power-loss durability; lost or reordered writes require a separate fault model, and a finite rollback-journal and temporary-file policy is still open.

Retain evidence only when its conclusion still changes present design, use, testing, or maintenance. Suitable retained evidence includes a reproducible regression probe, a measurement supporting an active limit, or an interoperability trace supporting a capability claim. Do not retain routine green logs, historical test counts, local timings, milestone chronology, or environment snapshots merely as history; Git already preserves those.

Record current caveats beside the claim they constrain. The [current validation ledger](../evidence/current-validation.md "summarized by") captures only cross-cutting conclusions that remain relevant.
