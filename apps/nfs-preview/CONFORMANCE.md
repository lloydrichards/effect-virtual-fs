# External suite baseline: pynfs NFSv4.1

This file records the pinned pynfs run that the `experimental` maturity of the `read-only-local` profile requires, and
classifies every failure. It is evidence, not authority: RFC 8881 and its verified errata decide what is correct. The
machine-readable classification is [`conformance/known-failures.json`](conformance/known-failures.json); this page
explains it.

## Pinned run

| Item      | Value                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------- |
| Suite     | [pynfs](https://github.com/kofemann/pynfs), `nfs4.1/testserver.py`                                   |
| Commit    | `cd4701827a8261fedbfb4c6e39029fb9671321a6` (2026-03-27)                                              |
| Python    | 3.14 in a virtual environment with `ply` 3.11, `setuptools` 84.0.0, and `xdrlib3` 0.1.1              |
| Server    | `bun run --filter @repo/nfs-preview conformance` (this app, built `@effect-vfs/nfs`)                 |
| Selection | `all noreboot nocourteous` (179 of 266 tests; reboot and courtesy-lease groups wait on lease expiry) |
| Result    | 100 passed, 79 failed, 0 skipped (2026-09-24, macOS 26 arm64)                                        |

## Running it

The `nfs-pynfs` workflow runs this on every pull request that changes `packages/core`, `packages/nfs`, or this app. To
run it locally, build the NFS package and start the gate:

```sh
bunx turbo run build --filter=@effect-vfs/nfs
bun run --filter @repo/nfs-preview pynfs-gate
```

The gate reads the suite commit, Python pins, and command line from `conformance/known-failures.json`, checks out
pynfs, starts the fixture on `127.0.0.1:2049`, and runs:

```sh
python3 testserver.py 127.0.0.1:2049/ --minorversion 1 --security sys --noinit --nocleanup --force --jsonout results.json all noreboot nocourteous
```

Set `PYNFS_DIR` to reuse an existing checkout. `--minorversion 1` matters: pynfs defaults to minor version 2.
`--noinit --nocleanup` skip the write-based tree setup, which a read-only export must refuse. The fixture already
contains the `tree/dir`, `tree/file`, `tree/link`, and `tmp` objects that read-side tests expect.

The comparison is strict in both directions. The gate fails on a failure the file does not list, on a listed test
that now passes, and on a change in the number of selected tests. A new failure is a defect until it is classified.

## Failure classification

Every failure falls into one of four classes. None is an unclassified defect.

| Class                                                     | Count | Tests                                                                                                                | Reason                                                                                                                                                                 |
| --------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deliberate exclusion: read-only export                    | 62    | Setup that opens with create (`CSID`, `DELEG`, `OPEN`, `SEQ`, `SEC`, `RECC`, `DSESS`) or creates with CREATE (`RNM`) | Mutating operations return `NFS4ERR_ROFS` by design. Structural errors such as `NOFILEHANDLE`, `NOTDIR`, and `INVAL` take precedence and are covered by passing tests. |
| Deliberate exclusion: object kinds the core does not have | 12    | LOOKUP, LOOKUPP, PUTFH, and RENAME setup on `socket`, `fifo`, `block`, `char`                                        | The fixture cannot contain special files; they are listed under deferred capabilities. LOOKUPP on `file` and `link` passes with `NOTDIR` and `NFS4ERR_SYMLINK`.        |
| Suite assertion no NFSv4.1 read-only server satisfies     | 2     | DELEG24, DELEG25                                                                                                     | Both request the NFSv4.2 `fattr4_open_arguments` attribute.                                                                                                            |
| Disputed: suite assertion contradicts RFC 8881            | 3     | CSESS16, CSESS16a, CSESS29                                                                                           | See below. Each entry cites the rule it conflicts with.                                                                                                                |
| Not selected                                              | 87    | `reboot` and `courteous` flags                                                                                       | Depend on lease expiry and server restart; they belong to the `stateful` profile evidence.                                                                             |

A disputed test is one another server may pass, but only by breaking a rule this server follows. It stays listed until
the suite changes or an erratum changes the rule:

- **CSESS16 and CSESS16a** offer an RPCSEC_GSS callback handle the server never issued, and expect `NFS4_OK`. Sections
  18.33.3 and 18.36.3 require `NFS4ERR_NOENT` when the handle named by `gcbp_handle_from_server` does not exist.
- **CSESS29** sends 10,000 CREATE_SESSION requests that fail with `NFS4ERR_TOOSMALL`, then reuses the same
  `csa_sequenceid` and expects `NFS4_OK`. Section 18.36.4 phase 2 sets the slot to the expected `csa_sequenceid`
  before session creation, so the failure is cached and the reuse is a replay that returns it.

## Native client run

The read-only profile also needs a real kernel client. `bun run --filter @repo/nfs-preview verify-mount` runs the
read-side checks against a mounted preview and prints the client platform. Record each run here.

| Date       | Client                                                                                                                                                                                                | Server                                                           | Result                                                                                                                                                                                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-13 | macOS 26.6 `mount_nfs`, `vers=4.1,sec=sys`                                                                                                                                                            | preview before the read-only completion                          | manual checks passed (recorded in #39)                                                                                                                                                                                                                                                                                         |
| 2026-09-15 | macOS 26.6.2 `mount_nfs`, `vers=4.1,sec=sys,noowners,ro`                                                                                                                                              | preview with the read-only completion                            | `verify-mount` as it stood in that revision (15 checks): 15 passed, 0 failed, after fixing the OPEN delegation-want rejection found on the first attempt. The mount carried `ro`, so the three rejected-write checks exercised the client, not the server; the current script has 16 checks and fails a client-side `ro` mount |
| 2026-09-16 | macOS 26.6.2 `mount_nfs`, `vers=4.1,sec=sys,noowners` (writable on the client)                                                                                                                        | preview with the read-only completion and the Section 15.2 audit | `verify-mount` (16 checks): 16 passed, 0 failed. The mount was writable on the client, so `touch`, `mkdir`, and append were refused by the server's `NFS4ERR_ROFS`, and the file was unchanged afterwards                                                                                                                      |
| 2026-09-16 | Linux kernel `6.17.0-1022-azure`, Ubuntu 24.04.5 LTS, `nfs-utils` 2.6.4 (`ubuntu-24.04` runner image 20260907.300.1), `nfsvers=4.1,tcp,sec=sys,port=2049,actimeo=1` via `scripts/linux-mount-gate.sh` | preview with the read-only completion and the Section 15.2 audit | `verify-mount` (16 checks): 16 passed, 0 failed, repeatable in the `nfs-linux-mount` workflow. A second mount with no `vers=` option laddered from 4.2 to 4.1 (`/proc/mounts` reported `vers=4.1`), the first direct confirmation of the minor-version laddering                                                               |

## What the run found

The baseline run exposed defects that the focused test suite had not, all fixed and covered by tests before this
baseline was recorded: EXCHANGE_ID client-record replacement cases from RFC 8881 Section 18.35.4, CREATE_SESSION
principal and channel-size checks, replay of CREATE_SESSION through a SEQUENCE compound, the open_owner clientid that
NFSv4.1 servers must ignore, `NOT_ONLY_OP` for bootstrap operations, the one-element `eia_client_impl_id` bound, and
`REQ_TOO_BIG` precedence over decode errors.

The first native-client run after the completion found one more defect that neither the focused tests nor pynfs
exercised: the macOS 26 client opens with `OPEN4_SHARE_ACCESS_WANT_READ_DELEG` set in `share_access`, and the
server rejected the unknown bit with `NFS4ERR_INVAL`, so every file read failed with "Invalid argument". Delegation
wants are now answered with `OPEN_DELEGATE_NONE_EXT` and a reason, as Section 18.16.3 requires, with a focused test
for the exact request.

Neither suite checks every error code against the Section 15.2 tables, so a line-by-line audit followed the runs and
corrected codes no client had triggered: OPEN answered deny modes with `OPENMODE` and unsupported claims with
`NOTSUPP` (now share reservations with `SHARE_DENIED`, and `NO_GRACE` or `BAD_STATEID`), COMMIT on a symlink said
`INVAL`, CREATE, REMOVE, RENAME, and SECINFO_NO_NAME said `SYMLINK`, the current stateid did not travel with SAVEFH
and RESTOREFH or reset on PUTFH and LOOKUP, a malformed operation failed the whole compound instead of answering
`BADXDR` in place, `fs_charset_cap` advertised the opposite of the export's UTF-8 rule, SP4_MACH_CRED was silently
downgraded, and a failed CREATE_SESSION did not consume its slot. Each has a focused test.

The read-only export now records bounded advisory read locks, so LOCK with a read lock type succeeds and conflicts
between clients are enforced. Write locks still return `NFS4ERR_ROFS`.

The first repeatable run on 2026-09-24 differed from the 2026-09-15 baseline, which had not been rerun after later
session, backchannel, and Section 15.2 audit changes. COMP5 now passes. CSESS16, CSESS16a, and CSESS29 now fail. All
three are RFC-required answers, so they are classified as disputed rather than reverted. SEQ9b moved to the
read-only class, since its AttributeError follows a refused file creation.
