---
type: Decision
title: Staged overlay delivery
description: Delivers readable change summaries and complete snapshots first, preserving internal object identity while deferring exact delta persistence.
status: stable
tags: [overlay, scope, snapshots, persistence]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/8
    title: Overlay design scope and original export questions
  - id: research
    resource: ../research/overlay-changes.md
    title: Export alternatives and future delta requirements
generated: { by: codex/okf, at: 2026-09-10T11:48:22Z }
---

# Staged overlay delivery

Accepted by the user on 2026-09-10 in Codex task `01a08acd-b076-7512-bab8-451137eaa712`. This concept records those decisions; issue #8 supplies the original questions, and code sources establish constraints rather than approval. The implemented behavior is recorded by the [overlay workspace contract](/contracts/overlay-workspaces.md "implemented by"). Start here for v1 scope, then follow the focused decisions below.

## V1 scope

An overlay behaves as an ordinary `Volume`, with readable change inspection and complete snapshots. `Volume.snapshot` retains the [existing snapshot contract](/contracts/snapshots-and-fixtures.md "preserves"); saved images use [checkpoint persistence](/contracts/checkpoint-persistence.md "depends on"). Each saved workspace repeats unchanged contents, so even small edits require a complete snapshot for persistence or transfer.

- [Base ownership](overlay-base-ownership.md "refined by") owns immutable inputs and workspace isolation.
- [Content sharing](overlay-content-sharing.md "refined by") owns shared live contents and private whole-file changes.
- [Final-difference summaries](overlay-final-difference-summary.md "refined by") owns filtering, rename reporting and consistent summary/snapshot capture.

These choices preserve internal object identity for aliases, handles and directory callers. They do not require a public object-reference API.

## Reset and capacity

Reset means creating a fresh workspace from the same base. Applications replace workspace references and adapter bindings and close old scoped resources. Existing callers, handles and watches stay attached to the old workspace until their independent lifetimes end; replacement neither retargets nor revokes them. Preserve the [resource lifetime rules](independent-resource-lifetimes.md "constrained by").

Existing [whole-volume limits](/contracts/capacity-and-limits.md "preserves") include shared base contents. Private promotion does not double-charge a file. Hard links, symlink targets and unlinked-open files retain existing accounting. Construction fails if the base exceeds destination limits. A 200 MB charged base under a 250 MB limit leaves 50 MB for logical growth. These limits are not physical-memory budgets.

## Deferred and open

Exact delta persistence, a changed-data budget, in-place reset, merge/rebase, and automatic persistence are outside v1. Delta persistence requires its own format, base matching, validation, restoration and base-retention policy. Block/range copying is deferred; no quantified memory or startup guarantee is promised.

Core exports `makeOverlay`, `OverlayVolume`, schema-backed summary records, `changes` and paired `capture`. Directory moves may produce one rename per affected path. Internal storage and lineage remain private.
