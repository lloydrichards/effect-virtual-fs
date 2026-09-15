# External suite baseline: pynfs NFSv4.1

This file records the pinned pynfs run that the `experimental` maturity of the `read-only-local` profile requires, and
classifies every failure. It is evidence, not authority: RFC 8881 and its verified errata decide what is correct.

## Pinned run

| Item      | Value                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------- |
| Suite     | [pynfs](https://github.com/kofemann/pynfs), `nfs4.1/testserver.py`                                   |
| Commit    | `cd4701827a8261fedbfb4c6e39029fb9671321a6` (2026-03-27)                                              |
| Python    | 3.14 in a virtual environment with `ply`, `setuptools`, and `xdrlib3`                                |
| Server    | `bun run --filter @repo/nfs-preview conformance` (this app, built `@effect-vfs/nfs`)                 |
| Selection | `all noreboot nocourteous` (179 of 266 tests; reboot and courtesy-lease groups wait on lease expiry) |
| Result    | 102 passed, 77 failed, 0 skipped                                                                     |

## Running it

```sh
git clone https://github.com/kofemann/pynfs.git && cd pynfs && git checkout cd4701827a8261fedbfb4c6e39029fb9671321a6
python3 -m venv .venv && . .venv/bin/activate && pip install ply setuptools xdrlib3
python3 setup.py build
```

In this repository, build the NFS package and start the fixture, which binds `127.0.0.1:2049`:

```sh
bunx turbo run build --filter=@effect-vfs/nfs
bun run --filter @repo/nfs-preview conformance
```

Then, from the pynfs checkout:

```sh
cd nfs4.1
python3 testserver.py 127.0.0.1:2049/ --minorversion 1 --security sys --noinit --nocleanup --force --jsonout results.json all noreboot nocourteous
```

`--minorversion 1` matters: pynfs defaults to minor version 2. `--noinit --nocleanup` skip the write-based tree setup,
which a read-only export must refuse. The fixture already contains the `tree/dir`, `tree/file`, `tree/link`, and
`tmp` objects that read-side tests expect.

## Failure classification

Every failure falls into one of three classes. None is an unclassified defect.

| Class                                                     | Count | Tests                                                                                                                                    | Reason                                                                                                                                                                 |
| --------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deliberate exclusion: read-only export                    | 61    | OPEN with create (32), CREATE (27), RENAME and file-creating setup (2)                                                                   | Mutating operations return `NFS4ERR_ROFS` by design. Structural errors such as `NOFILEHANDLE`, `NOTDIR`, and `INVAL` take precedence and are covered by passing tests. |
| Deliberate exclusion: object kinds the core does not have | 12    | LOOKUP, LOOKUPP, PUTFH, and RENAME setup on `socket`, `fifo`, `block`, `char`                                                            | The fixture cannot contain special files; they are listed under deferred capabilities. LOOKUPP on `file` and `link` passes with `NOTDIR` and `NFS4ERR_SYMLINK`.        |
| Suite assertion no NFSv4.1 read-only server satisfies     | 4     | DELEG24, DELEG25 (request the NFSv4.2 `fattr4_open_arguments` attribute), COMP5 (pynfs cannot encode opcode 0), SEQ9b (replays a RENAME) | Suite-side limitations or write dependencies.                                                                                                                          |
| Not selected                                              | 87    | `reboot` and `courteous` flags                                                                                                           | Depend on lease expiry and server restart; they belong to the `stateful` profile evidence.                                                                             |

## Native client run

The read-only profile also needs a real kernel client. `bun run --filter @repo/nfs-preview verify-mount` runs the
read-side checks against a mounted preview and prints the client platform. Record each run here.

| Date       | Client                                                                     | Server                                  | Result                                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-13 | macOS 26.6 `mount_nfs`, `vers=4.1,sec=sys`                                 | preview before the read-only completion | manual checks passed (recorded in #39)                                                                                                                                                                           |
| 2026-09-15 | macOS 26.6.2 `mount_nfs`, `vers=4.1,sec=sys,noowners,ro`                   | preview with the read-only completion   | `verify-mount`: 15 passed, 0 failed, after fixing the OPEN delegation-want rejection found on the first attempt. The mount carried `ro`, so the three rejected-write checks exercised the client, not the server |
| pending    | macOS 26 `mount_nfs`, `vers=4.1,sec=sys,noowners` (writable on the client) | preview with the read-only completion   | to be recorded; confirms the server's `NFS4ERR_ROFS` reaches a native client                                                                                                                                     |

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

One answer is a scope decision rather than an RFC requirement: LOCK with a read lock type returns `NFS4ERR_ROFS`.
A read lock does not modify the file system, but this server records no lock state, and LOCK's error list offers no
code that says so without inventing a conflict. Applications that take shared locks on the mount (SQLite readers,
some editors) see `EROFS` until the `stateful` profile adds lock state.

Rerun this suite after any change to `packages/nfs/src/internal/nfs4.ts`. A new failure that does not fit one of
the classes above is a defect until proven otherwise.
