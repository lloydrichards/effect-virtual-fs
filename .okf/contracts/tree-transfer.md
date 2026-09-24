---
type: Contract
title: Tree transfer
description: Streams directory trees between callers, snapshots, and new volumes with bounded sources and policy-driven sinks.
status: stable
tags: [memory, transfer, interop]
sources:
  - id: design-issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/29
    title: Import and export directory trees design issue
  - id: public-api
    resource: ../../packages/memory/src/TreeTransfer.ts
    title: Public tree transfer API
  - id: engine
    resource: ../../packages/memory/src/internal/treeTransfer.ts
    title: Tree transfer sources and sinks
  - id: behavior-tests
    resource: ../../packages/memory/test/TreeTransfer.test.ts
    title: Tree transfer behavior tests
generated: { by: claude/okf, at: "2026-09-24T09:10:00Z" }
---

# Tree transfer

`@effect-vfs/memory` exports `TreeTransfer`, a set of Effect `Stream` sources and `Sink` values that move a directory tree between filesystem capabilities. It is governed by the [tree transfer decision](../decisions/tree-transfer.md "implements").

## Entries

A transfer carries core fixture entries whose paths are rooted at the transfer root. The root itself is `/`, and its descendants follow it as absolute paths below `/`. A path stays a string while every component is UTF-8; otherwise it is a `BytePath`. Sources emit entries in pre-order with children sorted by name bytes, so parents always precede children and the order is deterministic. Entries carry the source's full metadata: owner, mode, and all four timestamps. Sinks decide which fields to apply.

A second name for an object already emitted becomes a `hardLink` entry that names the first path. Links to objects outside the transferred tree are emitted as ordinary entries.

## Sources

`fromCaller` reads through a live caller with that caller's permissions. It reads each entry's metadata before its contents, so entries carry the source's original access time. The reads themselves update source access times, and on a durable volume each read commits. `fromSnapshot` restores a snapshot into a private volume and walks it with a privileged caller, so it never reads or changes the original volume.

Every source enforces a complete `TreeTransferLimits` policy: `maxEntries`, `maxBytes`, `maxFileBytes`, `maxDepth`, and `maxPathBytes`. Omission uses the frozen `default` preset; `constrained` is also provided. `maxEntries` counts every emitted entry including the root. `maxBytes` counts file contents and symbolic-link targets, as volume capacity does. `maxDepth` counts components below the root, and `maxPathBytes` measures the rooted entry path. Limits are checked while streaming, before the entry is emitted; a file's size is checked before and after it is read. Exceeding a limit fails `TransferError` with code `LimitExceeded` and the field name. A malformed policy fails `InvalidArgument`.

## Live sinks

`toCaller` writes entries under a destination path through a caller, with that caller's permissions. The first entry must be the root, and every entry's parent must already have been written. Otherwise the sink fails `InvalidEntry`.

`existing: "reject"`, the default, creates the destination root exclusively, so an existing destination fails `AlreadyExists` before anything is written. If the transfer then fails or is interrupted, a scope finalizer removes the root it created. If that cleanup fails, the failure joins the transfer's cause as a defect. A crash leaves the partial tree in place. Watchers see the partial tree while the transfer runs.

`existing: "overwrite"` merges into existing directories and replaces existing files and symbolic links. A file replacement is one atomic write that can replace a final symbolic link. A file and directory clash, or an existing destination directory where a symbolic link is expected, fails. Destination symbolic links are never followed as directories. Overwrite never removes anything on failure, and entries deleted from the source are never removed from the destination.

`times` selects which timestamps are applied: `"none"`, `"mtime"` (the default), or `"all"`. Permission bits are always applied. setuid, setgid, and sticky bits are applied only with `specialBits: true`. Directories are created with owner access and receive their exact mode and times after all their children are written, so read-only source directories can be copied by unprivileged callers. Owner fields are not applied.

The sink returns a `TransferReport` with the number of entries, files, and file bytes written.

## New volumes

`toVolume` collects the stream and builds a new volume through `fromFixture`. Nothing is visible unless every entry is accepted. The first entry must be the `/` directory. Metadata is kept exactly, including change and birth times, because the result is a fresh isolated volume. The collected entries and the intermediate image are held in memory until the volume is built.

## Composition

Exclusion, merging several sources, and progress use ordinary `Stream` operators on the entry stream. A filter that removes a directory must also remove its descendants, and a hard link whose first path was removed fails `InvalidEntry` at the sink.

## Exclusions

This contract does not yet cover host filesystem sources and sinks, owner preservation, following symbolic links, rejecting symbolic links that escape the tree, skipping unrepresentable entries, mirror or delete semantics, or a progress API.
