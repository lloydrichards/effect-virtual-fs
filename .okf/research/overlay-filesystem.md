---
type: Research Report
title: Overlay filesystem direction
description: Retains the alternatives considered for overlay v1, the OverlayFS and OCI lessons that shaped it, and the bounded ordinary-volume parity evidence with remaining qualification gaps.
status: draft
tags: [overlay, architecture, identity, roadmap]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/8
    title: Overlay behavior design issue
  - id: core
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Volume capabilities and overlay construction
  - id: overlay-tests
    resource: ../../packages/core/test/behaviour/overlay.test.ts
    title: Representative overlay behavior, summaries and capture races
  - id: parity-tests
    resource: ../../packages/core/test/behaviour/overlayParity.test.ts
    title: Paired overlay and restored-volume scenarios
  - id: tree-observer
    resource: ../../packages/core/test/support/describeTree.ts
    title: Shared portable tree observation
  - id: linux
    resource: https://docs.kernel.org/filesystems/overlayfs.html
    title: Linux OverlayFS semantics and limitations
  - id: oci
    resource: https://specs.opencontainers.org/image-spec/layer/
    title: OCI image layer changesets
generated: { by: codex/okf, at: "2026-10-17T08:20:42Z" }
---

# Overlay filesystem direction

An overlay provides an ordinary volume over an immutable base for disposable builds and agent workspaces. The accepted requirements are in [staged overlay delivery](../decisions/overlay/staged-overlay-delivery.md "constrained by") and its focused decisions, and the shipped behavior is specified by the [overlay workspaces contract](../contracts/overlay-workspaces.md "implemented by"). This concept retains only what those do not: the alternatives that were rejected, the external designs consulted, and the parity cases that overlay coverage does not yet exhaust.

## Alternatives considered

| Approach                                                         | Outcome                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Eager `fromSnapshot` copy of the base                            | Kept only as the behavioral reference for parity tests; it cannot share untouched contents                                     |
| Immutable base records with per-workspace object/namespace state | Chosen. Implemented over the persistent volume value with shared unchanged payloads                                            |
| Independently writable upper and lower volumes as public inputs  | Rejected by the ownership decision; composing two gated volumes also gives no single commit boundary and leaks foreign handles |

Two constraints of the existing core drove the choice: one coordination gate owns every operation, capture and release, so an overlay had to live inside that gate rather than compose two volumes; and hard links, open handles and directory callers all retain direct node identity, so promotion and rename had to preserve those relationships rather than copy up.[^core]

## External designs consulted

Linux OverlayFS demonstrates upper precedence, merged directories, whiteouts and opaque directories. It also documents copy-up configurations that break hard links or change inode identity, and lower-directory renames that fail with `EXDEV`. Those limitations were treated as things an ordinary-volume overlay must not inherit.[^linux]

OCI layers describe serialized changesets, not live behavior. Their reserved `.wh.` whiteout names are the reason deletion bookkeeping stays outside this project's user namespace, where paths may hold arbitrary non-NUL bytes including a literal `.wh.x`.[^oci] Serialization questions moved to the [snapshot delta research](overlay-changes.md "refined by").

[Object references](../contracts/object-references.md "related to") and [mutation revisions](../contracts/mutation-revisions.md "related to") were considered as overlay prerequisites and rejected as such; comparison of retained base and current state supports overlay summaries independently of those public APIs.

## Bounded parity with ordinary volumes

The paired suite starts makeOverlay(base) and fromSnapshot(base) from the same fixture snapshot and runs identical public operations under TestClock. It reuses the hard-linked symlink fixture and the existing snapshot suite's portable-tree observer. Each case compares its result, tree contents and metadata, alias groups, usage, and watch trace, with independent expected results for the selected behavior.[^parity-tests]

The finite scenario set covers:

- editing through an old handle, unlinking and recreating its path, and retaining its hard-link peer;
- moving a base directory while retaining its directory handle and relative symbolic-link lookup;
- renaming onto an occupied file while the former destination handle remains readable;
- deleting a base child and directory, then recreating the empty directory without reviving old children;
- rejecting missing-source, occupied-name, and exclusive-create mutations without state changes or watch events;
- retaining a quota-limited write prefix and rejecting further growth without changing file metadata.

The observer groups paths by inode relationships instead of equating independent runtime identities. It excludes revision tokens from cross-volume tree equality; the rejected-mutation cases additionally assert unchanged metadata within each volume. Initial reads settle relatime before watches begin. A final committed sentinel ends event collection without sleeps and makes unexpected rejection events visible.[^tree-observer][^parity-tests]

This is bounded evidence, not operation-complete parity. Remaining extensions include unauthorized mutations, independent revision-change relationships, removing every file alias while a handle stays open, no-op rename to an alias, raw names, and mixed direct/adapter writers. The separate hard-linked symlink suite owns detailed cross-parent identity and dangling-target assertions rather than duplicating them here.[^overlay-tests]

Physical payload sharing is proven separately, as the content-sharing decision requires.

[^core]: `makeVolume` owns one node graph, allocator, quota counters, publisher and gate; `makeOverlay` builds on it.

[^overlay-tests]: Sibling isolation, mutation paths, quota accounting, summaries, consistent capture and reset lifetimes.

[^parity-tests]: Six paired public-API scenarios, with controlled time and independent assertions.

[^tree-observer]: Extracted unchanged from snapshot tests; compares content, portable metadata, and alias topology.

[^linux]: Linux OverlayFS: Upper and Lower, Whiteouts and Opaque Directories, Renaming directories, Non-directories, Non-standard behavior. Consulted 2026-09-10.

[^oci]: OCI layer specification: Applying Changesets and Whiteouts. Consulted 2026-09-10; interoperability is not a target.
