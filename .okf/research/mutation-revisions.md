---
type: Design Proposal
title: Mutation revisions and coordinated observations
description: Proposes per-object revisions published with mutations so adapters can validate cached data and directory observations across all writers.
status: draft
tags: [revisions, concurrency, observation]
sources:
  - id: core
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Metadata, mutation gate and watch publication
  - id: metadata-tests
    resource: ../../packages/core/test/Metadata.test.ts
    title: Controlled clocks and metadata behavior
  - id: replacement-tests
    resource: ../../packages/core/test/Replacement.test.ts
    title: Mutation rejection and replacement behavior
generated: { by: codex/okf, at: 2026-09-10T08:47:21Z }
---

# Mutation revisions and coordinated observations

Status: proposed, not accepted or implemented.

Current metadata contains timestamps but no revision counter. Clock samples are not guaranteed to differ between mutations. Watches publish paths through a stream with no replay; consuming those events later cannot provide an authoritative revision for an earlier observation.[^core]

Propose per-object revisions in core, updated alongside relevant mutations under the existing coordination gate. Direct core clients and adapters must participate in the same mechanism. A stat-like observation should return metadata and revision together. A directory observation should return owned names, object references and the corresponding directory revision from one coordinated read.

This extends the [mutation and observation contract](/contracts/mutation-and-observation.md "refines") and uses the proposed [object references](object-references.md "depends on"). Protocol cookie encoding, replay caches and client cache policy remain adapter responsibilities. This proposal does not introduce a general multi-operation transaction.

## Questions to settle

- Which content, metadata and namespace operations advance which objects and parents?
- How should atime-only changes, no-ops, failed operations and revision overflow behave?
- Should mutation results include coordinated before/after directory revisions?
- Should the first directory observation materialize all entries or support bounded pages with explicit invalidation?

## Acceptance evidence

Use a fixed or backward-moving clock to prove that relevant changes remain distinguishable. Exercise same-length writes, hard-link aliases, rename across directories, permission changes, and mixed direct-core/adapter writers. Verify rejected operations preserve revisions, and observations never pair old metadata with a new revision. Existing tests ground current mutation behavior but do not prove this proposed counter.[^metadata-tests][^replacement-tests]

[^core]: Inspect `Metadata`, `Volume.watch`, the private coordination gate, timestamp sampling and directory reads.

[^metadata-tests]: Existing metadata tests demonstrate controlled clock inputs and rejected-state checks.

[^replacement-tests]: Existing replacement tests ground publication and failure invariants that revisions must preserve.
