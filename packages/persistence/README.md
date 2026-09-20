# SQLite persistence

`@effect-vfs/persistence` saves named filesystem snapshots and loads them for restoration in a later process.
The application chooses when to capture, supplies its SQLite connection through a `SqlClient` Layer, and controls
startup migrations.

The package does not load a runtime-specific database driver. The examples below use
`@effect/sql-sqlite-bun@4.0.0-rc.114` as an application-supplied Layer; another compatible SQLite `SqlClient` Layer
can be supplied by the application.

Core's `LiveVolume.open` uses a `LiveImageStore` service for live image commits.
`@effect-vfs/persistence/SqliteLiveImageStore` provides a scoped SQLite Layer through Effect's `SqlClient` service.
The application supplies a dedicated SQLite client for the same absolute local database path, plus Effect
`FileSystem`, `Path`, and `Crypto` Layers. The store reserves one SQL connection, holds SQLite's exclusive file lock
until release, and commits one complete image per mutation. It requires explicit image and database size limits.
The Bun SQLite client is one possible application-supplied Layer; it is not a production dependency of this package.

The provider uses SQLite's DELETE journal and `synchronous=EXTRA`, with `fullfsync=ON` on macOS. It checks these
settings on its commit connection, verifies image integrity, and distinguishes a confirmed rollback from an
uncertain commit result. A confirmed rejection leaves the live volume unchanged; an uncertain outcome makes it
unavailable until the application closes and reopens it. Reopening preserves the logical volume identity and
creates a new runtime incarnation. A second `LiveVolume.open` on the same provider Layer fails `Ownership`.

### Temporary-space policy

The provider uses one database and one transaction at a time. It rejects an attached database, disables SQLite
cache spilling, keeps eligible temporary files in memory, and sets `journal_size_limit=0` so an exclusive-lock
journal is truncated after a transaction. The last setting limits retained size, not peak size. The on-disk
DELETE rollback journal can still hold every original database page. For a configured database cap `D`, page
size `P`, and rollback-journal header sector size `S`, provision at least
`D + S + floor(D / P) * (P + 8)` bytes for the database and journal together, plus filesystem allocation and
directory overhead. The journal term includes one original-page record per database page. This bound assumes
the supplied SQLite VFS honors the configured page cap, reports a finite sector size, and uses the provider's
SQL without `ATTACH`, `VACUUM`, external writers, or other SQL that creates disk temporary files. Check those
assumptions on the intended driver and filesystem. The provider cannot inspect free filesystem space through
Effect's `FileSystem` service, so an application must reserve this physical budget on a dedicated filesystem or
quota before treating it as an admission guarantee. Exhausting the budget during a commit still yields a
confirmed rejection or an unknown outcome, followed by the provider's reopen rule.

SQLite's possible temporary-file classes are accounted for as follows. Database creation, ordinary commits,
and hot-journal recovery use the database's adjacent rollback journal; recovery reads an existing hot journal.
The provider updates one keyed row and rejects extra schema objects, including triggers, so its statements do
not need a statement journal. Temporary tables, indices, and query materialization use memory under the checked
`temp_store=2` setting and a build with `TEMP_STORE` other than `0`. The provider's SQL does not run `VACUUM`,
`ATTACH`, or explicit temporary tables. It rejects a connection with an attached database, which excludes a
super-journal for provider transactions. DELETE mode excludes WAL and shared-memory files. SQL run by another
user of the dedicated client is outside this policy.

The bounded Linux gate records each successful rollback-journal write extent through the test VFS. On a
disposable 4 MiB `tmpfs`, it commits and reopens with free space within 8,192 bytes of the calculated provision,
then fills the filesystem to 4,096 free bytes and checks rejection, whole-image recovery, and
`PRAGMA integrity_check`. The largest write extent observed in this finite test is not a general peak-size
guarantee. Database creation and hot-journal recovery use the same directory.
Set `syncDatabaseDirectory` to an operation that opens and syncs the verified
containing directory on the target driver and operating system. The provider
calls it after the supplied `SqlClient` opens the database and after it verifies
`PRAGMA database_list` against `filename`, but before it creates the schema or
returns the store. The call runs on every startup, including an existing database.
A reported sync error fails startup with `Storage`. A callback that never returns
or dies also cannot expose the live store. On Linux with a local filesystem, an application can open the directory
and call `fsync` on its file descriptor. The application must test that operation
on its chosen driver, OS, and filesystem. Without it, startup remains experimental
for crash durability. Storage flush behavior and the rest of #129 still require
qualification even when directory sync succeeds.

With `NodeFileSystem.layer` on Linux, the tested callback is:

```ts
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import { Effect, FileSystem } from "effect"

const syncDatabaseDirectory = (directory: string) =>
  Effect.scoped(Effect.gen(function*() {
    const filesystem = yield* FileSystem.FileSystem
    const handle = yield* filesystem.open(directory, { flag: "r" })
    yield* handle.sync
  })).pipe(Effect.provide(NodeFileSystem.layer))
```

The [live restart fixture](test/fixtures/live-restart.ts) enables this callback with
`LIVE_STORE_SYNC_DIRECTORY=1`. The process-death, VM hard-stop, write/sync fault,
write-order, and space gates use that setting and record `directory_sync=ok` only
after `handle.sync` succeeds.

This provider has process-restart coverage. Tests kill the writer after an acknowledged commit and after an
unacknowledged image update but before `COMMIT`, then reopen the database. Injected lost commit and rollback
acknowledgements also verify that the live volume stops serving operations until reopen. A UTM gate now exercises
guest operating-system hard stops on one recorded Debian/ext4 virtual disk configuration. It has not been
qualified for physical power loss or arbitrary storage stacks. `Volume.durability` therefore remains
`memory-only`. This provider must not yet be used to promise NFS `FILE_SYNC4`. The database page limit does
not cap temporary rollback-journal space by itself; apply the temporary-space policy above for a complete-image
transaction. Database creation also happens inside the supplied SQL Layer, before this provider can inspect the
path. The optional `syncDatabaseDirectory` operation establishes the creation-entry
sync only when the application supplies and validates a working implementation.
Use this provider for bounded local experiments until the remaining storage
assumptions and crash tests are completed.
Crash and power-loss qualification is tracked in
[#129](https://github.com/lloydrichards/effect-virtual-fs/issues/129).

### Crash recovery gate

The opt-in [SQLite crash recovery workflow](../../.github/workflows/sqlite-crash-gate.yml) runs on `ubuntu-24.04`.
Trigger it manually with `workflow_dispatch`, or add the `sqlite-crash-gate` label to a pull request. It runs the
provider test file, then repeats four real-provider process-death cases ten times: kill after the image update,
before `COMMIT`, after `COMMIT` but before its result reaches the volume, and after an acknowledged write. Each
case uses a fresh database, checks the reopened file contents, runs SQLite `integrity_check`, and verifies the
stored image digest. The uploaded artifact records the runner, Bun and SQLite versions, filesystem, commit
connection PRAGMAs, journal size at the kill point when present, and each case's results.

The workflow also checks a real disk-full response on a disposable 4 MiB `tmpfs` mount. A test-only SQLite VFS,
loaded before the provider opens its Bun connection, injects write and sync errors. One persistent main-database
write fault reaches rollback. The gate verifies the provider's result, post-error availability, recovered old or
new image, and `integrity_check`. These
tests characterize failures on the recorded runner. The separate
[write-order gate](scripts/linux-write-order-gate.sh) models writes lost or reordered
after successful sync calls. The finite space policy and its limits are described above.

For a local rehearsal, run `GATE_ITERATIONS=1 bash packages/persistence/scripts/linux-crash-gate.sh` from the
repository root after installing dependencies. This process-death gate does not stop the guest operating system or
model lost storage writes.

The [UTM VM gate](scripts/utm-vm-crash-gate.sh) runs on one Apple Silicon Mac with a dedicated ARM64 Linux VM named
`Crash Test` and its QEMU guest agent. With UTM and `utmctl` installed, run
`bash packages/persistence/scripts/utm-vm-crash-gate.sh`. The host bundles the same real-provider fixture,
transfers Bun 1.2.21 and the fixture into the guest, then forcibly stops and reboots the VM at each of the
four boundaries, three times each. The guest disk persists across boots. The gate reopens through the provider,
checks the expected complete image, SQLite `integrity_check`, and the stored SHA-256 digest. It writes host,
guest, storage, PRAGMA, and per-case evidence to the printed directory. Use `GATE_VM_NAME`,
`GATE_ITERATIONS`, and `GATE_OUTPUT_DIR` to select the VM, repeat count, and output directory. Set
`GATE_STOP_MODE=kill` to use UTM's VM-process kill instead of its forced power-off event. The VM must be
dedicated to this test because the gate stops it without guest shutdown.

On the earlier recorded run, all 12 guest hard-stop cases passed with Debian 12, Linux 6.1.0-13-arm64, ext4 on a QEMU
virtual disk, Bun 1.2.21, and SQLite 3.50.4. The commit connection reported DELETE journaling,
`synchronous=EXTRA`, `fullfsync=ON`, and exclusive locking. This establishes a guest OS-crash result for that
configuration. A forced VM stop does not establish physical power-loss durability. The VM result assumes SQLite's
sync requests reach the virtual disk; it does not
verify how UTM/QEMU, the Mac filesystem, or the physical device handle flushes.
An exploratory VM-process-kill run later encountered a guest boot hang; an additional restart recovered the
database, but the gate reports a boot hang as a failed run.
Two one-iteration runs with directory sync enabled on 2026-09-20 also failed the
complete four-case gate because the guest did not restart after a hard stop. The
first passed three cases and hung after the acknowledged case; a second restart
recovered that acknowledged image with integrity `ok`. The second run passed the
after-update case and hung after the before-`COMMIT` case. These are failed gate
runs, not a qualified guest OS-crash result for the new startup configuration.

The [VM fault gate](scripts/utm-vm-fault-gate.sh) runs the same bundled provider on
Debian 12, Linux 6.1.0-13-arm64, ext4, and Bun 1.2.21. Its SQLite VFS reported a
4,096-byte sector size for the main file and rollback journal. The VirtIO device
reports 512-byte logical and physical blocks and a write-back cache. On a
disposable 16 MiB ext4 loop filesystem with reserved blocks disabled, the
2,000,000-byte database cap and 4,096-byte page size produced a 4,068,288-byte
conservative provision. The gate committed near that provision, then observed
`StorageRejected` and the old complete image with 3,072 bytes free. This finite
test does not reserve that space for a production database. The same gate reproduced
three acknowledged-image breaches when its VFS lied about successful syncs.
The running UTM command uses a VirtIO qcow2 image without `cache.no-flush`; QEMU's
documented default is write-back with flushes enabled. No test here proves that
host APFS and the physical device complete those flushes before acknowledgement.
The database therefore remains experimental for physical power loss.

## Save and restore

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { CheckpointStore } from "@effect-vfs/persistence"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { Effect, Layer } from "effect"
import * as ByteSize from "effect/ByteSize"

const limits = {
  maxEncodedBytes: ByteSize.megabytes(10),
  maxRecords: 10_000,
  maxEntries: 20_000,
  maxDecodedBytes: ByteSize.megabytes(5)
}

const Database = SqliteClient.layer({ filename: "checkpoints.sqlite" })
const Checkpoints = CheckpointStore.layer(limits).pipe(
  Layer.provide(Layer.effectDiscard(CheckpointStore.migrate)),
  Layer.provide(Database)
)

const save = Effect.gen(function*() {
  const store = yield* CheckpointStore
  const volume = yield* Vfs.fromFixture({
    entries: [{ kind: "file", path: "/hello.txt", bytes: new TextEncoder().encode("hello") }]
  })
  yield* store.save("run-42", yield* volume.snapshot)
})

// Run once. Reusing the same name fails with AlreadyExists.
await Effect.runPromise(save.pipe(Effect.provide(Checkpoints)))

// This can run in another process with the same database and layer setup.
const restore = Effect.gen(function*() {
  const store = yield* CheckpointStore
  const snapshot = yield* store.load("run-42")
  const volume = yield* Vfs.fromSnapshot(snapshot, { maxBytes: ByteSize.megabytes(5) })
  return yield* (yield* volume.caller()).readFile("/hello.txt")
})

const bytes = await Effect.runPromise(restore.pipe(Effect.provide(Checkpoints)))
```

`CheckpointStore.make(limits)` also constructs a store directly when `SqlClient` is already provided.
Neither `make` nor `layer` runs migrations. The example's explicit migration layer runs before store construction.
Applications with an existing startup sequence can instead yield `CheckpointStore.migrate` there.

## Contract

- `save(name, snapshot)` creates one immutable named checkpoint. It does not replace an existing name.
- `load(name)` returns a validated core `Snapshot`. Restoring it creates a fresh independent volume.
- Names contain 1–255 UTF-8 bytes. NUL and lone UTF-16 surrogates are rejected. Leading BOM characters are preserved.
  Names are literal, case-sensitive keys with no path handling or Unicode normalization.
- Construction validates and copies `DecodeLimits` when its Effect executes. Save validates the encoded snapshot
  against those same limits before inserting. This adds a validation pass but guarantees that the store can load
  what it saves under its configured limits.
- SQLite stores the existing JSON/base64 image as a BLOB. Load checks BLOB size inside its query before returning
  the payload, then runs core's complete snapshot decoder. Limits bound logical input, not exact heap use.
- While snapshot version 1 is being solidified, checkpoints written by an earlier schema revision may fail core
  validation. Regenerate those checkpoints; the persistence package does not migrate snapshot bytes.
- Capturing remains the caller's responsibility. Subsequent volume edits require another snapshot and a new name.

`CheckpointError` has `code`, `operation`, and optional `name` and `cause` fields:

| Code            | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `InvalidName`   | The key violates the name contract.                                |
| `NotFound`      | No checkpoint exists under this name.                              |
| `AlreadyExists` | A valid save attempted to reuse a name. The original is preserved. |
| `Storage`       | SQLite or migration failed; `cause` preserves diagnostic details.  |

Core `ImageError` is preserved for invalid configuration limits, unsupported or corrupt images, and exceeded
image budgets. Save validates the name and image before attempting insertion, so invalid input can fail before
duplicate-name detection. Restore applies its own destination volume limits independently.

## Database ownership and commit behavior

The application provides a SQLite `SqlClient` whose scope must outlive the store. The module owns
`effect_vfs_checkpoints` and `effect_vfs_checkpoint_migrations`. Its numbered migrations use a separate ledger from
the application's migrations. Run startup migration before accepting checkpoint requests; coordinate startup
migrations when multiple processes open the same database.

An insert is atomic and enforces uniqueness in SQLite. Competing saves cannot overwrite the winning checkpoint.
The store participates in an enclosing Effect SQL transaction if one exists; in that case, successful `save`
does not commit the outer transaction. Without an outer transaction, a successful save has completed its insert.
Interruption can arrive after commit but before acknowledgment. Retrying that name can return `AlreadyExists`.

The Bun driver uses synchronous SQLite calls, so database contention can block the event loop. Applications own
busy timeout, journaling, synchronization settings, and backups. The restart test verifies restoration after the
writer process exits; it does not establish power-loss durability for arbitrary SQLite configurations.

This version provides no history, replacement, listing, deletion, revision checks, automatic saving, compression,
or incremental snapshot storage. Snapshot diffs are a separate core feature.

## Development

From the repository root:

```sh
bun run test --filter=@effect-vfs/persistence
```

The package test task builds its exports, runs real SQLite tests under Bun, and launches separate save and restore
processes against a temporary database. NodeNext declaration checks cover the public package exports; they are not
a Node SQLite runtime test.
