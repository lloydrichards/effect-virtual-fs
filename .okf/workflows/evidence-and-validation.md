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
generated: { by: codex/okf, at: 2026-09-19T21:14:47Z }
---

# Evidence and validation

Claims should be no broader than the check that supports them. A passing type consumer proves selected API composition, not filesystem behavior. A browser-target bundle proves bundling, not browser runtime operation. A focused regression proves its observable case, not complete standards conformance.

For a behavior change, identify the requirement or accepted decision, add a focused regression when appropriate, prove that the regression fails for the intended defect, repair narrowly, then run the relevant package and repository checks. Preserve structured errors and rejected-state invariants; do not validate behavior by parsing incidental error prose.

Workspace declarations must exist before Effect-aware lint analyzes package consumers. The repository CI sequence is frozen install, format check, build, an API-reference staleness check (a dirty committed reference fails the run), lint (the anti-slop policy script, then Oxlint), Effect-aware lint, type check, and tests. Tests and type checks also depend on upstream package builds through Turbo. Privileged checks stay out of that sequence: the NFS Linux mount gate is a separate workflow that runs on demand or when a pull request carries the `nfs-gate` label, and records the kernel client it ran against. The unprivileged pinned pynfs gate runs as its own workflow on pull requests that change the core, the NFS package, or the preview app, and fails on any difference from the classified known-failures file. The [NFS interoperability and fault evidence decision](../decisions/nfs/nfs-interoperability-evidence.md "refined by") fixes which NFS checks run where.

SQLite failure qualification has two separate gates. The opt-in hosted Linux workflow repeats process death, a real disk-full write, and injected SQLite VFS write and sync failures. A local UTM script forcibly stops a dedicated Linux guest between a provider write and recovery, retaining its virtual disk across boots. Both record the actual runtime and storage configuration. Neither a green hosted runner nor a VM hard stop proves physical power-loss durability; lost or reordered writes require a separate fault model, and a finite rollback-journal and temporary-file policy is still open.

Retain evidence only when its conclusion still changes present design, use, testing, or maintenance. Suitable retained evidence includes a reproducible regression probe, a measurement supporting an active limit, or an interoperability trace supporting a capability claim. Do not retain routine green logs, historical test counts, local timings, milestone chronology, or environment snapshots merely as history; Git already preserves those.

Record current caveats beside the claim they constrain. The [current validation ledger](../evidence/current-validation.md "summarized by") captures only cross-cutting conclusions that remain relevant.
