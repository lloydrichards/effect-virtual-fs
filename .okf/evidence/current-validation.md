---
type: Evidence
title: Current validation conclusions
description: Summarizes durable conclusions from prior validation that still constrain present maintenance and capability claims.
status: stable
tags: [evidence, validation, caveats]
sources:
  - id: pr-validation
    resource: ../../.github/workflows/pr-validation.yml
    title: Pull request validation workflow
  - id: core-regressions
    resource: ../../packages/core/test/VirtualFileSystem.test.ts
    title: Core replacement regression tests
  - id: snapshot-decoding
    resource: ../../packages/core/test/Snapshot.test.ts
    title: Snapshot decoding regression tests
  - id: adapter-regressions
    resource: ../../packages/memory/test/MemoryFileSystem.test.ts
    title: Adapter compatibility regression tests
  - id: timestamp-regressions
    resource: ../../packages/memory/test/MemoryFileSystem.test.ts
    title: Adapter timestamp regression tests
  - id: persistence-tests
    resource: ../../packages/persistence/test/CheckpointStore.test.ts
    title: Checkpoint behavior tests
  - id: persistence-restart
    resource: ../../packages/persistence/test/CheckpointStore.test.ts
    title: Separate-process restart test
  - id: virtual-build-tests
    resource: ../../apps/virtual-build/test/VirtualBuild.test.ts
    title: Public-package virtual build tests
  - id: overlay-tests
    resource: ../../packages/core/test/behaviour/overlay.test.ts
    title: Overlay workspace tests
  - id: delta-tests
    resource: ../../packages/core/test/SnapshotDelta.test.ts
    title: Snapshot delta tests
  - id: overlay-checkpoint-tests
    resource: ../../packages/persistence/test/CheckpointStore.test.ts
    title: Overlay checkpoint tests
  - id: failure-sequences
    resource: ../../packages/core/test/behaviour/failureSequences.test.ts
    title: Fixed-seed failure and identity sequences
  - id: file-resources
    resource: ../../packages/core/test/FileHandle.test.ts
    title: Retained content and cleanup under admission pressure
  - id: watch-resources
    resource: ../../packages/core/test/Watch.test.ts
    title: Interrupted admission, watch cleanup, and bounded overflow
generated: { by: codex/okf, at: 2026-10-04T00:00:00Z }
---

# Current validation conclusions

The core, memory adapter, [persistence package](../contracts/checkpoint-persistence.md "supported by"), and virtual-build consumer have executable behavioral coverage. The important maintenance conclusion is not an old test count: adapter compatibility must be tested through the core, and public-package consumers must exercise built exports rather than source-only imports.

Later capabilities carry their own focused suites rather than entries here: overlay workspaces and snapshot deltas in core, overlay bindings in the memory adapter, overlay checkpoints in persistence, and the NFS protocol suites. External NFS client evidence lives in the [NFS external suite baseline](nfs-external-suite.md "refined by").

The independent review found defects that the earlier green suite missed. Durable regression areas include final-symlink replacement behavior, copy preserving destination identity and topology, byte-observation ownership, adapter timestamp range conversion, snapshot base64 and decoding boundaries, and externally consumed export artifacts. Those cases should remain focused tests; their historical red and green logs need not remain knowledge concepts.

Fixed-seed sequences check regular-file identity, retained content, and selected rejected mutations against an independent state model. Mandatory transitions exercise rename, path reuse, hard links, and last unlink in every identity sequence. Controlled schedules check cancelled admission, cleanup under pressure, and bounded watch overflow. Core watcher and memory adapter scopes close through success, failure, and interruption. Preserve these assertions through public state and resource observations when changing admission or cleanup internals.

Selected production regression probes have demonstrated that these checks detect identity redirection, premature reclamation, retained byte charges, cursor changes after rejection, cancelled admission tickets, detached scopes, and watch overflow changes. This is finite qualification. It does not establish exhaustive scheduling, a heap-leak bound, provider failure guarantees, durability, or a runtime matrix.

Build workspace declarations before Effect-aware lint. Missing `dist/*.d.ts` can otherwise produce a validation artifact in workspace consumers rather than a source defect. Reproduce the configured clean order before changing product code in response to such diagnostics.

Browser-target bundling plus a Node smoke proves that reachable package exports bundle and execute in that check. It does not prove browser or worker runtime behavior. NodeNext consumers prove emitted module and type resolution, not every downstream toolchain.

The repository pins Bun 1.2.21 for CI and Node 24 for releases and package support. Older local validation on a different Bun version is historical, not confirmation of the current checkout. Fresh claims should use the [evidence and validation workflow](../workflows/evidence-and-validation.md "governed by") and report the runtime actually exercised. This ledger [supports the implemented filesystem profile](../profiles/implemented-filesystem.md "supports") without replacing its focused behavioral evidence.
