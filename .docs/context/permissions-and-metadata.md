# Permission and metadata contract proposal

Status: researched proposal, 8 September 2026. No implementation or executed tests. This closes selected source gaps in POSIX-A01 through POSIX-A04 and POSIX-M02; it does not complete the namespace permission audit.

[ADR 0004](../decisions/0004-explicit-caller-privilege.md) accepts explicit privilege independent of user ID. The default caller is privileged; user ID zero alone grants nothing. The operation policies proposed below are not additional accepted decisions.

Official Issue 8 HTML was retrieved successfully through public `curl` requests. Relevant normative sections were read directly in XBD chapters 3 and 4 and the `chmod`, `chown`, `mkdir`, and `utimensat` pages. The exact source edition is IEEE Std 1003.1-2024. Earlier web-tool 403 responses do not block these findings.

## Access selection

Select exactly one class: matching user ID selects owner; otherwise matching primary or supplementary group selects group; otherwise select other. A denied owner check does not fall through to group or other. [XBD 3.142, 3.149, 3.150](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap03.html)

| Check                                 | Verified rule                                                                              | Project recommendation                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Ordinary access                       | Check the requested bits in the selected class.                                            | Support this mode-bit mechanism initially; do not add ACLs.                                        |
| Privileged read/write/search          | Appropriate privilege grants access.                                                       | Use ADR 0004's explicit setting.                                                                   |
| Privileged regular-file execute check | Some execute bit must grant execution.                                                     | If an access-query API exposes execute, retain this restriction. No executable loading is implied. |
| Sticky-directory removal/rename       | File owner, directory owner, or privilege qualifies. Allowing a writable file is optional. | Omit the writable-file exception. Sticky checks supplement ordinary namespace checks.              |

These are [XBD 4.7, File Access Permissions](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap04.html#tag_04_07) and [XBD 4.5, Directory Protection](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap04.html#tag_04_05). Privilege does not repair wrong file kinds, invalid handles, malformed input, or quota exhaustion.

Implementation consequence: pass one immutable caller identity into each operation. Do not consult the host user or infer privilege from ownership. Path traversal and final-file access are separate checks; owning the final file does not grant traversal through an inaccessible ancestor.

## Metadata-changing operations

| Operation                  | Required behavior                                                                                                                                                                                                                | Permitted choice and recommendation                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `chmod`                    | Owner or privilege required. Successful calls mark ctime. For an unprivileged caller changing a regular file whose group is outside its groups, clear set-group-ID. Defined read-only mode bits, such as file type, are ignored. | Keep only permission and supported special bits writable. Expose type separately.                    |
| `chmod` on a final symlink | `fchmodat` has an explicit no-follow mode.                                                                                                                                                                                       | Specify supported follow modes; never silently change the target for a requested own-link operation. |

Source: [chmod DESCRIPTION](https://pubs.opengroup.org/onlinepubs/9799919799/functions/chmod.html). It also permits additional documented restrictions on set-ID bits. Do not interpret ordinary write permission as permission to change modes.

| Operation                                | Required behavior                                                                                                                                                            | Permitted choice and recommendation                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Change ownership                         | Owner or privilege is required. Under `_POSIX_CHOWN_RESTRICTED`, only privilege changes user ID; an owner may change group to one of its own groups while retaining user ID. | Choose restricted ownership changes. Represent unchanged fields explicitly instead of exposing unsigned C sentinels. |
| Executable regular-file ownership change | Unprivileged calls clear set-user-ID and set-group-ID. Privileged clearing is implementation-defined.                                                                        | Clear both for privileged calls too. Keep other file cases explicit.                                                 |
| Ownership timestamps                     | Success marks ctime; omitting both fields may skip it.                                                                                                                       | Treat both omitted as a no-op after validation, including ownership-change authorization.                            |

Source: [chown DESCRIPTION](https://pubs.opengroup.org/onlinepubs/9799919799/functions/chown.html). The table proposes a restricted ownership policy, not a user/group database. The backend may store numeric identities without proving they exist on a host.

| Operation           | Required behavior                                                                                                              | Permitted choice and recommendation                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `mkdir` permissions | Apply umask to permission bits. Sticky-bit initialization is XSI-marked; other extra creation bits are implementation-defined. | Include sticky directories in this bounded profile. Ignore creation set-ID bits initially and document this choice. |
| `mkdir` ownership   | User is caller's user ID. Group may be parent's or caller's; a parent-group initialization route is required.                  | Always inherit parent group initially. This avoids a second group-inheritance switch.                               |
| `mkdir` identity    | Create an empty directory; an existing final symlink gives `EEXIST`.                                                           | Keep exclusive single-directory creation distinct from recursive helpers.                                           |
| `mkdir` timestamps  | Mark child atime/mtime/ctime and parent mtime/ctime.                                                                           | Apply within the same namespace commit.                                                                             |

Source: [mkdir DESCRIPTION](https://pubs.opengroup.org/onlinepubs/9799919799/functions/mkdir.html). Matching the regular-file creation policy to this recommendation still requires checking `open` creation clauses; this document does not establish that match.

## Explicit timestamp changes

| Request                                           | Required authorization or result                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Both timestamps set to now                        | File owner, file write permission, or privilege suffices.                                               |
| Explicit values or a mixed now/omit/value request | Owner or privilege is required, except the both-omit case.                                              |
| Both omitted                                      | Skip final-file ownership/permission checks; path-prefix errors may still occur. ctime need not change. |
| Successful non-omit update                        | Mark ctime; set requested atime/mtime to supported values rounded downward.                             |
| Own-link update                                   | `AT_SYMLINK_NOFOLLOW` changes symlink timestamps rather than target timestamps.                         |

Source: [utimensat DESCRIPTION](https://pubs.opengroup.org/onlinepubs/9799919799/functions/utimensat.html). Recommend explicit `now`, `omit`, and time-value choices in the API. Both omitted should preserve all timestamps after normal path/handle validation. A writable file does not authorize arbitrary historical timestamps.

## Timestamp storage and observation

POSIX distinguishes access, data modification, and status change times. Resolution is implementation-defined but no coarser than one second; unsupported precision rounds downward. Updates may be immediate or deferred, but marked updates must be applied before specified successful metadata observations. [XBD 4.12, File Times Update](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap04.html#tag_04_12)

Recommend immediate updates with a volume clock, sampled once per committed operation. Choose the stored precision with the public timestamp and snapshot representations. Do not require strictly increasing values: separate operations can share one clock tick, and the clock can move backwards. Tests should control the clock instead of sleeping.

The minimum initial matrix follows. “Mark” means the operation requires the field to participate in the timestamp update policy; it does not imply the numerical value must differ from its previous value.

| Successful operation | File atime       | File mtime       | File ctime                      | Parent mtime/ctime |
| -------------------- | ---------------- | ---------------- | ------------------------------- | ------------------ |
| `mkdir`              | Mark             | Mark             | Mark                            | Mark               |
| `chmod`              | No mark required | No mark required | Mark                            | No mark required   |
| `chown`              | No mark required | No mark required | Mark, both-omit exception above | No mark required   |
| Explicit time update | Requested choice | Requested choice | Mark, both-omit exception above | No mark required   |

Each row uses its operation source above. Read, write, truncate, link, unlink, and rename belong in the expanded matrix; write/truncate findings are already in the [I/O proposal](posix-io-contract.md). “No mark required” does not claim that every incidental pathname-access timestamp is forbidden.

## Focused proof cases

All cases are proposed, not executed.

1. Owner bits deny access while other bits permit it. The owner still fails.
2. A supplementary group grants access; changing another caller's groups has no effect.
3. Unprivileged user zero fails a mode check; a privileged nonzero caller receives the documented exception.
4. A writable file in someone else's sticky directory cannot be removed by a third-party caller under the proposed policy.
5. File write permission permits “both now” but not arbitrary timestamp values or chmod.
6. An owner changes to a supplementary group, but cannot assign an unrelated group or another user under the restricted policy.
7. Same-mode chmod marks ctime; both-omitted ownership/time updates preserve it under the chosen no-op policies.
8. New directory owner, inherited group, masked permission bits, sticky bit, and parent/child timestamps match one commit.
9. Own-link metadata calls affect a dangling link without requiring its target to exist.

## Remaining decisions

Accept or revise restricted chown, parent-group inheritance, sticky-directory exception policy, creation special-bit handling, and privileged set-ID clearing. Decide supported own-link operations and timestamp precision. Complete namespace permission/error rules separately, including unlink, rename, directory-relative search handles, and the identity used by an `access`-style query. The simplified caller model has one explicit identity; it must not silently claim the C API's real-versus-effective identity split.
