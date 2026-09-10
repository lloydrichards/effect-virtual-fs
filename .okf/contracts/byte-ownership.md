---
type: Contract
title: Byte ownership
description: Requires execution-time copying of mutable byte inputs and independently owned byte observations.
status: stable
tags: [bytes, ownership, isolation]
sources:
  - resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Core byte APIs
  - resource: ../../packages/core/test/FixtureOwnership.test.ts
    title: Fixture ownership tests
  - resource: ../../packages/core/test/WholeFile.test.ts
    title: Whole-file ownership tests
generated: { by: codex/okf, at: 2026-09-10T00:00:00Z }
---

# Byte ownership

Effects consume mutable byte inputs when the Effect executes, then copy bytes before retaining them. Reads, raw directory names, raw link targets, snapshots, fixtures, and restored volumes do not expose shared mutable storage.

This boundary prevents callers from changing filesystem state through buffers they still own and prevents observations from mutating the volume. It applies to subarrays and rejects unusable detached or shared inputs where the API cannot preserve the contract.

The contract is established by [copying byte ownership](/decisions/copying-byte-ownership.md "constrained by").
