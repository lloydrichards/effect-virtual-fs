---
type: Reference
title: NFS attributes ledger
description: Maps RFC 8881 REQUIRED and RECOMMENDED file attributes to their owning profile, current values, intended behavior, and follow-up issue.
status: draft
tags: [nfs, ledger, attributes, rfc8881]
sources:
  - id: rfc8881-5
    resource: https://www.rfc-editor.org/rfc/rfc8881.html#section-5
    title: RFC 8881 Section 5 file attributes
  - id: dispatcher
    resource: ../../../packages/nfs/src/internal/nfs4.ts
    title: Attribute encoder and supported attribute list
  - id: export
    resource: ../../../packages/nfs/src/internal/export.ts
    title: Filehandle and fsid construction
  - id: tests
    resource: ../../../packages/nfs/test/Nfs4.test.ts
    title: Protocol behavior tests including every advertised attribute
  - id: core
    resource: ../../../packages/core/src/VirtualFileSystem.ts
    title: Core metadata and capacity model
generated: { by: codex/okf, at: 2026-09-19T09:08:16Z }
---

# NFS attributes ledger

Rows follow RFC 8881 Table 4 and Table 5.[^rfc8881-5] Status vocabulary comes from the [NFS profile ladder](../../decisions/nfs/nfs-profile-ladder.md "implements"). Section 5.1 requires every REQUIRED attribute to be stored and returned; Section 5.2 says a server should return RECOMMENDED attributes "whenever they don't have to tell lies", and Section 18.7.3 requires unsupported requested bits to be omitted silently rather than rejected. The encoder does exactly that, and VERIFY and NVERIFY compare the same canonical encodings.[^dispatcher]

## REQUIRED attributes (Table 4)

| Attribute          | #  | Required by     | Status    | Current value                                                                                                          | Intended behavior                                                                                  | Issue |
| ------------------ | -- | --------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----- |
| supported_attrs    | 0  | read-only-local | supported | Bitmap of attributes the export can report; capacity bits depend on its limits                                         | Same                                                                                               |       |
| type               | 1  | read-only-local | supported | NF4REG, NF4DIR, otherwise NF4LNK                                                                                       | Same while the volume has only files, directories, and symlinks; map explicitly if core adds kinds |       |
| fh_expire_type     | 2  | read-only-local | supported | `FH4_VOLATILE_ANY \| FH4_NOEXPIRE_WITH_OPEN`                                                                           | Same through `writable`; `FH4_PERSISTENT` becomes a `stateful` requirement                         | #50   |
| change             | 3  | read-only-local | supported | Core mutation revision                                                                                                 | Same; satisfies 10.3.1 because the revision changes on every update                                |       |
| size               | 4  | read-only-local | supported | Metadata size                                                                                                          | Same; writable form in `writable`                                                                  | #48   |
| link_support       | 5  | read-only-local | supported | `true`                                                                                                                 | Same                                                                                               |       |
| symlink_support    | 6  | read-only-local | supported | `true`                                                                                                                 | Same                                                                                               |       |
| named_attr         | 7  | read-only-local | supported | `false`                                                                                                                | Same; OPENATTR is excluded                                                                         |       |
| fsid               | 8  | read-only-local | supported | Two words derived from the volume's stable identity[^export]                                                           | Same; persistent handles remain a separate requirement                                             | #50   |
| unique_handles     | 9  | read-only-local | supported | `true`                                                                                                                 | Same                                                                                               |       |
| lease_time         | 10 | read-only-local | supported | `leaseDurationSeconds`, default 30                                                                                     | Same                                                                                               |       |
| rdattr_error       | 11 | read-only-local | supported | NFS4_OK in GETATTR; READDIR reports a failing entry with only `rdattr_error` when the client requested it, per 18.23.3 | Same                                                                                               |       |
| filehandle         | 19 | read-only-local | supported | 25-byte handle                                                                                                         | Same                                                                                               |       |
| suppattr_exclcreat | 75 | read-only-local | supported | Empty bitmap                                                                                                           | Same for read-only exports; populate in `writable`                                                 | #48   |

## RECOMMENDED attributes advertised (Table 5)

| Attribute                            | #          | Required by     | Status    | Current value                                                                                   | Intended behavior                                                                                                                                                                    | Issue |
| ------------------------------------ | ---------- | --------------- | --------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| case_insensitive                     | 16         | read-only-local | supported | `false`; names are byte-preserving                                                              | Same                                                                                                                                                                                 |       |
| case_preserving                      | 17         | read-only-local | supported | `true`                                                                                          | Same                                                                                                                                                                                 |       |
| fileid                               | 20         | read-only-local | supported | Inode number                                                                                    | Same                                                                                                                                                                                 |       |
| homogeneous                          | 26         | read-only-local | supported | `true`; one set of per-fs attributes applies to the volume                                      | Same                                                                                                                                                                                 |       |
| files_total, files_free, files_avail | 23, 22, 21 | read-only-local | supported | `maxEntries` and `maxEntries - entries`; omitted when `maxEntries` is absent                    | Same                                                                                                                                                                                 | #98   |
| maxfilesize                          | 27         | read-only-local | supported | Effective `volume.limits.maxFileBytes`, including the engine ceiling                            | Same                                                                                                                                                                                 | #98   |
| maxname                              | 29         | read-only-local | supported | `maxNameBytes`, default 255                                                                     | Same                                                                                                                                                                                 |       |
| maxread                              | 30         | read-only-local | supported | `maxReadBytes`, default 1 MiB                                                                   | Same                                                                                                                                                                                 |       |
| maxwrite                             | 31         | read-only-local | supported | `maxWriteBytes`, default 1 MiB                                                                  | Same; meaningful in `writable`                                                                                                                                                       |       |
| mode                                 | 33         | read-only-local | supported | Metadata mode                                                                                   | Same                                                                                                                                                                                 |       |
| no_trunc                             | 34         | read-only-local | supported | `true`; over-long components are rejected with NAMETOOLONG, never truncated                     | Same                                                                                                                                                                                 |       |
| numlinks                             | 35         | read-only-local | supported | Link count                                                                                      | Same                                                                                                                                                                                 |       |
| owner                                | 36         | read-only-local | supported | Decimal uid string without domain                                                               | Same in both read-only profiles; Section 5.9 permits numeric strings and Linux and macOS accept them under `sec=sys`. Translation of client-supplied strings arrives with `writable` | #77   |
| owner_group                          | 37         | read-only-local | supported | Decimal gid string                                                                              | Same as owner                                                                                                                                                                        | #77   |
| space_total, space_free, space_avail | 44, 43, 42 | read-only-local | supported | `maxBytes` and `maxBytes - usedBytes`; omitted when `maxBytes` is absent or exceeds NFS uint64  | Same                                                                                                                                                                                 | #98   |
| space_used                           | 45         | read-only-local | supported | Metadata size                                                                                   | Same                                                                                                                                                                                 |       |
| time_access                          | 47         | read-only-local | supported | Nanosecond timestamp; out-of-range seconds fail the operation with SERVERFAULT                  | Same                                                                                                                                                                                 |       |
| time_delta                           | 51         | read-only-local | supported | One nanosecond                                                                                  | Same                                                                                                                                                                                 |       |
| time_metadata                        | 52         | read-only-local | supported | ctime                                                                                           | Same                                                                                                                                                                                 |       |
| time_modify                          | 53         | read-only-local | supported | mtime                                                                                           | Same                                                                                                                                                                                 |       |
| mounted_on_fileid                    | 55         | read-only-local | supported | Equals fileid                                                                                   | Same; no nested mounts exist                                                                                                                                                         |       |
| fs_charset_cap                       | 76         | read-only-local | supported | `FSCHARSET_CAP4_ALLOWS_ONLY_UTF8`; names are validated as exact UTF-8 in both directions (14.4) | Same                                                                                                                                                                                 |       |

## RECOMMENDED attributes not advertised

| Attribute                                              | #                      | Required by | Status             | Rationale                                                                           | Issue |
| ------------------------------------------------------ | ---------------------- | ----------- | ------------------ | ----------------------------------------------------------------------------------- | ----- |
| maxlink                                                | 28                     | none        | excluded           | Core exposes no link limit; do not invent one                                       |       |
| time_create                                            | 50                     | none        | excluded           | Core metadata has no creation time; do not invent one                               |       |
| cansettime                                             | 15                     | writable    | deferred(writable) | Meaningful only with SETATTR                                                        | #48   |
| chown_restricted                                       | 18                     | writable    | deferred(writable) | Meaningful only with SETATTR                                                        | #48   |
| mode_set_masked, time_access_set, time_modify_set      | 74, 48, 54             | writable    | deferred(writable) | Write-only forms                                                                    | #48   |
| acl, aclsupport, dacl, sacl                            | 12, 13, 58, 59         | none        | excluded           | Core has no ACL model; `aclsupport` = 0 could be advertised if a client requires it |       |
| fs_locations, fs_locations_info, fs_status             | 24, 67, 61             | none        | excluded           | No migration or replication                                                         |       |
| fs_layout_type, layout_*, mdsthreshold                 | 62 to 66, 68           | none        | excluded           | No pNFS                                                                             |       |
| quota_avail_hard, quota_avail_soft, quota_used         | 38 to 40               | none        | excluded           | No per-user quotas                                                                  |       |
| retention__, retentevt__                               | 69 to 73               | none        | excluded           | No retention model                                                                  |       |
| archive, hidden, system, mimetype, rawdev, time_backup | 14, 25, 46, 32, 41, 49 | none        | excluded           | No corresponding core metadata; rawdev needs device files, which are deferred       |       |
| change_policy, dir_notif_delay, dirent_notif_delay     | 60, 56, 57             | none        | excluded           | Directory delegations are excluded                                                  |       |

Every advertised attribute is exercised by the protocol tests.[^tests] The [operations ledger](nfs-operations-ledger.md "depends on") records GETATTR, READDIR, VERIFY, and NVERIFY, which consume these rows.

[^rfc8881-5]: Table 4 lists the fourteen REQUIRED attributes; Table 5 lists the RECOMMENDED ones; Sections 5.1, 5.2, 5.9, and 18.7.3 give the rules quoted above.

[^dispatcher]: `supportedAttributesFor`, `encodeAttributeValues`, and `encodeAttributes` define the advertised list and values for each export.

[^export]: The fsid derives from volume identity; filehandles include the volume incarnation.

[^tests]: Protocol tests check the base advertised set and bounded versus unbounded capacity attributes, including GETATTR, VERIFY, and NVERIFY.
