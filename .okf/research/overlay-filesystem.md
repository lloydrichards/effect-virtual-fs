---
type: Research Report
title: Overlay filesystem direction
description: Records the evidence and alternatives that led to the implemented overlay v1 boundary and its deferred work.
status: draft
tags: [overlay, architecture, identity, roadmap]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/8
    title: Overlay behavior design issue
  - id: core
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Volume capabilities, node graph, coordination and snapshot construction
  - id: images
    resource: ../../packages/core/src/internal/image.ts
    title: Snapshot graph and strict version 1 codec
  - id: adapter
    resource: ../../packages/memory/src/MemoryFileSystem.ts
    title: Binding an ordinary volume to Effect FileSystem
  - id: snapshot-tests
    resource: ../../packages/core/test/Snapshot.test.ts
    title: Snapshot isolation and graph behavior
  - id: link-tests
    resource: ../../packages/core/test/Links.test.ts
    title: Aliases, namespace replacement and byte paths
  - id: file-tests
    resource: ../../packages/core/test/File.test.ts
    title: Handles, I/O and capacity behavior
  - id: replacement-tests
    resource: ../../packages/core/test/Replacement.test.ts
    title: Publication and failed replacement invariants
  - id: metadata-tests
    resource: ../../packages/core/test/Metadata.test.ts
    title: Caller authority and metadata behavior
  - id: namespace-tests
    resource: ../../packages/core/test/Namespace.test.ts
    title: Directory identity and namespace behavior
  - id: binding-tests
    resource: ../../packages/memory/test/CoreBinding.test.ts
    title: Shared volume behavior through direct and adapter callers
  - id: overlay-tests
    resource: ../../packages/core/test/Overlay.test.ts
    title: Representative overlay behavior, summaries and capture races
  - id: linux
    resource: https://docs.kernel.org/filesystems/overlayfs.html
    title: Linux OverlayFS semantics and limitations
  - id: oci
    resource: https://specs.opencontainers.org/image-spec/layer/
    title: OCI image layer changesets
generated: { by: codex/okf, at: 2026-09-10T14:35:31Z }
---

# Overlay filesystem direction

Issue #8 requests an ordinary volume over a read-only base and writable changes for disposable builds and agent workspaces.[^issue] Start with [staged delivery](/decisions/staged-overlay-delivery.md "constrained by") and its focused decisions for accepted requirements. The resulting behavior is specified by [overlay workspaces](/contracts/overlay-workspaces.md "implemented by"). This concept retains the alternatives and implementation rationale; deferred delta work remains draft.

## Current implementation constraints

`Volume` exposes `caller`, `watch` and `snapshot`; `MemoryFileSystem.bind(volume)` is the existing adapter boundary.[^core][^adapter] Preserve the [volume, caller and handle model](/architecture/volume-caller-handle-model.md "constrained by").

`makeVolume` owns one mutable node graph, inode allocator, quota counters, publisher and semaphore. Directory entries and handles retain direct node references. There is no existing layer resolver or pluggable storage interface. `fromSnapshot` eagerly reconstructs nodes and decodes contents; snapshots assign image-local IDs and retain no cross-capture lineage.[^core][^images]

| Current mechanism                                                                            | Overlay implication                                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Hard links and open handles share nodes; directory callers retain identity                   | Writable promotion and rename must preserve those relationships                                         |
| One gate coordinates operations, capture and release                                         | Composing calls to two backing volumes does not provide one commit boundary                             |
| Caller credentials govern traversal and metadata; handles retain open-time access            | Backing access must not bypass authority or leak foreign-volume handles                                 |
| Reads update access times without watch events; watches contain paths, no replay or payloads | Private metadata must preserve read behavior; event collection cannot compute authoritative final state |
| Snapshot traversal visits reachable nodes once                                               | Exclude hidden/deleted entries and unlinked-open objects; preserve aliases                              |
| Paths retain arbitrary non-NUL bytes and resolve symlinks component by component             | Avoid full-path upper/lower fallback and reserved marker names such as `.wh.x`                          |
| Handle writes can return a quota-limited prefix                                              | Preserve short successful writes; rejection guarantees do not turn these into all-or-nothing writes     |

These are current code facts.[^core] The public `maxBytes` comment mentions only regular files, but the implementation and [capacity contract](/contracts/capacity-and-limits.md "constrained by") also charge symlink targets. This existing wording discrepancy does not justify changing accounting.

## Architecture comparison

| Approach                                                         | Assessment after the decisions                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Eager `fromSnapshot`                                             | Behavioral reference only; does not satisfy shared-content requirements                                                   |
| Immutable base records with per-workspace object/namespace state | Recommended investigation; fits existing identity and can share untouched contents. Exact storage and caching remain open |
| Independently writable upper/lower volumes                       | Excluded as public inputs by accepted ownership; also complicates identity, traversal and atomicity                       |

Linux OverlayFS demonstrates upper precedence, merged directories, whiteouts and opaque directories. It also documents copy-up configurations that break hard links or alter inode identity, and lower-directory rename that may fail `EXDEV`. Those limitations must not replace ordinary-volume behavior. Mounted-layer external mutation is restricted.[^linux]

OCI describes serialized changesets, not live volume behavior. Whiteouts hide lower entries and opaque markers hide inherited children. Its reserved `.wh.` names are a reason to keep deletion bookkeeping outside this project's user namespace.[^oci] [Deferred delta research](overlay-changes.md "refined by") owns later serialization questions.

Public [object references](object-references.md "related to") and [mutation revisions](mutation-revisions.md "related to") remain separate draft proposals, not overlay prerequisites. Internal lineage can support overlay comparison without accepting those APIs.

## Behavior evidence to preserve

The following broader parity matrix guides overlay coverage. The current overlay suites execute representative cases for workspace isolation, promotion and quotas, raw names, summary identity, capture races and reset behavior, but do not exhaust this matrix.[^overlay-tests] Future parity tests should compare ordinary operations against `fromSnapshot(base)` with a controlled clock. Compare bytes, errors, metadata, events and alias topology; normalize inode numbers by relationships across volumes. Separately prove physical sharing as required by the content-sharing decision.

| Case                                                | Expected behavior                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Write in one of two workspaces                      | Base and sibling stay unchanged                                                           |
| Open hard-link `/b`, then write alias `/a`          | Both paths and the old handle see the same updated object                                 |
| Unlink `/a`, recreate it, retain old handle         | New path names a new object; old handle retains old contents                              |
| Delete `/d/x`, remove empty `/d`, recreate `/d`     | Old child stays absent                                                                    |
| Move a directory with edited and untouched children | Whole visible tree moves; directory callers and handles retain identity                   |
| Rename onto an occupied destination                 | New destination names source; prior destination handles retain their object               |
| Resolve a symlink to an overridden or deleted path  | Component-wise visible namespace resolution, including relative targets and `..`          |
| Read or edit metadata on a base file                | Private metadata changes; content stays shared                                            |
| Reject an unauthorized or impossible mutation       | No changed bytes, metadata, entries or phantom watch event                                |
| Write past remaining capacity                       | Preserve the allowed prefix and returned count; later `NoSpace` rejection preserves state |
| Remove all aliases while a file stays open          | Retain logical charge until final close; omit unreachable content from snapshots          |
| Race capture with write/rename, then write again    | Summary matches captured snapshot; neither result changes later                           |
| Use raw byte names or literal `.wh.x`               | No lossy conversion or marker collision                                                   |

Also cover hard links to symlinks, root metadata, create-exclusive after deletion, append and positional I/O, writes through unlinked handles, no-op rename to an alias, and mixed direct and adapter writers. Summary-specific examples belong to its decision.

Existing reference suites cover snapshot isolation, links, handles, replacement rejection, metadata authority, directory identity and adapter sharing.[^snapshot-tests][^link-tests][^file-tests][^replacement-tests][^metadata-tests][^namespace-tests][^binding-tests] Run from the repository root:

```sh
./node_modules/.bin/vitest run \
  packages/core/test/Snapshot.test.ts \
  packages/core/test/Links.test.ts \
  packages/core/test/File.test.ts \
  packages/core/test/Replacement.test.ts \
  packages/core/test/Metadata.test.ts \
  packages/core/test/Namespace.test.ts \
  packages/memory/test/CoreBinding.test.ts
```

Passing these suites establishes the existing reference behavior, not overlay correctness or sharing.

## Resolved v1 implementation choices

- `@effect-vfs/core` exports `makeOverlay` and `OverlayVolume`; the capability remains directly usable by the memory adapter.
- A weak cache keyed by the actual `Snapshot` shares immutable regular-file payloads. Namespace nodes and metadata remain private, and every content mutation replaces the whole-file content object.
- Initial nodes retain private snapshot-record lineage. Comparison pairs only one removed and one added name per lineage, classifies replacements after rename pairing, and sorts raw bytes using the rename source as its primary path.
- Summary records use `Added`, `Removed`, `Replaced`, `Renamed`, and `Updated`, with explicit field differences. Directory moves may produce records for descendants.
- `includeTimestamps` controls all four time fields. Default records still expose content, mode and ownership changes while omitting timestamp details.
- `capture` encodes the complete image and copies path/lineage observations under the existing volume gate, then compares stable inputs. This makes no capture-latency promise.
- A saved complete snapshot restores visible state only. Calling `makeOverlay` on it establishes a new baseline with an empty summary.
- Equivalent snapshots decoded as distinct objects do not share cached payloads. Identical writes may retain private storage even when the final content difference cancels.

The implementation deliberately avoids delta encoding, a general storage-provider API, live bases, or public object references.

[^issue]: Issue #8 was retrieved on 2026-09-10 with no comments. Accepted decisions record subsequent user choices; the issue is not their approval source.

[^core]: Inspect `makeVolume`, `FileReference`, `DirectoryReference`, lookup, `coordinated`, handle writes, `publishNode`, reads and `Volume.snapshot`.

[^images]: Snapshot records form a complete image-local graph. Restore creates fresh runtime objects, not overlay lineage or live resources.

[^adapter]: `MemoryFileSystem.bind` accepts `Vfs.Volume` with independent caller and descriptor state per binding.

[^linux]: Linux OverlayFS: Upper and Lower, Whiteouts and Opaque Directories, Renaming directories, Non-directories, Non-standard behavior. Consulted 2026-09-10.

[^oci]: OCI layer specification: Applying Changesets and Whiteouts. Consulted 2026-09-10; interoperability is not a target.

[^snapshot-tests]: Isolation, graph preservation and racing namespace capture.

[^link-tests]: Alias identity, namespace replacement, symlinks and byte paths.

[^file-tests]: Cursors, short writes, rejected growth and retained unlinked content.

[^replacement-tests]: Replacement authority and rejected-state preservation.

[^metadata-tests]: Open-time access and caller-bound metadata changes.

[^namespace-tests]: Directory caller and handle identity through moves.

[^binding-tests]: Direct callers and independent adapter bindings share a volume.

[^overlay-tests]: Representative overlay behavior includes sibling isolation, mutation paths, quota accounting, summaries, consistent capture and reset lifetimes.
