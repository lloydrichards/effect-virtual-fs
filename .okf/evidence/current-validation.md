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
    resource: ../../packages/core/test/Replacement.test.ts
    title: Core replacement regression tests
  - id: snapshot-decoding
    resource: ../../packages/core/test/SnapshotDecoding.test.ts
    title: Snapshot decoding regression tests
  - id: adapter-regressions
    resource: ../../packages/memory/test/AdapterCompatibility.test.ts
    title: Adapter compatibility regression tests
  - id: timestamp-regressions
    resource: ../../packages/memory/test/Timestamp.test.ts
    title: Adapter timestamp regression tests
  - id: persistence-tests
    resource: ../../packages/persistence/test/CheckpointStore.test.ts
    title: Checkpoint behavior tests
  - id: persistence-restart
    resource: ../../packages/persistence/test/Restart.test.ts
    title: Separate-process restart test
  - id: virtual-build-tests
    resource: ../../apps/virtual-build/test/VirtualBuild.test.ts
    title: Public-package virtual build tests
generated: { by: codex/okf, at: 2026-09-10T09:09:38Z }
---

# Current validation conclusions

The core, memory adapter, [persistence package](/contracts/checkpoint-persistence.md "supported by"), and virtual-build consumer have executable behavioral coverage. The important maintenance conclusion is not an old test count: adapter compatibility must be tested through the core, and public-package consumers must exercise built exports rather than source-only imports.

The independent review found defects that the earlier green suite missed. Durable regression areas include final-symlink replacement behavior, copy preserving destination identity and topology, byte-observation ownership, adapter timestamp range conversion, snapshot base64 and decoding boundaries, and externally consumed export artifacts. Those cases should remain focused tests; their historical red and green logs need not remain knowledge concepts.

Build workspace declarations before Effect-aware lint. Missing `dist/*.d.ts` can otherwise produce a validation artifact in workspace consumers rather than a source defect. Reproduce the configured clean order before changing product code in response to such diagnostics.

Browser-target bundling plus a Node smoke proves that reachable package exports bundle and execute in that check. It does not prove browser or worker runtime behavior. NodeNext consumers prove emitted module and type resolution, not every downstream toolchain.

The repository pins Bun 1.2.21 for CI and Node 24 for releases and package support. Older local validation on a different Bun version is historical, not confirmation of the current checkout. Fresh claims should use the [evidence and validation workflow](/workflows/evidence-and-validation.md "governed by") and report the runtime actually exercised. This ledger [supports the implemented filesystem profile](/profiles/implemented-filesystem.md "supports") without replacing its focused behavioral evidence.
