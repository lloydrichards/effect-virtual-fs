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
generated: { by: claude/okf, at: 2026-09-16T23:00:00+02:00 }
---

# Evidence and validation

Claims should be no broader than the check that supports them. A passing type consumer proves selected API composition, not filesystem behavior. A browser-target bundle proves bundling, not browser runtime operation. A focused regression proves its observable case, not complete standards conformance.

For a behavior change, identify the requirement or accepted decision, add a focused regression when appropriate, prove that the regression fails for the intended defect, repair narrowly, then run the relevant package and repository checks. Preserve structured errors and rejected-state invariants; do not validate behavior by parsing incidental error prose.

Workspace declarations must exist before Effect-aware lint analyzes package consumers. The repository CI sequence is frozen install, format check, build, an API-reference staleness check (a dirty committed reference fails the run), lint (the anti-slop policy script, then Oxlint), Effect-aware lint, type check, and tests. Tests and type checks also depend on upstream package builds through Turbo. Privileged checks stay out of that sequence: the NFS Linux mount gate is a separate workflow that runs on demand or when a pull request carries the `nfs-gate` label, and records the kernel client it ran against.

Retain evidence only when its conclusion still changes present design, use, testing, or maintenance. Suitable retained evidence includes a reproducible regression probe, a measurement supporting an active limit, or an interoperability trace supporting a capability claim. Do not retain routine green logs, historical test counts, local timings, milestone chronology, or environment snapshots merely as history; Git already preserves those.

Record current caveats beside the claim they constrain. The [current validation ledger](../evidence/current-validation.md "summarized by") captures only cross-cutting conclusions that remain relevant.
