---
type: Design Proposal
title: Object references independent of paths
description: Proposes volume-local object references that survive rename while preserving caller authority and existing open-handle lifetimes.
status: draft
tags: [identity, references, authority]
sources:
  - id: core
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Runtime node identity and public capabilities
  - id: file-tests
    resource: ../../packages/core/test/File.test.ts
    title: Independent handles and open-unlinked file behavior
  - id: link-tests
    resource: ../../packages/core/test/Links.test.ts
    title: Hard-link and rename behavior
generated: { by: codex/okf, at: 2026-09-10T08:47:21Z }
---

# Object references independent of paths

Status: proposed, not accepted or implemented.

Core retains runtime object identity through rename and hard links, but exposes no generic reference for locating an existing file, directory or symlink independently of its path.[^core] A path-based adapter can address the wrong object after `/a` is renamed and another file takes its place.

Propose opaque, volume-local references in core. A credential-bound object interface would support lookup of one directory component, stat, parent lookup, reading a symlink target, and opening a regular file by reference. Wire encoding and export identifiers remain adapter responsibilities.

The reference identifies an object; it does not grant the access of the caller that obtained it. Operations must preserve the [resource and authority contract](/contracts/resources-and-authority.md "constrained by"). References must not promise identity across restore, as required by [snapshot-local identity](/decisions/snapshot-local-file-identity.md "constrained by").

## Questions to settle

- Should a reference remain usable after the final directory entry is removed, and for which operations?
- How can references avoid retaining deleted contents indefinitely while open handles preserve their current lifetime?
- Which errors distinguish foreign-volume, stale and invalid references?
- How should directory parent lookup behave after removal or movement?

## Acceptance evidence

Demonstrate that rename followed by path reuse never redirects a reference; hard-link aliases identify the same object; symlinks retain their own identity; foreign and stale references fail predictably; and different callers cannot inherit one another's authority. Existing independent-handle and open-unlinked behavior must remain intact.[^file-tests][^link-tests]

[^core]: Inspect `Metadata`, `Caller`, `FileHandle`, `DirectoryHandle`, internal Node records and rename in the current implementation.

[^file-tests]: Existing file tests cover independent handles and retention of unlinked contents while handles remain open.

[^link-tests]: Existing link tests ground alias and rename behavior; they do not validate the proposed reference interface.
