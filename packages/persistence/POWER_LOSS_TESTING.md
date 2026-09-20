# Test the SQLite live store across a physical power cut

This guide helps a contributor collect evidence for [issue #144](https://github.com/lloydrichards/effect-virtual-fs/issues/144). It tests `SqliteLiveImageStore` directly. You do not need NFS or a writable NFS export.

The test writes a database on a dedicated disposable Linux filesystem, pauses a writer at a named point, and waits for an external controller to cut power. After reboot, the verifier checks the recovered file, SQLite integrity, and the stored image digest. The script never cuts power. A VM stop, process kill, or graceful shutdown is not a physical power-cut result.

## Prepare the machine and controller

Use a machine and storage device that you can lose. The power cut affects the whole machine, not only the test directory. Do not run this on a machine or disk that contains data you need. Mount the disposable filesystem somewhere other than `/`; the script refuses the root filesystem.

Keep a second machine or controller powered throughout the test. It must record the `READY` line outside the machine under test, then cut power without asking the operating system to shut down. Do not use `sync`, `shutdown`, or a clean VM stop after `READY`. Reboot with the same disk and mount it at the same path before verification.

Clone a tagged revision of this repository on the machine under test. Record the tag and commit in the report. Install Bun 1.2.21, then build from that revision:

```sh
bun install --frozen-lockfile
bun run build
```

Run the existing process-death and injected-fault gates before physical testing. They check the test setup but do not qualify power-loss durability:

```sh
GATE_ITERATIONS=1 bash packages/persistence/scripts/linux-crash-gate.sh
bash packages/persistence/scripts/linux-fault-gate.sh
bash packages/persistence/scripts/linux-write-order-gate.sh
```

The separate [disk-full gate](scripts/linux-disk-full-gate.sh) uses a disposable mounted filesystem and may require `sudo`. Run it on the intended Linux runtime as part of the storage-space review. Its small test database does not by itself establish a production journal-space reservation.

Run `bash packages/persistence/scripts/linux-physical-power-rehearsal.sh` to check the prepare and verify commands without restarting the machine. Its output says `REHEARSAL`, never `PASS`. The hosted `sqlite-crash-gate` workflow runs the same rehearsal. Neither result qualifies power-loss durability.

## Run one case across a power cut

Set `case_dir` to a new directory on the disposable mount. Use a different directory for every phase and repetition. For example, on the machine under test:

```sh
case_dir=/mnt/effect-vfs-test/acknowledged-01
GATE_DISPOSABLE=1 bash packages/persistence/scripts/physical-power-gate.sh prepare acknowledged "$case_dir"
```

Wait for `READY phase=acknowledged`. Save that line on the independent controller. Cut power while the writer is still running. After reboot, remount the same filesystem and run:

```sh
GATE_DISPOSABLE=1 bash packages/persistence/scripts/physical-power-gate.sh verify acknowledged "$case_dir"
```

Repeat the procedure with `pause-after-update`, `pause-before-commit`, `pause-after-commit`, and `acknowledged`. Run multiple repetitions with fresh directories. A failed boot, missing case, missing `READY` witness, failed reopen, or failed integrity check is a failed case. Do not repair the database or take an extra reboot and count that as a pass. Keep the failed disk image and logs for investigation.

The expected results are:

| Phase                 | Recovery requirement                                                       |
| --------------------- | -------------------------------------------------------------------------- |
| `pause-after-update`  | The earlier complete image remains.                                        |
| `pause-before-commit` | The earlier complete image remains.                                        |
| `pause-after-commit`  | The new complete image appears, even though the caller received no result. |
| `acknowledged`        | The acknowledged image remains.                                            |

The verifier also requires a changed Linux boot ID, a successful directory sync on reopen, `PRAGMA integrity_check=ok`, and a matching image digest. It writes `reopen.log`, `reopen-pragmas.txt`, `integrity.json`, and `boot-id-after.txt` beside the database. Do not treat `PASS` alone as a general durability certificate: it describes one case on one storage configuration.

## Return the evidence

For every case, send the complete case directory and the independent controller's `READY` transcript. Include the repository tag and commit, Bun and SQLite versions, `@effect/sql-sqlite-bun` version, Linux kernel, filesystem and mount options, drive and controller models, cache and flush settings, the power-cut method, the number of repetitions, and any failed boots. The script records much of the software environment in `environment.txt`; add the physical storage path and controller details yourself.

Record the production admission rule separately: database size limit, page size, rollback-journal allowance, and how the filesystem reserves enough space for both database and journal. See the [temporary-space policy](README.md#temporary-space-policy). The test fixture's small size does not prove that a larger production image fits.

Open or update [issue #144](https://github.com/lloydrichards/effect-virtual-fs/issues/144) with the configuration, results, and a link to the evidence. The maintainers will decide whether that exact setup supports a stronger durability tier. Until then, `Volume.durability` stays `memory-only` and public NFS `FILE_SYNC4` stays unavailable.
