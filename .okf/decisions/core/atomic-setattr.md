---
type: Decision
title: Atomic setattr
description: Adds a Caller setattr that changes size, owner, mode and times as one change with a fixed check order and an expected-revision precondition, makes NFS SETATTR all or nothing with knfsd set-ID sanitising and unchanged-owner handling that retries when the owner moves underneath it, and declines an unscoped open in favour of per-open scopes forked from the NFS handler scope.
status: stable
tags: [metadata, permissions, nfs, atomicity]
sources:
  - id: caller
    resource: ../../../packages/core/src/Caller.ts
    title: SetattrOptions schema
  - id: engine
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: changeAttributes, the one body behind setattr, chmod, chown, utimes and truncate
  - id: families
    resource: ../../../packages/core/test/OperationFamilies.test.ts
    title: setattr check-order rows for both families
  - id: tests
    resource: ../../../packages/core/test/Setattr.test.ts
    title: Field naming, atomicity, one revision, one event and the set-ID case
  - id: nfs
    resource: ../../../packages/nfs/src/internal/nfs4.ts
    title: SETATTR over one setattr call, sanitised as knfsd nfsd_sanitize_attrs
  - id: nfs-tests
    resource: ../../../packages/nfs/test/NfsSetattr.test.ts
    title: All-or-nothing attrsset, set-ID clearing with an owner change, unchanged owners, and the chown race
  - id: knfsd
    resource: https://github.com/torvalds/linux/blob/master/fs/nfsd/vfs.c
    title: Linux knfsd nfsd_sanitize_attrs, which revokes set-ID bits on chown
  - id: attr
    resource: https://github.com/torvalds/linux/blob/master/fs/attr.c
    title: Linux chown_ok and chgrp_ok, which let an owner re-send the uid and gid a node already has
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/209
    title: Atomic setattr and an unscoped open variant for NFS
generated: { by: claude-code, at: "2026-09-26T13:20:00+02:00" }
---

# Atomic setattr

Follows the [public API decision](public-api-targets-services-and-errors.md "follows"), which deferred a combined attribute change, and its `NotPermitted` amendment, whose two denial codes the check order interleaves. Amends decision 2 of the [reference-based mutations decision](reference-mutations.md "amends"), which had NFS apply SETATTR attributes in sequence. The decisions were grilled on 2026-09-25 and recorded on [issue #209](https://github.com/lloydrichards/effect-virtual-fs/issues/209 "decided on"); the adversarial review of 2026-09-26 moved set-ID sanitising into NFS (decision 8), and the owner then chose knfsd's treatment of an unchanged owner or group for NFS only (decision 9). The follow-up review round of 2026-09-26 added the expected-revision precondition that closes the race between NFS's observation and its change (decision 10), the first slice of [issue #31](https://github.com/lloydrichards/effect-virtual-fs/issues/31 "starts").

## Context

NFS SETATTR made one core call per attribute, so a request took one revision and one watch event per attribute and a failure left the earlier attributes applied, which a test pinned. Reading the code showed that chown ran after chmod and cleared setuid and setgid, so a SETATTR of mode `04755` with a new owner ended at `0755`. That was first treated as a bug, but Linux knfsd reaches `0755` too, on purpose, so the outcome belongs to the protocol layer rather than to core's order. The issue also proposed an unscoped `open` so NFS could hold a handle without juggling a manual scope.

## Decisions

1. **Scope: `setattr` only.** The unscoped open is declined. A handle already forks its own scope from the opener's, and a forked child unregisters from its parent when it closes, so NFS forks each open's scope from its handler scope and closes that child on CLOSE, instead of `Scope.make` plus a manual `Scope.close`. Closing the handler scope now closes the children; the handler's shutdown sweep through each open's own close stays, because that close is all the export interface promises and a custom export need not fork. NFS opens no directory handles, so the directory case is moot. No core API is added for this.
2. **`caller.setattr(target, { size?, mode?, owner?, times?, expected? })`** takes any target and returns `void`, as `chmod`, `chown`, `utimes` and `truncate` do. It runs as one change: one draft, one revision, one clock reading for every time it sets, and one `Update` event per name of the target. The body publishes once after all attributes apply, which guards against the duplicate event each attribute would otherwise push.
3. **Check order, first failure wins.**
   1. Every attribute validates before the target resolves, in the order size, mode, owner, times, expected, and an unknown key first of all; `InvalidArgument` names the attribute in `field`. Attributes that are not an object fail `InvalidArgument` without a `field`, and the published `SetattrOptions` schema bounds the size as the verb does.
   2. The target resolves, with the usual lookup failures (`NotFound`, `NotDirectory`, search `AccessDenied`, `StaleReference`).
   3. An `expected: { revision }` that differs from the target's current revision fails `StaleReference` with `field: "expected"` (decision 10).
   4. A size on a symbolic link fails `SymlinkLoop` and on a directory `IsDirectory`, as truncate(2) reports `EISDIR` before any permission check.
   5. Ownership (`NotPermitted`) for mode, owner and explicit or mixed times.
   6. Write permission (`AccessDenied`) for size and for both times set to now by a non-owner.
   7. At apply, `FileTooLarge` and `NoSpace` for the size.

   Every check runs against the node as it was before the call.
4. **Apply order: size, owner, mode, times.** This is the POSIX composition of chown then chmod: a requested mode wins over the set-ID clearing that a resize or an owner change triggers, and the setgid rule for a caller outside the group uses the new group. Explicit times win over the resize's `now`. Core applies no protocol's sanitising; an adapter that needs one adjusts the attributes before it calls `setattr` (decision 8).
5. **An empty setattr changes nothing.** Linux `notify_change` returns at once when no attribute is valid, so `setattr(target, {})` resolves the target and then checks nothing, advances no revision, leaves ctime alone and publishes nothing. An owner update with neither id still checks ownership, as `chown` with `-1, -1` did here, and times that omit both are no change.
6. **The single-attribute verbs are one-field calls of the same body** and keep their codes, with one change: `truncate` rejects a negative length before resolving the target, as truncate(2) does.
7. **NFS SETATTR is one `setattr` call.** Owner and group join one owner update and the two times one times update. `attrsset` is all or nothing, complete on success and empty on failure, which RFC 8881 Section 18.30.4 allows. Status still comes from the generic failure table.

8. **NFS SETATTR sanitises set-ID bits as Linux knfsd does.** `nfsd_sanitize_attrs` in `fs/nfsd/vfs.c` revokes set-ID bits on chown: when one SETATTR changes the owner or group of a non-directory and also sets its mode, it clears setuid from the requested mode, and setgid when the mode grants group execute (setgid without group execute marks mandatory locking, not privilege). NFS applies that rule before its one `setattr` call, so mode `04755` with a new owner ends at `0755` and `06745` at `02745`, and a directory keeps its bits. An owner change without a mode needs nothing, since core's chown already clears both bits on a regular file. This replaces the review-round reading that kept `04755`.
9. **NFS SETATTR treats an owner or group the object already has as no change; core keeps POSIX chown.** Linux `chown_ok` and `chgrp_ok` in `fs/attr.c` let the owner re-send its own uid, and its current gid without membership, and `nfsd_sanitize_attrs` revokes set-ID bits only when `uid_eq` or `gid_eq` against the inode fails. Core's chown stays POSIX and refuses a gid outside the caller's groups even when it is the current one. So before its `setattr` call NFS drops an owner or owner_group equal to the current uid or gid, keeps the owner update itself (possibly empty, so core still checks ownership and a non-owner still gets `PERM`), applies decision 8 only to an id that actually changes, and still reports the dropped attribute in `attrsset` on success. An owner re-sending an unchanged group it is not a member of answers `OK`, and `04755` sent with the current owner stays `04755`.
10. **`setattr` takes an `expected: { revision }` precondition, and NFS SETATTR passes the revision it observed.** Decision 9 decides from a separate `stat`, so a chown by another client between that read and the change made NFS drop a requested uid as unchanged and skip the set-ID clearing: `04755` with owner `1000` could end at uid `2000` with setuid, a state no serial order produces. Core checks the expected revision inside the change, right after the target resolves, and fails `StaleReference` naming `expected` on a mismatch, the code `open`'s `expectedChild` already uses for a moved revision; nothing applies. NFS sends the revision whenever it observed the metadata (only when the request carries an owner or group), re-observes and retries up to three times on that failure, then answers `NFS4ERR_DELAY` so the client retries later. Core stays POSIX and the sanitising stays in NFS (decisions 8 and 9).

The memory adapter is unchanged: Effect `FileSystem` has no combined attribute operation to map.

## Consequences

Each check-order step is a row in `OperationFamilies.test.ts` for both families. The [permissions and metadata contract](../../contracts/permissions-and-metadata.md "constrains") states the order, and the [mutation revisions contract](../../contracts/mutation-revisions.md "constrains") counts one advance per setattr. The NFS [operations ledger](../../research/nfs/nfs-operations-ledger.md "constrains") records the SETATTR rule.
