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
  - id: snapshot-entries
    resource: ../../packages/core/src/internal/image.ts
    title: Core's snapshot walk that fromSnapshot reads
  - id: host-adapter
    resource: ../../packages/memory/src/internal/treeTransferFileSystem.ts
    title: Effect FileSystem source and sink
  - id: behavior-tests
    resource: ../../packages/memory/test/TreeTransfer.test.ts
    title: Tree transfer behavior tests
  - id: host-tests
    resource: ../../packages/memory/test/TreeTransferFileSystem.test.ts
    title: Host filesystem round-trip tests
generated: { by: claude/okf, at: "2026-09-26T14:30:00+02:00" }
---

# Tree transfer

`@effect-vfs/memory` exports `TreeTransfer`, a set of Effect `Stream` sources and `Sink` values that move a directory tree between filesystem capabilities. It is governed by the [tree transfer decision](../decisions/tree-transfer.md "implements").

## Entries

A transfer carries core fixture entries whose paths are rooted at the transfer root. The root itself is `/`, and its descendants follow it as absolute paths below `/`. A path stays a string while every component is UTF-8; otherwise it is a `BytePath`. Sources emit entries in pre-order with children sorted by name bytes, so parents always precede children and the order is deterministic. Entries carry the source's full metadata: owner, mode, and all four timestamps. Sinks decide which fields to apply.

A second name for an object already emitted becomes a `hardLink` entry that names the first path. Links to objects outside the transferred tree are emitted as ordinary entries.

## Sources

`fromCaller` reads through a live caller with that caller's permissions. It reaches the root and every entry below it by its path, never following a final link, so it holds no directory handle while it streams, it needs search permission on each directory above an entry, as a path lookup does, and it does not follow a directory renamed out of the tree. It reads each entry's metadata before its contents, so entries carry the source's original access time. The reads themselves refresh source access times under relatime, so only a read whose access time is due changes the source, and on a durable volume only such a read commits. `fromSnapshot` walks the snapshot's own value through core's `snapshotEntries`, resolving the root as a privileged caller at `/` would, so it restores no volume and never reads or changes the original volume. Its entries, their order and every limit's field match `fromCaller`, and both charge one budget; the snapshot already holds every listing and file, so `fromSnapshot` charges it entry by entry as each is emitted, and one directory past `maxEntries` is refused at the entry that overflows, after the entries before it, rather than when its listing is read.

Every source enforces a complete `TreeTransferLimits` policy: `maxEntries`, `maxBytes`, `maxFileBytes`, `maxDepth`, and `maxPathBytes`. Omission uses the frozen `default` preset; `constrained` is also provided. `maxEntries` counts every emitted entry including the root. `maxBytes` counts file contents and symbolic-link targets, as volume capacity does. `maxDepth` counts components below the root, and `maxPathBytes` measures the rooted entry path. Limits are checked while streaming, before the entry is emitted. `fromCaller` also checks a file's size before it is read, and fails a directory listing that would exceed `maxEntries` before any of its children are visited. Exceeding a limit fails `TransferError` with code `LimitExceeded` and the field name. A malformed policy fails `InvalidArgument`.

## Live sinks

`toCaller` writes entries under a destination path through a caller, with that caller's permissions. The first entry must be the root, every entry's parent must already have been written, and no path component may be empty, `.`, or `..`. Otherwise the sink fails `InvalidEntry`; an empty stream fails too, rather than reporting an empty copy.

`existing: "reject"`, the default, creates the destination root exclusively, so an existing destination fails `AlreadyExists` before anything is written. If the transfer then fails or is interrupted, a scope finalizer removes the root it created, restoring owner access to each directory first, and only while the destination is still the object the sink created. Applying final directory modes and times is uninterruptible. If that cleanup fails, the failure joins the transfer's cause as a defect. A crash leaves the partial tree in place. Watchers see the partial tree while the transfer runs.

`existing: "overwrite"` merges into existing directories and replaces existing files and symbolic links. A file replacement is one atomic write that can replace a final symbolic link. A file and directory clash, or an existing destination directory where a symbolic link is expected, fails. Destination symbolic links are never followed as directories. Overwrite never removes anything on failure, but directories it created get their final modes back. Entries deleted from the source are never removed from the destination.

`times` selects which timestamps are applied: `"none"`, `"mtime"` (the default), or `"all"`. Permission bits are always applied. setuid, setgid, and sticky bits are applied only with `specialBits: true`. Directories are created with owner access and receive their exact mode and times after all their children are written, so read-only source directories can be copied by unprivileged callers. Final modes are exact and bypass the caller's umask, as file modes already do; a mode that is already exact is not reapplied. Owner fields are not applied.

The sink returns a `TransferReport` with the number of entries, files, and file bytes written, the skipped entries, and the number of degraded hard links. `toCaller` never skips or degrades.

## New volumes

`toVolume` collects the stream and builds a new volume through `fromFixture`. Nothing is visible unless every entry is accepted. The first entry must be the `/` directory, and entries follow the same placement rules as the live sinks: parents first, no repeated paths, and hard links after their targets. All four timestamps are kept. Owners are kept only with `owner: true`, and setuid, setgid, and sticky bits only with `specialBits: true`; otherwise entries are owned by uid and gid 0 and keep permission bits only. Volume options go in `volume`. The collected entries and the intermediate image are held in memory until the volume is built.

## Effect FileSystem adapter

`fromFileSystem` and `toFileSystem` adapt an application-provided Effect `FileSystem`, such as the host filesystem. That interface decodes names as UTF-8 strings, reports times in milliseconds, has no change time, and follows symbolic links in `stat`. Host paths use `/` separators.

The source treats a name as a symbolic link when its resolved path differs from the path its canonical parent predicts, or when it cannot be resolved, including a link that loops; link entries carry no metadata. A name that can be neither resolved nor read as a link is unsupported. A name containing the Unicode replacement character, and a FIFO, socket, device, or unknown entry, fails `UnrepresentableName` or `UnsupportedEntryType`. With `unsupported: "skip"` the source omits it and passes a `SkippedEntry` to `onSkip`, which logs a warning by default. Source skips reach only `onSkip`; the sink's report lists the entries the sink itself skipped. Hard links are detected by device and inode when the host reports an inode number and a link count above one, and an identity is forgotten once every alias has been seen. Files are read in bounded chunks, so an oversized or growing file fails `maxFileBytes` without being read whole. A FIFO swapped in after its type is checked can still block the read.

The sink claims and cleans up its root as `toCaller` does, checking the root's device and inode before removing it. In overwrite mode it classifies an existing name as absent, a link, or a real entry before replacing it, and fails `DestinationConflict` rather than merge through a linked directory. Every file is written with an exclusive create, which never follows a link at the name, so a replacement is a removal followed by a new file: it is not atomic, and a failure between the two leaves the name absent. Files are created with the host umask and then receive their exact mode. The mode and time changes after creation still resolve the name, so a link swapped in by another process after creation is a remaining gap. Times are truncated to milliseconds, and owners, change and birth times, and link metadata are not written.

Symbolic links are created after every other entry. With `escaping: "reject"`, the default, the sink first fails `EscapingSymlink` if any target is absolute or resolves outside the tree, following `..` and links within the tree up to 40 hops and matching link names case- and Unicode-insensitively; a symbolic-link root always escapes. After creating each link it also resolves the link on the host, through its deepest existing ancestor when it dangles, which catches host name folding and links that were already in the destination; a link that resolves outside is removed and the sink fails `EscapingSymlink`. `escaping: "allow"` skips the check. A non-UTF-8 path or target fails `UnrepresentableName`. Inside a claimed root an existing name can only come from host name folding, so it fails `NameCollision`. With `unsupported: "skip"` these entries, and descendants of skipped directories, are recorded in the report's `skipped` list instead. A hard link the host cannot create is written as an exclusive copy with the source file's mode and times; a name collision or missing target stays a failure. A hard link to a symbolic link becomes another link whose relative target is rewritten for its own directory. Both count in `hardLinksDegraded`.

`SinkCapabilities` declares what each destination preserves: `caller`, `volume`, and `fileSystem`.

## Composition

Exclusion, merging several sources, and progress use ordinary `Stream` operators on the entry stream. A filter that removes a directory must also remove its descendants, and a hard link whose first path was removed fails `InvalidEntry` at the sink.

## Exclusions

This contract does not cover owner preservation for live sinks, following symbolic links, escape checks for `toCaller`, mirror or delete semantics, a progress API, or platform path separators other than `/`.
