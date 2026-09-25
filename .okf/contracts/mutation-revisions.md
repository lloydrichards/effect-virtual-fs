---
type: Contract
title: Mutation revisions and coordinated observations
description: Defines runtime per-object revisions and coordinated owned observations for cache validation across all core writers.
status: stable
tags: [revisions, concurrency, observation]
sources:
  - id: core
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Metadata, mutation gate and watch publication
  - id: metadata-tests
    resource: ../../packages/core/test/MutationRevision.test.ts
    title: Fixed-clock revision and runtime-only snapshot tests
  - id: replacement-tests
    resource: ../../packages/core/test/Replacement.test.ts
    title: Mutation rejection and replacement behavior
  - id: reference-tests
    resource: ../../packages/core/test/ReferenceMutation.test.ts
    title: Atomic reference mutation result tests
generated: { by: codex/okf, at: 2026-09-18T16:40:52+02:00 }
---

# Mutation revisions and coordinated observations

Every live node has a runtime-only bigint revision updated alongside committed mutations under the volume's existing coordination gate. `observeMetadata` returns copied metadata and the node revision from one coordinated state. `observeDirectory` returns owned name bytes, canonical child references, and the directory revision from one coordinated state.[^core]

Reference-addressed namespace mutations return a Schema-backed `DirectoryChange` containing the affected directory revision before and after the mutation from the same gate hold. Rename returns a tagged one-directory or two-directory result. Equal revisions mean the operation succeeded without changing that directory; results carry no redundant `changed` or `atomic` flag. Creating and linking operations also return the exact resulting object reference.[^reference-tests]

This extends the [mutation and observation contract](mutation-and-observation.md "refines") and uses [object references](object-references.md "depends on"). Protocol cookie encoding, replay caches and client cache policy remain adapter responsibilities. The contract does not introduce a general multi-operation transaction.

## Advancement rules

Content writes, truncation, permission changes, ownership changes, explicit timestamp changes, and link-count changes advance the affected object. A `setattr` that changes several attributes advances it once and publishes one `Update`. Namespace creation, removal, linking, and rename advance every affected parent directory; rename also advances the moved object. Cross-directory rename therefore changes both directory revisions.

Read-only access-time updates do not advance revisions. Rejected operations and existing explicit no-op branches do not advance them.[^replacement-tests] Directory observation is materialized in core; adapters own paging and invalidation. Revisions support equality and ordering only within one live volume. Callers cannot depend on the initial value, increment size, persistence, or continuity across restore.

## Acceptance evidence

Focused fixed-clock tests cover same-length writes, hard-link aliases, metadata changes, cross-directory rename, reads, rejections, no-op branches, owned observations, and exclusion from snapshot version 1. Concurrent reference creation proves that returned transitions do not overlap or admit another parent mutation between their endpoints.[^metadata-tests][^reference-tests]

[^core]: Inspect `Metadata`, `Volume.watch`, the private coordination gate, timestamp sampling and directory reads.

[^metadata-tests]: Existing metadata tests demonstrate controlled clock inputs and rejected-state checks.

[^replacement-tests]: Existing replacement tests ground publication and failure invariants that revisions must preserve.
