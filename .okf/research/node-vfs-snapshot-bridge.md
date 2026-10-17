---
type: Research Report
title: Effect VFS lessons from the Node comparison
description: Uses comparative Node evidence to motivate Effect-native link guarantees, transfer fidelity checks, cleanup qualification, and overlay parity.
status: draft
tags: [effect, comparison, snapshots, resources, metadata, links]
sources:
  - id: links
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/294#issuecomment-6231691331
    title: Symlink dereferencing counterexample and exact-sink qualification
  - id: metadata
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/295#issuecomment-6231691648
    title: Metadata loss as a fidelity-policy example
  - id: cleanup
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/296#issuecomment-6231691966
    title: Interruption and release-failure fault model
  - id: parity
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/297#issuecomment-6231692267
    title: Composition counterexamples and Effect-first comparison
  - id: transfer
    resource: ../../packages/memory/src/TreeTransfer.ts
    title: Existing capabilities, preservation options, and typed transfer failures
generated: { by: codex/okf, at: "2026-10-17T08:20:42Z" }
---

# Effect VFS lessons from the Node comparison

The Node comparison is evidence for improving Effect-first modules. No bridge, Node adapter package, or loader integration is planned. The earlier experimental adapter direction is withdrawn. Reproduction details that remain useful live in issue comments; transient prototypes, logs, and generated reports are not bundle dependencies.

## Protect the guarantees we already own

**Link identity.** Node's tested linkSync behavior dereferences a symbolic link. A second alias can become a regular file reading the wrong parent's target; a dangling target fails. Our exact destinations should retain symlink objects, stored target bytes, alias identity, and resolution from each name's parent. FileSystem transfer has an explicit retargeting and counted-degradation policy, which must be asserted separately rather than called lossless.[^links]

**Transfer fidelity.** The copy experiment dropped mode, owners, and timestamps even though Node could set some of them. That omission is not a defect in Effect VFS. Our [tree transfer contract](../contracts/tree-transfer.md "constrained by") already distinguishes destination capabilities, enabled options, precision and deliberate losses. Issue #295 proposes an opt-in check that rejects unsupported required guarantees before destination changes. Reuse SinkCapabilities and preserve existing defaults.[^metadata][^transfer]

**Destination ownership.** Ordinary interruption success does not prove recovery when release itself fails. Apply that fault model to transfer-owned roots: partial streams, source waits, restrictive final modes, replacement-root identity, timeout, and cleanup defects. Existing core/memory resource qualification remains valid; #296 targets missing transfer-specific cases rather than duplicating it.[^cleanup]

**Ordinary-volume parity.** Compare makeOverlay(base) with fromSnapshot(base), not with Node as the semantic reference. Check contents, metadata, aliases, errors, usage and events through public Effect APIs. Keep payload sharing separate from behavioral evidence. The bounded parity work and remaining gaps belong in [overlay research](overlay-filesystem.md "refined by").[^parity]

## Ownership

Core owns link and overlay invariants. Memory owns transfer fidelity and destination cleanup. Existing [package boundaries](../decisions/package-boundaries.md "constrained by") and [tree transfer ownership](../decisions/tree-transfer.md "constrained by") remain in force. No package relocation or Node dependency follows from this research.

The [Node comparison](node-vfs-interoperability.md "informed by") supplies examples and justification. A difference observed there is not evidence of a local defect. Add focused tests first, then fix only demonstrated Effect VFS violations. API changes remain proposals until their contracts are reviewed.

[^links]: Issue #294 retains a minimal Node reproducer and distinguishes core/exact-sink semantics from adapter degradation.
[^metadata]: Issue #295 retains the field-level comparison and its limitations.
[^cleanup]: Issue #296 records the finite interruption and injected-release-failure model, without importing Node mount ownership into this project.
[^parity]: Issue #297 records useful counterexamples and the local reference semantics.
[^transfer]: Public capability declarations and preservation options remain the owning API.
