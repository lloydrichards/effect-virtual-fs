---
type: Research Report
title: Overlay filesystem direction
description: Retains the alternatives considered for overlay v1, the OverlayFS and OCI lessons that shaped it, and the parity cases a future overlay test harness should cover.
status: stable
tags: [overlay, architecture, identity, roadmap]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/8
    title: Overlay behavior design issue
  - id: core
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Volume capabilities and overlay construction
  - id: overlay-tests
    resource: ../../packages/core/test/Overlay.test.ts
    title: Representative overlay behavior, summaries and capture races
  - id: linux
    resource: https://docs.kernel.org/filesystems/overlayfs.html
    title: Linux OverlayFS semantics and limitations
  - id: oci
    resource: https://specs.opencontainers.org/image-spec/layer/
    title: OCI image layer changesets
generated: { by: claude/okf, at: 2026-09-16T23:00:00+02:00 }
---

# Overlay filesystem direction

Issue #8 asked for an ordinary volume over a read-only base with writable changes, for disposable builds and agent workspaces.[^issue] The accepted requirements are in [staged overlay delivery](/decisions/staged-overlay-delivery.md "constrained by") and its focused decisions, and the shipped behavior is specified by the [overlay workspaces contract](/contracts/overlay-workspaces.md "implemented by"). This concept retains only what those do not: the alternatives that were rejected, the external designs consulted, and the parity cases that overlay coverage does not yet exhaust.

## Alternatives considered

| Approach                                                         | Outcome                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Eager `fromSnapshot` copy of the base                            | Kept only as the behavioral reference for parity tests; it cannot share untouched contents                                     |
| Immutable base records with per-workspace object/namespace state | Chosen. Implemented as private namespace and metadata over a weak payload cache keyed by the base `Snapshot`                   |
| Independently writable upper and lower volumes as public inputs  | Rejected by the ownership decision; composing two gated volumes also gives no single commit boundary and leaks foreign handles |

Two constraints of the existing core drove the choice: one coordination gate owns every operation, capture and release, so an overlay had to live inside that gate rather than compose two volumes; and hard links, open handles and directory callers all retain direct node identity, so promotion and rename had to preserve those relationships rather than copy up.[^core]

## External designs consulted

Linux OverlayFS demonstrates upper precedence, merged directories, whiteouts and opaque directories. It also documents copy-up configurations that break hard links or change inode identity, and lower-directory renames that fail with `EXDEV`. Those limitations were treated as things an ordinary-volume overlay must not inherit.[^linux]

OCI layers describe serialized changesets, not live behavior. Their reserved `.wh.` whiteout names are the reason deletion bookkeeping stays outside this project's user namespace, where paths may hold arbitrary non-NUL bytes including a literal `.wh.x`.[^oci] Serialization questions moved to the [snapshot delta research](overlay-changes.md "refined by").

[Object references](/contracts/object-references.md "related to") and [mutation revisions](/contracts/mutation-revisions.md "related to") were considered as overlay prerequisites and rejected as such; internal lineage supports overlay comparison independently of those public APIs.

## Open: a parity harness

The overlay suites execute representative cases for workspace isolation, promotion and quotas, raw names, summary identity, capture races and reset behavior, but no harness compares an overlay against `fromSnapshot(base)` operation by operation.[^overlay-tests] Such a harness would run both under a controlled clock and compare bytes, errors, metadata, events and alias topology, normalizing inode numbers by relationship. Cases it should cover beyond the current suites:

- open hard-link `/b`, then write alias `/a`: both paths and the old handle see one updated object;
- unlink `/a`, recreate it, retain the old handle: the new path names a new object and the old handle keeps old contents;
- delete `/d/x`, remove empty `/d`, recreate `/d`: the old child stays absent;
- move a directory with edited and untouched children: the whole visible tree moves and directory callers keep identity;
- rename onto an occupied destination: prior destination handles retain their object;
- resolve a symlink into an overridden or deleted path, including relative targets and `..`;
- reject an unauthorized or impossible mutation: no changed bytes, metadata, entries or phantom watch event;
- write past remaining capacity: the allowed prefix is kept and a later `NoSpace` preserves state;
- remove all aliases while a file stays open: the logical charge remains until final close;
- hard links to symlinks, root metadata, create-exclusive after deletion, writes through unlinked handles, no-op rename to an alias, and mixed direct and adapter writers.

Physical payload sharing is proven separately, as the content-sharing decision requires.

[^issue]: Issue #8 was retrieved on 2026-09-10 with no comments. Accepted decisions record subsequent user choices; the issue is not their approval source.

[^core]: `makeVolume` owns one node graph, allocator, quota counters, publisher and gate; `makeOverlay` builds on it.

[^overlay-tests]: Sibling isolation, mutation paths, quota accounting, summaries, consistent capture and reset lifetimes.

[^linux]: Linux OverlayFS: Upper and Lower, Whiteouts and Opaque Directories, Renaming directories, Non-directories, Non-standard behavior. Consulted 2026-09-10.

[^oci]: OCI layer specification: Applying Changesets and Whiteouts. Consulted 2026-09-10; interoperability is not a target.
