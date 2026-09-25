---
type: Decision
title: Persistent tree rebuild
description: Rebuilds the core engine on a persistent tree value with one transaction runner, composes staging, overlay, and watch over it, collapses serialisation to one tree schema, and halves the public surface, staged as ordered refactors and designs.
status: stable
tags: [core, engine, effect, staging, overlay, watch, snapshots, api, refactor]
sources:
  - id: sequencing-issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/189
    title: Sequencing and handover discussion
  - id: idioms
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/178
    title: Step 1, Effect idioms in the engine
  - id: merge-families
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/179
    title: Step 2, merge path and reference operation families
  - id: handles
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/180
    title: Step 3, handle lifecycles
  - id: watch
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/181
    title: Step 4, watch hub and test seams
  - id: tree-value
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/184
    title: Steps 5 and 6, persistent tree value and transaction runner
  - id: draft-a
    resource: https://github.com/lloydrichards/effect-virtual-fs/pull/202
    title: Draft A, the engine on a persistent volume value
  - id: draft-b
    resource: https://github.com/lloydrichards/effect-virtual-fs/pull/203
    title: Draft B, staging as a commit decorator, overlay as a layer, permits split
  - id: inode-table
    resource: ../../../packages/core/src/internal/inodeTable.ts
    title: The persistent inode table
  - id: serialisation
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/185
    title: Step 7, one tree schema and streaming codecs
  - id: public-api
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/186
    title: Step 8, public API on a Target ADT with services and layers
  - id: test-volume
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/183
    title: Layer-based test volume
  - id: memory-companion
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/187
    title: Memory helpers to move into core
  - id: nfs-companion
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/188
    title: Capabilities the NFS server emulates
  - id: persistence-companion
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/182
    title: Persistence limit validation and shared helpers
  - id: engine
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: "The engine: volume value, draft, transition runner, commit decorator"
  - id: public-module
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Current public surface
  - id: serialisation-code
    resource: ../../../packages/core/src/internal/snapshotDelta.ts
    title: Current delta computation and verification
generated: { by: claude/okf, at: "2026-09-25T22:30:00+02:00" }
---

# Persistent tree rebuild

The core engine is rebuilt around one idea: the volume's state is a persistent, immutable tree value, and every operation is a pure transition run by a single pipeline. Staging, overlay, watch, and revisions compose over that pipeline as decorators and layers rather than living inside it. Serialisation collapses to one Schema-defined tree, and the public surface halves behind a target type. The work is staged as ordered refactors with clear goals and designs with open questions, so it can be handed over or taken up step by step. The [sequencing issue](https://github.com/lloydrichards/effect-virtual-fs/issues/189 "discusses") owns the order and handover discussion. Steps 1 to 6 are delivered; the engine half of this decision is stable, and steps 7 and 8 stay planned.

## Why now

A six-part audit on 2026-09-24 found the behaviour correct and covered by the focused contracts, and the structure accreted. The engine is one 3,350-line closure. Durable volumes bolt a second state model onto the first: every mutation deep-copies the reachable tree, an ambient `activeStage` is consulted at 21 sites, and getter shims redirect every node and handle access while a stage is active. Each live commit re-encodes the whole image. Path-addressed and reference-addressed operations are two ~850-line copies of the same verbs, so every fix is made twice and the path family lacks the revision results the [mutation revisions contract](../../contracts/mutation-revisions.md "describes") specifies. Four tree models describe one tree, twin wire schemas decode input twice, and a snapshot delta lists every object in the target. The public `Caller` has 47 members for about 20 operations, no `Volume` service or `Layer` exists, five unrelated error classes coexist, and every constructor requires `Crypto` and can fail with `PlatformError`. Consumers reimplement what core withholds: memory carries ten byte-path helpers and two recursive removes, NFS invents filehandles that expire on restart and re-validates names, persistence encodes and decodes the same bytes to check a limit.

## The target shape

An inode is a directory, a file, or a symbolic link, and carries its own names: a directory its parent and name, a file or symbolic link the links that reach it, so paths and hard-link aliases need no sibling scan. Inodes live in a persistent 32-way vector trie keyed by inode number, chosen after Effect's `HashMap` missed the performance gate because it compares values on every write and hashes every key. The whole state, including file open counts, the next inode, the revision, and usage, is one immutable value. A transition builds a draft against that value and installs it in one place; a failed or interrupted change discards its draft. One pipeline admits, resolves, authorises, mutates, commits, and installs; observations take one of the volume's permits and changes take them all. Path and reference inputs both resolve to a target of parent inode and entry name, so each verb has one body. The revision advances once per transition and is stamped on every inode the transition replaced; an object reference stays an opaque token interned per inode, and a removed directory's reference is stale at once. The registry that maps a token to its volume and inode stays a module-level `WeakMap` keyed by the token, although the issue first listed it among the maps to remove: it holds no engine state, and it is what makes a forged token fail as `InvalidReference`, because a token that carried its own inode could be copied and edited.

A staging candidate is then just the finished draft's value. Staging decorates the commit: prepare the next value, offer it to the image store, then install it on a committed answer; a rejection discards the draft and an uncertain answer stops the volume. The copy, the ambient stage, the node cells, and the handle shims are gone, and a durable mutation's engine cost no longer grows with the tree; the commit still encodes the whole image until incremental live commits ship in step 7. Overlay is a layer: the base snapshot restores once into a value kept on the snapshot handle, every workspace starts from it and so shares its unchanged inodes and payloads, and `changes()` folds that value against the current one. Watch publishes committed transactions through a hub, keeping the per-subscriber bounded queue and the rescan marker that the [watch event overflow decision](watch-event-overflow.md "preserves") requires. `Volume.watch` stays an effect that returns only once its subscriber is registered, so a caller can subscribe and then write; a lazy `Stream` would register on first pull. Each handle owns a scope forked from the scope that opened it, with its finalizer registered before the open waits for the permit, so explicit close and scope cleanup are the same release, as the [explicit close decision](explicit-close-and-scope-cleanup.md "preserves") requires.

Snapshots, live images, fixtures, and deltas share one Schema tree with content as inline bytes or a content hash reference. Validation runs once as a Schema check whose issue path yields the error field. A delta carries a base digest, a target digest, and change events; diff and apply skip unchanged subtrees through Merkle digests; a fixture is a delta over the empty tree. Codecs stream through `Stream` and `Sink` with one budget schema. Snapshot version 1 stays decodable for one minor with a migration helper, which the [strict version 1 decoding decision](strict-snapshot-v1-decoding.md "permits") allows because it never pinned forward compatibility.

Publicly, a `Target` tagged enum of path, reference, or handle and an `Entry` of directory target and name take `Caller` to about 20 verbs with one naming scheme. `Volume` and `Caller` become services with static layers, one `Schema.TaggedError` family with a code, field, path, and cause replaces the five classes, constructors no longer require `Crypto`, options are Schema structs with decoding defaults owned by the public modules, and `Snapshot`, `SnapshotDelta`, and `BytePath` become importable subpaths. This completes what the [explicit API and Effect services decision](explicit-api-and-effect-services.md "extends") promised as a thin service layer.

## Sequence

1. Effect idioms in the engine: operation context and one error helper, semaphore admission, `ensuring` for the exit rethrow, causes carried, one decode helper, return values instead of out-parameters.
2. Merge the operation families through a resolved target, one verb per pull request.
3. Handle lifecycles: each handle owns a forked scope, one helper serves every open, and explicit close and scope cleanup share one release. The `Ref` cursor moves to step 6, where staging stops owning rollback.
4. The watch hub owns its overflow state, and test seams become a `Context.Reference`. `Volume.watch` stays an effect, and computing watch paths at the mutation site waits for the reverse name index in step 5.
5. Persistent tree behind the existing state for the non-staged path, whole suite green. Delivered by [Draft A](https://github.com/lloydrichards/effect-virtual-fs/pull/202 "delivered by").
6. Staging as a `commit` decorator and overlay as a layer, on one stacked branch. Delivered by [Draft B](https://github.com/lloydrichards/effect-virtual-fs/pull/203 "delivered by"), which also splits the permits and closes the watch subscriber leak.
7. Serialisation version 2: one tree schema, change-event deltas, streaming codecs.
8. Public API on targets, services, and one error family, shipped as one breaking 0.6.0 without a deprecation minor. Delivered by the [public API decision](public-api-targets-services-and-errors.md "delivered by") across five stacked drafts; the layer-based test volume follows in #183.

Steps 1 to 4 are safe on the current tree and independently shippable, and all four merged on 2026-09-25; the decision comments on #178 to #181 record where they differ from the original plan. Steps 5 and 6 landed as two stacked drafts on the same day, proven by a differential harness of 16,041 scenarios against the old engine that differs only in revision values; the decision comments on #184 record the trie in place of `HashMap`, the number-keyed inode, and the directory holds kept beside the value. The consumer companions for memory, NFS, and persistence decide what core must offer and run alongside the discussion.

## What must not change

Every focused contract stays in force: per-operation atomicity and interruptible waiting from [mutation and observation](../../contracts/mutation-and-observation.md "preserves"), revision rules, reference identity across rename, handle and caller lifetimes from [resources and authority](../../contracts/resources-and-authority.md "preserves"), path rules and the `path.ts` module verbatim from [paths and namespace](../../contracts/paths-and-namespace.md "preserves"), bounded watch with no replay, overlay content sharing and final-difference ordering, durable outcome codes, the `LiveImageStore` service contract, the `FsCode` set that memory and NFS key on, and the [package boundaries](../package-boundaries.md "preserves") that keep host services out of core.

## Consequences

The engine has not yet lost lines: its two restore paths and the draft are written out in full, and step 7's one tree schema is where they fold. Serialisation should lose more than half. The larger gain is already in place: a candidate, an overlay, and a snapshot are values of one type, and a delta will be. That unlocks incremental live commits, overlays on live bases, the three-way merge in issue 174, the subtree-restricted caller in issue 28, and reliable observation revisions in issue 31 as folds and views over the same value. The cost is one coordinated public major and a stacked branch for steps 5 and 6 that must re-prove the staging outcomes before it merges.
