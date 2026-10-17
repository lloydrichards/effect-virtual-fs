---
type: Research Report
title: Node VFS interoperability
description: Compares Node 26.12 provider composition with snapshot overlays and separates Node runtime compatibility from portable workspace state.
status: draft
tags: [node, interop, overlay, identity]
sources:
  - id: node-api
    resource: https://github.com/nodejs/node/blob/v26.12.0/doc/api/vfs.md
    title: Versioned Node VFS API
  - id: node-release
    resource: https://nodejs.org/en/blog/release/v26.12.0
    title: Node 26.12 release and provider composition
  - id: node-probe
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/297#issuecomment-6231692267
    title: Retained composition evidence and Effect parity scope
  - id: overlay-probe
    resource: ../../packages/core/test/behaviour/overlay.test.ts
    title: Effect overlay identity and isolation behavior
  - id: evidence
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/297#issuecomment-6231692267
    title: Comparison environment and qualification limits
  - id: overlay-tests
    resource: ../../packages/core/test/behaviour/overlay.test.ts
    title: Core overlay behavior
generated: { by: codex/okf, at: "2026-10-16T19:02:37Z" }
---

# Node VFS interoperability

Node's experimental `node:vfs` integrates provider-backed files with supported `node:fs` operations and Node's loaders. It is a runtime integration, whereas this project's [overlay workspaces](../contracts/overlay-workspaces.md "contrasts with") are explicit filesystem capabilities over immutable snapshot state. Neither arrangement isolates arbitrary JavaScript execution.[^node-api]

The comparison is pinned to Node 26.12, which adds `ComposableProvider`. The article that initiated the research covered 26.10, so its absence of provider composition is no longer a useful distinction.[^node-release]

## Composition is not the same identity model

Comparative probes ran on official Node 26.12, macOS arm64. Node used memory providers. The retained issue context records the observations; existing core tests independently own Effect overlay guarantees. The observations are bounded behavioral evidence, not a benchmark or cross-platform conformance claim.[^evidence]

| Case                                                          | Node composition                                                                 | Snapshot overlay                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Mutate the source after creating the view                     | Mutable lower bytes remain visible until copy-up                                 | Captured base remains unchanged                           |
| Read an existing handle after writing its path                | Handle retains lower bytes                                                       | Handle observes the edited workspace object               |
| Read a hard-link peer after writing one name                  | Peer can retain lower bytes                                                      | Both names retain one edited object                       |
| Resolve a lower symlink to an overridden file                 | Resolves inside its provider                                                     | Resolves through the workspace namespace                  |
| Traverse a lower symlink directory                            | Tested case fails with `ENOTDIR`                                                 | Reads the target                                          |
| Rename a nonempty base directory over an empty base directory | Tested case fails with `EXDEV`                                                   | Succeeds                                                  |
| Delete then reconstruct state                                 | Reconstructing a composition from the same providers loses hidden deletions      | Complete snapshot capture and restoration retain deletion |
| Watch before copy-up                                          | Selected lower watch misses the upper write and sees a later hidden lower change | Volume watch receives the workspace update                |

The deletion row compares two different lifecycle operations. It establishes that Node's provider list alone does not contain its hidden-deletion state, not that unmounting the same composition loses deletions. The watch row compares a polled file watch with a volume watch and includes a bounded negative observation.[^node-probe][^overlay-probe]

A locked read-only Node memory lower with independent uppers passes sibling isolation. Immutable fixture bases and writable views therefore overlap. The stronger local distinctions are coherent workspace identity, state capture, and [portable snapshot deltas](../contracts/snapshot-deltas.md "contrasts with"). Node's composition also invokes synchronous lower operations during the tested promise-based append.[^node-probe]

## Effect-first direction

Use Node's design and the [retained copy experiment](node-vfs-snapshot-bridge.md "informs") as comparative evidence for Effect VFS improvements. Useful reproduction context is retained in issues rather than a committed research artifact tree. The current work targets link identity, required transfer fidelity, destination cleanup, and overlay parity. No Node bridge or adapter package is planned.

Node is not the semantic reference for our volumes. Compare overlays against restored snapshots and preserve explicit callers, scoped resources, typed failures, and existing package ownership. Successful Node loading experiments do not create a product requirement for Node integration.

Do not infer speed, startup cost, memory advantage, worker behavior, or other provider behavior from these probes. The [overlay research](overlay-filesystem.md "complements") retains the separate ordinary-volume parity questions.

[^node-api]: Versioned Node API and security statements, not an execution sandbox claim.

[^node-release]: ComposableProvider was added after the original article baseline.

[^node-probe]: Retained issue evidence covers mutable and read-only lowers, handles, aliases, hidden deletion, symlinks, renames and watches.

[^overlay-probe]: The core suite protects immutable bases, coherent handles and aliases, rename, watch delivery, and captured state.

[^evidence]: The issue comment records the tested version, platform, observations and exclusions. Transient logs and generated reports are not part of the durable bundle.
