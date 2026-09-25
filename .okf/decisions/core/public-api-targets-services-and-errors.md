---
type: Decision
title: Public API on targets, services, and one error family
description: Addresses every caller verb by a Target or an Entry, provides Volume and Caller as Effect services with layers, replaces the five error classes with one VfsError, and drops Crypto from construction.
status: stable
tags: [api, effect, errors, targets, services]
sources:
  - id: api
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Caller, Volume and Caller services, and the barrel
  - id: target
    resource: ../../../packages/core/src/Target.ts
    title: Target, Entry, and Name
  - id: errors
    resource: ../../../packages/core/src/VfsError.ts
    title: VfsError and its code union
  - id: engine
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: One resolution step per addressing mode
  - id: table
    resource: ../../../packages/core/test/OperationFamilies.test.ts
    title: Side-by-side codes per addressing mode
generated: { by: claude-code, at: "2026-09-26T13:00:00+02:00" }
---

# Public API on targets, services, and one error family

Step 8 of the [persistent tree rebuild](persistent-tree-rebuild.md "extends"). The decisions were grilled against the code on 2026-09-25 and recorded on [issue #186](https://github.com/lloydrichards/effect-virtual-fs/issues/186 "decided on"); this file records what they fix.

## Context

`Caller` carried 47 members for about 20 verbs: a path family, a `*Reference` family, three `*Handle` verbs, and three `*Bytes` twins. NFS used only the reference half and memory only the path half. Five unrelated `Data.TaggedError` classes reported failures, option validation split between `FsError` and `ConfigurationError`, every constructor required `Crypto.Crypto` for one identity mint, and 29 `typeof` re-exports leaked the engine module into the public declarations. The [operation families merge](https://github.com/lloydrichards/effect-virtual-fs/issues/179 "informed by") had given each verb one body but kept 35 rows of the side-by-side table returning different codes per family.

## Decisions

1. **Release.** One breaking 0.6.0 for the fixed Changesets group, with no deprecation minor and no 1.0 label, following the 0.4.0 precedent. The rebuild decision's "deprecation minor in front" is withdrawn.
2. **Targets and entries.** A `Target` is a `Data.TaggedEnum` of `Path` (with its base handle and symbolic-link policy), `Reference`, or `Handle`; an `Entry` is a directory target and a `Name`. Every verb takes one or the other, and a bare path, reference, or handle is accepted where a target is. `Target.Path` owns `relativeTo` and `followFinalSymlink`; `lstat` and the per-verb option keys go. Handles keep `stat`, `close`, `sync`, and `truncate` as effect properties.
3. **Verbs.** About 22 POSIX-named members: `root`, `lookup`, `parent`, `stat`, `readDirectory`, `readLink`, `realPath`, `access`, `readFile`, `writeFile`, `open`, `mkdir`, `symlink`, `link`, `unlink`, `rmdir`, `remove`, `rename`, `chmod`, `chown`, `utimes`, `truncate`, `withDirectory`, `openDirectory`. Listings, link targets, and real paths return bytes; `stat` returns `Metadata` with the object's `revision`; `readDirectory` returns entries with references and the directory's revision; `pread` returns `{ bytes, eof }`; `access` returns the granted bits. Mutations return `ReferenceEntryResult`, `DirectoryChange`, or `RenameReferenceResult` regardless of addressing, and `open` on an entry performs lookup-or-create-and-open in one gate hold with `expected` and `expectedChild` guards.
4. **One check order.** Both addressing modes resolve the directory before the name, check search permission on it before any name in it is looked up, and check a reserved or existing name, trailing slashes and rename's same-object and subtree rules before write permission, as Linux does. A directory the caller cannot search so reveals none of its names. A reserved name renders by addressing mode: the POSIX per-verb code on a path, `InvalidArgument` on an entry. A gone object renders `NotFound` on a path, `StaleReference` on a reference, `InvalidHandle` on a handle. No new `FsCode`.
5. **Trailing slashes follow Linux.** Linking or symlinking onto a missing slashed name is `NotFound`, creating through a slashed name is `IsDirectory`, and a directory may move to a missing slashed name; each was verified in a Linux container before its row changed.
6. **Errors.** One `VfsError`, a `Schema.TaggedError` whose `code` is the union of the filesystem, image, delta, and store codes, with `operation`, an optional `field` for a rejected option, an optional `path` carried as bytes and encoded as base64, and a `cause` carried as a `Schema.Defect`. `FsFailure`, `ImageFailure`, `StoreFailure`, and `ArgumentFailure` narrow the code per signature. Every rejected option is `InvalidArgument` with a `field`. An unencodable string input names its replacement encoding; an untyped input names no path.
7. **Identity without Crypto.** Constructors draw identity and incarnation from Effect's `Random`, or from a `Crypto` service when one is in context, and no longer fail with `PlatformError`. `Crypto` stays on the delta functions that hash.
8. **Services and layers.** `Volume` and `Caller` are Effect service keys carrying `Volume.layer`, `layerFromSnapshot`, `layerFromFixture`, `layerOverlay`, `layerLive`, and `Caller.layer`. A caller supplied through the service keeps its own volume, credentials, umask, and working directory. `CurrentFileSystem` goes.
9. **Modules.** Per-concept subpaths own the schemas the engine imports: `Volume`, `Caller`, `Target`, `FileHandle`, `Metadata`, `VfsError`, `Snapshot`, `SnapshotDelta`, `BytePath`, `LiveVolume`, `Fixture`, `Watch`; `VirtualFileSystem` remains the barrel, and its declarations import nothing from `internal/`. `BytePath` gains a toolkit.
10. **Declined for 0.6.0.** Recursive tree operations, path-scoped watch, file-type bits in `Metadata`, an atomic `setattr`, an unscoped open, and a serialisable reference key each have their own issue. The `EPERM` versus `EACCES` split was declined here too, then brought into 0.6.0 by the amendment below. File-type bits then joined 0.6.0 as `Metadata.typedMode`, with `mode` kept as permission bits, by the [permission mode and typed mode decision](permission-mode-and-typed-mode.md "amended by"). The [atomic setattr decision](atomic-setattr.md "amended by") later added `setattr` and declined the unscoped open. Recursive tree operations joined 0.6.0 as `walk`, `mkdir { recursive }` and `remove { recursive, force }` by the [recursive tree operations decision](recursive-tree-operations.md "amended by").

## Consequences

- The [operation families table](../../../packages/core/test/OperationFamilies.test.ts "pinned by") keeps every row; the rows whose codes changed cite the decision above them. The provisional codes in [paths and namespace](../../contracts/paths-and-namespace.md "resolves") are resolved.
- This decision extends the [explicit API and Effect services decision](explicit-api-and-effect-services.md "extends"): the explicit constructors remain the capability API the layers wrap. It refines [Schema data and capability interfaces](schema-data-and-capability-interfaces.md "refines") to a serialisable error family, and supersedes the `*Reference` vocabulary of [reference mutations](reference-mutations.md "supersedes syntax in") while preserving its authority, results, and atomic child open.
- Memory's and NFS's code tables are total over the code union. Memory addresses core through path targets with base handles; NFS wraps the entry verbs behind its export and answers `ACCESS` from one granted bitmask.
- Two implementation refinements of the recorded decisions: `stat` returns a flat `Metadata` carrying `revision` rather than a nested observation, and the services are function-style keys with the layers attached rather than classes, so `Vfs.Volume` and `Vfs.Caller` keep naming the value types consumers write.

## Amendment: NotPermitted beside AccessDenied (#207)

Decided on [issue #207](https://github.com/lloydrichards/effect-virtual-fs/issues/207 "decided on") on 2026-09-25 and shipped inside the same 0.6.0, so that exhaustive matches over the code union break once rather than twice.

- **A new code, not a reason field.** `FsCode` gains `NotPermitted`, the EPERM case: the change needs ownership or privilege, whatever the mode bits say. `AccessDenied` stays EACCES: the mode bits deny the access. A `reason` field on `AccessDenied` was rejected because every adapter would have to read a second field on one code.
- **Where each applies.** `NotPermitted` is what a non-owner chmod gets (writeFile's `finalMode` included), and likewise chown, explicit or mixed utimes by a non-owner, removal or replacement of another owner's entry in a sticky directory, and an unprivileged create that names an owner. Every mode-bit check, directory search included, and the both-now utimes that a writer may perform stay `AccessDenied`. Clearing set-ID bits stays silent.
- **Paths.** chmod and chown failures name the requested path, as decision 6 requires; before this they named none.
- **Adapters.** NFS maps `NotPermitted` to `PERM` only for CREATE, OPEN, and SETATTR, whose RFC 8881 Section 15.2 lists include it, and to `ACCESS` elsewhere, so a sticky-directory REMOVE or RENAME stays `ACCESS` ([error mapping](../nfs/error-mapping.md "amends")). Memory maps it to `PermissionDenied` with the description `NotPermitted (EPERM)`, since Effect's system error tags have no EPERM.
- **Tests.** The operation families table and the core ownership and privilege assertions name `NotPermitted`; no assertion was weakened.
