---
type: Contract
title: Permissions and metadata
description: Defines explicit identity-based access checks and owned metadata with nanosecond timestamps.
status: stable
tags: [permissions, metadata, timestamps]
sources:
  - resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Identity, access, and metadata implementation
  - resource: ../../packages/core/test/Metadata.test.ts
    title: Permission and metadata behavior tests
  - resource: ../../packages/memory/test/Timestamp.test.ts
    title: Adapter timestamp boundary tests
  - resource: ../../packages/core/src/VfsError.ts
    title: AccessDenied and NotPermitted codes
  - resource: ../../packages/core/src/Metadata.ts
    title: Mode schema and typedMode
  - resource: ../../packages/memory/src/internal/memoryFileSystem.ts
    title: Memory chmod masks its input to 0o7777
  - resource: ../../packages/nfs/src/internal/nfs4.ts
    title: NFS mode4 above 0o7777 rejected with INVAL
generated: { by: claude-code, at: "2026-09-26T13:20:00+02:00" }
---

# Permissions and metadata

Callers carry uid, gid, supplementary groups, explicit privilege, and umask. Traversal and operations apply owner, group, and other mode checks; new entries inherit the parent gid and apply the caller's umask.

An operation checks the mode bits it needs on the node it acts on, so reading metadata or a symbolic-link target is authorized by the traversal that reached the object and checks nothing on the object itself, as POSIX `stat` and `readlink` do. The same rule governs [object references](object-references.md "constrains").

A denial reports one of two codes, as Linux does. `AccessDenied` (EACCES) means the mode bits refuse the access. `NotPermitted` (EPERM) means the change needs ownership or privilege: chmod, chown, or explicit times by a non-owner, removing another owner's entry from a sticky directory, or an unprivileged create that names an owner.

Metadata includes file kind, identity, link count, size, ownership, mode, and bigint nanosecond timestamps. Returned metadata is copied. Core timestamps use the Effect clock without promising physical nanosecond precision.

Access times follow relatime, the Linux mount default. `readFile`, `readDirectory`, and handle reads refresh a node's access time only when it is not newer than the modification or status-change time, or is at least 24 hours old, and never when it already equals the current time. A read whose access time is not due is a pure observation that runs beside other reads and commits nothing; one that is due runs again as a change, with the same checks and codes. A handle read of zero bytes touches no access time. The [relatime reads decision](../decisions/core/relatime-reads.md "implements") records the rule.

`mode` holds the permission, setuid, setgid and sticky bits only, at most `0o7777`, and never the file-type bits; the kind is the one source of the type. `Metadata.typedMode` joins the kind's `S_IFREG`, `S_IFDIR` or `S_IFLNK` bits with `mode` to give the POSIX `st_mode`, and every adapter that reports an `st_mode` builds it that way. Snapshots, live images and the tree schema store the permission bits only. A volume has no device nodes, so `dev` and `rdev` are 0 by contract and `(dev, ino)` is unique only within one volume.

`setattr` changes size, owner, mode and times as one change, and its checks run in a fixed order with the first failure winning: every attribute validates first (`InvalidArgument` naming the attribute in `field`, and without one when the attributes are not an object), then the target resolves, then an `expected` revision that no longer matches fails `StaleReference` naming `expected`, then a size on a directory or a symbolic link fails, then ownership (`NotPermitted`) for mode, owner and explicit times, then write permission (`AccessDenied`) for size and both-now times, and last the size limits. The attributes apply as size, owner, mode, times, the POSIX composition of chown then chmod, so a requested mode keeps setuid and setgid that a resize or an owner change would clear; a protocol adapter owns any sanitising of the mode, as NFS SETATTR clears set-ID bits after Linux knfsd. An empty `setattr` checks and changes nothing, as Linux `notify_change` does without attributes. `chmod`, `chown`, `utimes` and `truncate` are one-field cases of the same change, recorded in the [atomic setattr decision](../decisions/core/atomic-setattr.md "implements").

`chmod` input differs by layer. Core rejects a mode above `0o7777` with `InvalidArgument`. The memory adapter masks its input with `0o7777`, so a stat-style mode such as `0o100644` sets `0o644`, as Node does. NFS rejects a `mode4` above `0o7777` with `INVAL`, since RFC 8881 defines only the 12 permission bits.

The memory adapter converts timestamps to JavaScript `Date` values and reports typed `InvalidData` when a core timestamp cannot be represented.

This contract [depends on the resource and authority model](resources-and-authority.md "depends on") and implements [explicit caller privilege](../decisions/core/explicit-caller-privilege.md "implements") and [adapter timestamp overflow](../decisions/adapter-timestamp-overflow.md "implements"), the [permission mode and typed mode](../decisions/core/permission-mode-and-typed-mode.md "implements") decision, and the [relatime reads](../decisions/core/relatime-reads.md "implements") decision.
