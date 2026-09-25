---
type: Decision
title: Reference-based mutations
description: Adds directory-reference-and-name mutation operations to the caller beside the path operations, fixes their return shape and authority, and keeps share reservations and locks out of core.
status: stable
tags: [references, mutation, authority, nfs, adapters]
sources:
  - id: implementation-issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/96
    title: Reference-based mutation implementation issue
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/46
    title: Writable adapter and VFS capability boundary design issue
  - id: core
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Caller, reference operations, and open settings
  - id: engine
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Coordination gate, open counts, and timestamps
  - id: export
    resource: ../../../packages/nfs/src/internal/export.ts
    title: NFS export wrapper over reference operations
  - id: dispatcher
    resource: ../../../packages/nfs/src/internal/nfs4.ts
    title: Open state and read-only rejections
  - id: rfc8881
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: RFC 8881 NFSv4.1
  - id: buildbarn
    resource: https://github.com/buildbarn/bb-remote-execution/tree/master/pkg/filesystem/virtual
    title: Buildbarn in-memory virtual filesystem backend
  - id: knfsd
    resource: https://github.com/torvalds/linux/blob/master/fs/nfsd/vfs.c
    title: Linux nfsd VFS glue
  - id: ganesha
    resource: https://github.com/nfs-ganesha/nfs-ganesha/blob/next/src/include/fsal_api.h
    title: nfs-ganesha FSAL object operations
  - id: nfs4j
    resource: https://github.com/dCache/nfs4j/blob/master/core/src/main/java/org/dcache/nfs/vfs/VirtualFileSystem.java
    title: nfs4j VirtualFileSystem interface
  - id: fuse
    resource: https://github.com/libfuse/libfuse/blob/master/include/fuse_lowlevel.h
    title: libfuse low-level inode operations
  - id: go-nfs
    resource: https://github.com/willscott/go-nfs
    title: Path-based NFS server and its documented limitations
generated: { by: codex/okf, at: 2026-09-20T11:50:43Z }
---

# Reference-based mutations

Accepted by the user on 2026-09-17 while resolving the mutation half of issue #46.[^issue] The [object references contract](../../contracts/object-references.md "extends") initially gave adapters stable identity and read-only reference operations, while mutations used paths. A writable network adapter needs to mutate the object a filehandle names without a path, learn the result without a second lookup, and report directory changes from the same state transition. This concept fixes how core provides that and what stays outside it. The durability half of the issue is recorded in [volume durability and usage facts](volume-durability-and-usage-facts.md "complements").

## Why not path calls

Before reference mutations, path operations accepted a live `DirectoryHandle` base, but adapters could not open an object reference for writing or obtain mutation results tied to its identity.[^core] An adapter would have to look the name up again after creating it, and a concurrent replacement between the two calls hands the client a handle for the wrong object. Every surveyed backend addresses mutations by directory reference and name component: the FUSE low-level API, the ganesha FSAL, Linux nfsd, Buildbarn, nfs4j, and 9P2000.L.[^fuse][^ganesha][^knfsd][^buildbarn][^nfs4j] The one path-based server documents the resulting breakage of hard links and renamed handles.[^go-nfs]

## Decisions

1. **Additive reference mutations.** `Caller` gains mutation operations addressed by `(directoryReference, nameBytes)`. The path operations stay for applications and the memory adapter; nothing is rebuilt on references.
2. **One vocabulary.** The operations mirror the path operations one to one: `mkdirReference`, `symlinkReference`, `linkReference`, `unlinkReference`, `rmdirReference`, `renameReference`, `chmodReference`, `chownReference`, `utimesReference`, and `truncateReference`, each taking its path twin's option vocabulary. A fused remove or a masked attribute bundle, as Buildbarn and ganesha expose, is not added; NFS `REMOVE` composes unlink or rmdir from the observed kind, and `SETATTR` applies attributes in sequence and reports which took, which RFC 8881 Section 18.30.4 permits because `SETATTR` is not required to be atomic.[^rfc8881]
3. **Authority and layered name validation.** Each operation requires on the referenced directory or object exactly the mode bits its path-based equivalent requires on the resolved node, the rule the read-only reference operations already follow. Core validates and owns every byte component before waiting for the gate: empty, dot, dot-dot, slash, NUL, detached, shared, and over-limit inputs fail. Adapters may apply stricter protocol rules such as the NFS profile's exact UTF-8 requirement.
4. **Results carry identity and change.** `DirectoryChange` is a Schema value with `before` and `after`; equal revisions represent a successful namespace no-op. `mkdirReference`, `symlinkReference`, and `linkReference` share `ReferenceEntryResult`, which adds the exact resulting `ObjectReference`. `RenameReferenceResult` is a Schema tagged union distinguishing one changed directory from two distinct directories. Both revisions are captured inside the mutation's single coordination-gate hold. Core carries neither a redundant `changed` nor `atomic` field.[^buildbarn][^engine]
5. **Write-open and open-with-create.** `openReference` accepts optional narrow `OpenReferenceSettings` containing only access, append, and truncate; omission preserves its existing read-only call. `openChildReference(directoryReference, nameBytes, OpenChildReferenceSettings)` retains the complete path-open create vocabulary, performs lookup-or-create-and-open in one gate hold, and returns the handle, exact reference, `created`, and directory transition. `exclusive` fails on an existing name; `ifMissing` opens it with `created: false`; an existing child leaves the directory revisions equal. Two separate calls would let a concurrent unlink fail the open after the client was told the create succeeded.
6. **Creation metadata and exact-object operations.** `mkdirReference`, `symlinkReference`, and `openChildReference` accept initial `times`, applied only when a new object is published; mode and times are ignored when `ifMissing` opens an existing file. `linkReference` has no option bag and links the exact source object, including a symbolic-link object, rather than following it. Direct-object chmod, chown, utimes, and truncate act on the exact reference and return `void`, matching their path twins. Core timestamps are bigint nanoseconds, so an adapter can store an eight-byte exclusive-create verifier losslessly in access and modification time.[^knfsd][^rfc8881]
7. **Share reservations and locks stay in the adapter.** Share-deny modes, byte-range locks, stateids, and owners remain `@effect-vfs/nfs` bookkeeping keyed on `ObjectReference`. RFC 8881 requires no coordination with local access; Linux nfsd, Buildbarn, and nfs4j keep this state above the backend.[^rfc8881][^dispatcher] The writable profile states that NFS state coordinates NFS clients only and that direct callers on the same volume are outside the boundary. A core advisory open registry that several adapters could consult is deferred to the share and lock issue (#47).
8. **Object lifetime is unchanged.** A writable handle contributes to the same open count as a read handle: an unlinked open file stays alive and charged until its final handle closes, and the reference then stales. Writable work adds coverage, not rules.

## Consequences

- Reference mutations extend the [object references](../../contracts/object-references.md "extends") and [mutation revisions](../../contracts/mutation-revisions.md "extends") contracts, which record the per-operation authority and revision rules once the operations land. They preserve [explicit caller privilege](explicit-caller-privilege.md "constrained by") and the [mutation and observation contract](../../contracts/mutation-and-observation.md "constrained by"): compositions of several reference calls remain compositions, not transactions.
- Watch events stay path addressed, so a reference mutation on an object no name reaches publishes nothing, as the contract already states.
- The NFS export wrapper grows the matching operations and the error map gains rows for `AlreadyExists`, `NotEmpty`, `SymlinkLoop`, `IsDirectory`, `NotDirectory`, and link-count failures before the writable profile (#48) depends on them.[^export] Revisions reduce to the 64-bit `changeid4` by truncation, never hashing, so inequality survives.
- Issue #125 adds an optional expected-child condition to `openChildReference` so adapter share checks and exclusive-create verifier comparisons cannot race direct callers. It compares the direct object, revision, and both timestamps under the same gate; timestamp comparison is required because access-time changes do not always advance revision. Initial size through `initialSize` and ownership through `owner` join mode and times in the creation candidate, with existing quota and ownership authority rules. Conditional unlink and rename remain deferred.

[^issue]: Issue #46 holds the original questions; the review session's decisions are recorded here.

[^core]: `Caller` exposes reference-based mutations, `openReference` with access settings, and atomic `openChildReference` with initial attributes and optional child conditions.

[^engine]: One gate coordinates mutations and observations: an observation takes one of its permits and a mutation takes them all, so both revisions of a directory change are read inside the mutation's hold; `Metadata` timestamps are bigint nanoseconds; unlinked open files survive through the volume value's inode-keyed open-count map.

[^export]: `NfsExport.openChild` reserves registry capacity and owns the scoped core handle. The dispatcher maps core failures to NFS statuses.

[^dispatcher]: `OpenState` holds `deny` per open-owner in a server-side map that core never sees.

[^rfc8881]: Sections 3.3.8 and 10.8.1 (`change_info4` atomicity), 18.16.3 and Table 18 (create modes), 18.25, 18.26, 18.30.4 (`SETATTR` non-atomicity), and 9.7 (share reservations among NFS opens).

[^buildbarn]: `Directory.VirtualOpenChild`, `VirtualMkdir`, `VirtualRename`, and `VirtualRemove` take a directory and a component and return `ChangeInfo{Before, After}`; the NFSv4 layer asserts `atomic = true`.

[^knfsd]: `nfsd_create_setattr` stores the exclusive-create verifier in `atime` and `mtime`; `set_change_info` computes atomicity from saved pre- and post-attributes.

[^ganesha]: `fsal_obj_ops` addresses `open2`, `mkdir`, `link`, `rename`, and `unlink` by parent handle and name and passes the object handle to `unlink` and `rename`.

[^nfs4j]: `VirtualFileSystem.create`, `mkdir`, `link`, `move`, and `remove` take `Inode parent` and `String name`; write returns `WriteResult` with the achieved stability.

[^fuse]: `fuse_lowlevel_ops` addresses `lookup`, `create`, `mkdir`, `unlink`, `rename`, and `link` by parent inode and name.

[^go-nfs]: The README records broken hard links and handles invalidated by rename as consequences of a path-based backend.
