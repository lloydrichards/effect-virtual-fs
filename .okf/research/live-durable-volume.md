---
type: Research Report
title: Live durable volume proposal
description: Proposes private mutation staging and a synchronous SQLite commit boundary for a bounded shared volume, with explicit failure, recovery, and NFS replay rules.
status: draft
tags: [persistence, durability, transactions, nfs]
sources:
  - id: engine
    resource: ../../packages/core/src/internal/virtualFileSystem.ts
    title: Live engine, handles, revisions, snapshots, and publication
  - id: api
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Shared Volume and caller contracts
  - id: errors
    resource: ../../packages/core/src/internal/virtualFileSystem/errors.ts
    title: Current filesystem error codes
  - id: snapshot
    resource: ../../packages/core/src/Snapshot.ts
    title: Public snapshot exclusions
  - id: watch
    resource: ../../packages/core/src/internal/virtualFileSystem/watchHub.ts
    title: Bounded per-subscriber watch queues
  - id: checkpoint
    resource: ../../packages/persistence/src/CheckpointStore.ts
    title: Application-driven named checkpoints
  - id: live-image
    resource: ../../packages/core/src/internal/liveImage.ts
    title: Private live image schema and validation
  - id: live-store
    resource: ../../packages/core/src/LiveVolume.ts
    title: Provider-neutral live image store service and scoped opening
  - id: sqlite-live-store
    resource: ../../packages/persistence/src/SqliteLiveImageStore.ts
    title: Effect SQL live image store provider
  - id: sqlite-write-order
    resource: ../../packages/persistence/scripts/linux-write-order-gate.sh
    title: SQLite successful-sync write-loss and reorder fault gate
  - id: nfs
    resource: ../../packages/nfs/src/internal/nfs4.ts
    title: Replay admission, operation interruption, and slot rollback
  - id: sqlite-sync
    resource: https://sqlite.org/pragma.html#pragma_synchronous
    title: SQLite synchronization settings
  - id: sqlite-atomic
    resource: https://sqlite.org/atomiccommit.html
    title: SQLite atomic commit and storage assumptions
  - id: sqlite-recovery
    resource: https://sqlite.org/lockingv3.html
    title: SQLite hot-journal recovery
  - id: sqlite-wal
    resource: https://sqlite.org/wal.html
    title: SQLite WAL and checkpoint growth
  - id: rfc
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: NFSv4.1 sections 9, 18.3, and 18.32
  - id: issue-47
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/47
    title: Open and lock state
  - id: issue-48
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/48
    title: Writable exports
  - id: issue-49
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/49
    title: WRITE stability and COMMIT
  - id: issue-50
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/50
    title: Restart recovery
generated: { by: codex/okf, at: 2026-09-20T07:41:00Z }
---

# Live durable volume proposal

Recommend an application-supplied, bounded storage Layer behind core's `LiveImageStore` service. Each operation builds a private candidate state, commits its image, then publishes the candidate and watch events. One possible provider replaces one complete engine image per transaction. This costs time proportional to volume size but keeps the recovery proof small. It targets small volumes, not large or high-throughput storage.

This remains a design proposal for the unfinished writable milestone. Core staging, a private image codec, and an injected `LiveImageStore` service now exist. An Effect `SqlClient`-based SQLite provider implements bounded whole-image commits and has process-restart coverage. [#129](https://github.com/lloydrichards/effect-virtual-fs/issues/129) tracks crash and power-loss qualification and rollback-journal space; [#122](https://github.com/lloydrichards/effect-virtual-fs/issues/122) provides bounded watches and admission. Writable NFS dispatch remains open. The provider does not establish #48 or #49 and leaves `Volume.durability` at `memory-only`.[^sqlite-live-store]

## Accepted requirements and proposed choices

The [writable export scope](../decisions/nfs/writable-export-scope.md "constrained by") fixes local single-user authorization, the selected namespace and metadata operations, full relevant NFS open and lock behavior, and durable success for both NFS and direct callers. Every successful NFS `WRITE` has `FILE_SYNC4` strength. A compound remains a sequence of operations. Restart may require remounting until #50.

The [reference-mutation decision](../decisions/core/reference-mutations.md "constrained by") keeps share reservations, advisory byte-range locks, stateids, and leases in NFS. The [volume facts decision](../decisions/core/volume-durability-and-usage-facts.md "constrained by") keeps a static durability tier, stable logical identity, fresh incarnation on construction, and a byte-count write result. These remain unchanged.

Core staging, the private image format, the storage-error API, and the first SQLite provider are implemented. The remaining storage qualification and NFS rules below are proposals for the writable milestone. The separate [watch overflow decision](../decisions/core/watch-event-overflow.md "constrained by") owns the bounded-watch contract.

## Durability promise

On a supported local filesystem and storage stack that honors synchronization, successful operations survive process termination, operating-system crash, and power loss. An operation whose success was not observed may also have committed. There is no promise against destruction of the storage module, undetected hardware corruption, or an administrator restoring an older database. Restoration is an explicit new runtime lifetime.

RFC 8881 defines stable storage to include repeated power failures and crashes. A process-crash-only tier cannot justify `FILE_SYNC4`. The writable export must require `survives-power-loss` from a qualified provider. Weaker configurations may be useful separately but must not silently enable this writable milestone.[^rfc]

Use a dedicated local SQLite database with `journal_mode=DELETE`, `synchronous=EXTRA`, and `fullfsync=ON` on macOS. Read settings back on the actual commit connection. `EXTRA` adds directory synchronization after journal unlink; `FULL` alone in DELETE mode does not give the same power-loss guarantee. WAL with `synchronous=FULL` is another valid choice; WAL with `NORMAL` can lose committed transactions after power loss.[^sqlite-sync]

The provider owns the connection and excludes ambient transactions, connection pooling with unchecked settings, external writers, network filesystems, and in-memory SQLite. Hold an OS-managed exclusive lifetime lock on the store; a stale PID file is insufficient. Initialize the database and its containing directory durably before returning a volume. The chosen runtime driver and host sync implementation must be qualified. A successful PRAGMA query alone does not prove that the device honors flushes.[^sqlite-atomic]

## Alternatives

| Choice                                            | Commit and recovery work                                                                                                                                                                                                                                                                                                                               | Recommendation                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Custom append-only write-ahead log                | Frame versioned transactions with sequence, length, checksum, and commit marker; sync before publication; replay only complete committed records; atomically install compacted images and sync directories before deleting old log segments. Recovery must distinguish a torn tail from corruption and never rerun live permission or clock decisions. | Defer. Efficient deltas do not justify owning torn-write, compaction, and format-upgrade correctness in the first provider. |
| SQLite WAL with normalized node and content rows  | One SQL transaction for every node, link, metadata, counter, and content update. Sync WAL at commit; bound WAL growth and checkpoint duration.                                                                                                                                                                                                         | Good later throughput option. Long readers can prevent checkpoints from completing and permit WAL growth.[^sqlite-wal]      |
| SQLite rollback journal with one engine-image row | SQLite owns atomic replacement and hot-journal recovery. No application log or retained transaction history.                                                                                                                                                                                                                                           | First provider. Full-image serialization and journal writes are acceptable only with explicit small-volume limits.          |
| Save an ordinary snapshot after a live mutation   | Storage failure leaves published memory ahead of durable state; public snapshots omit unlinked open objects.                                                                                                                                                                                                                                           | Reject as a commit boundary. `CheckpointStore` remains explicit backup and interchange.[^checkpoint][^snapshot]             |

The full-image choice is not a wrapper that calls `Volume.snapshot` after an operation. It requires staging below all callers and handles, before the live state changes.

## Core transaction boundary

The memory engine mutates node objects directly inside `coordinated`; handles and references retain those objects. The internal fake-provider path now stages copies before commit. Reads also update access time. These are engine changes, not just persistence plumbing.[^engine]

The engine audit identifies five state groups that must move together at publication:

| State                                                                                                      | Current owner                             | Commit requirement                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Reachable nodes, hard-link aliases, parent edges, metadata, content, revisions, inode allocator, and usage | `EngineState` and mutable nodes           | Copy the graph with shared aliases intact; publish counters and nodes together.                                |
| Unlinked files retained by open handles and detached directories retained by callers                       | Handle and caller references              | Keep them in the candidate even though a public snapshot cannot reach them; reclaim them on the final release. |
| File and directory handle cursors, open counts, closed flags, and object-reference validity                | Mutable capability records and node cells | Keep failed candidates from advancing cursors, closing resources, or invalidating references.                  |
| Access times from file, path, and directory reads                                                          | Read methods inside `coordinated`         | Commit the metadata change before returning the read result.                                                   |
| Watch changes                                                                                              | `WatchHub` calls inside mutations         | Buffer candidate events and publish them only after the provider confirms commit.                              |

This audit rules out a graph-only copy. The core now stages reachable and retained nodes, capability records, reference invalidation, and watch events before publication. Its private image preserves inodes, hard links, revisions, counters, limits, and retained unlinked files. Recovery drops zero-link files because their handles ended with the prior process. Core tests cover injected committed and rejected outcomes, image validation, and staged publication. The SQLite provider has process-death and guest OS forced-stop recovery tests, plus returned I/O-error tests. These do not qualify physical power loss. Writable NFS dispatch remains open. Memory volumes still use the direct path.[^live-image][^live-store][^sqlite-live-store]

Introduce a core-owned `EngineState` and stable runtime object keys. Capabilities retain keys and resolve them against the current state under the gate. A candidate owns copied metadata, maps, mutable bytes, counters, and changed handle state. Immutable content can be shared, but no candidate write may modify a live buffer. Reference invalidations, newly opened handles, cursor advances, and quota charges publish with the state swap. Pure handle movement stays volatile and coordinated.

Start with one gate and one candidate at a time. Readers, snapshots, usage queries, watcher registration, closes, and other writers wait while a candidate commits. This deliberately trades read latency for a simple ordering rule. Direct path calls, reference calls, and existing writable handles all use this mechanism. No writable memory volume is exposed beside it.

1. Own and validate inputs, then apply bounded admission. Mutation and observation permit waits remain interruptible.
2. Under the gate, check provider health and build the candidate from the current state. Evaluate authority, timestamps, byte counts, namespace change pairs, quotas, and every operation-specific failure. Prepare owned result bytes and watch paths. Reserve publication capacity before storage begins.
3. Encode and validate a versioned durable image of the candidate. Allocation, encoding failure, or interruption here discards the candidate. No live revision, cursor, reference, or event changes.
4. Enter a masked commit-and-publication region. On the dedicated connection, `BEGIN IMMEDIATE`, replace the image and increment its generation with an expected-generation condition, then `COMMIT`. A generation mismatch closes the provider; it is not a retry of the filesystem operation. The database transaction includes every durable effect of this one core operation.
5. After confirmed commit, synchronously install the candidate state and preallocated results, then enqueue the reserved watch events in order. Release the gate and return the result. Publication cannot invoke application callbacks, perform I/O, or fail for ordinary capacity reasons.

Storage commit is the durability point. The state swap is the live visibility point. The gate prevents an observer from seeing the gap. A process death in that gap recovers the committed candidate. There is no compensating transaction after commit and no snapshot save after publication.

Cancellation before step 4 means no mutation. Once commit starts, settle its outcome and publication before honoring cancellation. An interrupted caller may therefore have changed the volume without receiving a result; it must not blindly retry non-idempotent operations. A timeout does not prove rollback. If a worker or connection must be abandoned, stop admitting all volume operations until the old writer has terminated and recovery has established the outcome.

In installed `effect@4.0.0-rc.114`, `SqlClient.makeWithTransaction` converts COMMIT and ROLLBACK failures into defects through `Effect.orDie`. A typed `SqlError` catch around the transaction is insufficient. The persistence adapter must own transaction control or classify the complete exit at this boundary, preserve an unknown outcome, and never convert a storage defect into success. Core remains free of SQLite and driver APIs.

## Stored state and restart

Use a separate private format, provisionally `effect-vfs-live-v1`. One database row contains a format version, logical volume identity, monotonically increasing commit generation, configured semantic limits, and an encoded engine image with a digest. The image contains root and object keys, kinds, raw byte names, edges, metadata, file bytes, symlink bytes, revisions, allocator state, and zero-link objects still retained by live resources. Encode bigints losslessly. Validate graph structure, counters, limits, digest, and version before accepting the store.

Persistent object keys preserve hard-link sharing inside this store. They do not promise persistent public inode numbers or NFS filehandles. Public [snapshot identity](../decisions/core/snapshot-local-file-identity.md "constrained by") stays image-local. Public snapshots still contain only reachable objects and remain portable. Importing one initializes a new store once; importing into an existing store is not a live mutation shortcut.

Recovery proceeds before callers become available:

1. Acquire exclusive ownership and let SQLite recover any hot journal. Its transaction recovery selects the old or new complete row; never merge candidate fragments or replay caller commands.[^sqlite-recovery]
2. Decode the bounded image. Reject unknown versions, corruption, identity mismatch, or stricter startup limits that cannot hold the stored state. Do not silently substitute an older checkpoint.
3. Rebuild shared objects and counters. Reset volatile callers, handle cursors, open counts, and watch subscriptions. Reclaim zero-link objects because their old handles cannot survive this milestone, and commit this cleanup before serving. A failed cleanup leaves startup unavailable.
4. Restore logical `Volume.identity` and mint a new `incarnation`. NFS derives a new storage verifier and expires old filehandles; sessions, opens, locks, and cached replies remain NFS-owned and volatile. Remounting is the supported first recovery path.

Unlinked open files remain charged, readable, and durably writable during a live lifetime. A final close removes their durable record. Close must still invalidate and release the runtime handle if cleanup storage fails; retain the durable orphan for startup reclamation and stop the provider. A finalizer must not retain a live resource merely to retry disk cleanup forever.

Access-time updates in `read`, `readFile`, and `readDirectory` also pass through staging and commit before returning data. Preserve their current revision and watch behavior. This is expensive but avoids introducing an unreviewed lazy-atime policy. No-op operations and pure observations need no database transaction.

## Failure outcomes

| Failure point                                                                       | Live observation                              | Recovery and caller outcome                                                                                                                   |
| ----------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission, logical quota, encoding, queue admission, or interruption before commit | Old state; no event or cursor change          | Definite rejection. Retry follows normal API semantics.                                                                                       |
| SQL statement fails and rollback is confirmed                                       | Old state; no event                           | Return typed storage failure, or `NoSpace` for confirmed capacity exhaustion. Provider may continue if connection health is established.      |
| COMMIT or ROLLBACK returns an error with uncertain outcome                          | No candidate published; freeze service access | Return an outcome-unknown storage error. Close and recover before serving again. Do not claim unchanged state or retry automatically.         |
| Crash during the database transaction                                               | No partial state served after reopen          | SQLite recovers old or new complete image. Every previously acknowledged commit remains. The current unacknowledged operation may be present. |
| Commit succeeds; process dies before state swap, watch publication, or reply        | No rollback                                   | Reopen sees new state. Watches are live-only and do not replay crash-gap events.                                                              |
| Commit succeeds; live publication hits a defect                                     | Stop the provider                             | Recover new state; never continue with stale memory or report a definite rejected mutation.                                                   |
| Reply is lost after commit                                                          | Committed state                               | NFS replays its cached result within the session; direct callers have no automatic deduplication contract.                                    |
| Corrupt image or failed recovery                                                    | No volume exposed                             | Typed startup failure; operator repair or explicit backup restore. No success claim.                                                          |

Physical disk exhaustion is distinct from logical `maxBytes`. `pwrite` and `write` retain current short-write semantics: choose an accepted prefix under logical quotas, atomically commit that prefix and its metadata, and return exactly that byte count. A subsequent SQL failure rejects the entire candidate prefix, with no cursor advance. Do not guess a smaller prefix after physical disk exhaustion. `writeFile`, rename, and other atomic core operations remain all-or-nothing. Sequential `SETATTR` calls can leave already committed attributes applied, as accepted; NFS reports the applied subset.

## Shared API and ownership

| Owner          | Proposed responsibility                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core           | Candidate construction and publication; capability identity; reference and path parity; private image codec; quotas; watch ordering; a narrow provider commit contract.                                                               |
| Store provider | A scoped Layer owns storage, exclusive access, generation fencing, recovery, atomic image replacement, and commit outcome classification. An Effect `SqlClient` implementation exists; its crash-boundary qualification remains open. |
| NFS            | Authorization, share reservations, advisory locks, exclusive-create interpretation, replay admission, reply caching, verifier derivation, and eventual #50 recovery.                                                                  |
| Application    | Supported host and driver composition, store path, limits, backup policy, and explicit writable export opt-in.                                                                                                                        |

The implemented core `LiveImageStore` service has `loadOrCreate(initialImage)` and `commit(candidateImage)` operations. Its scoped provider Layer owns the storage resource. Core prepares and validates the image, coordinates publication, checks recovered limits, and shuts down the volume before the provider Layer closes. `commit` reports committed, definitely rejected, or unknown; an unknown outcome stops the volume. The core must never accept an arbitrary caller-supplied durability label without the corresponding provider contract. A provider must not call public volume operations recursively while holding the gate. A Postgres provider may implement the service separately, but must establish its own ownership and outcome guarantees rather than reuse SQLite assumptions. A generic `SqlClient` alone does not establish connection affinity, exclusive ownership, or a known result after a failed commit.

The core defines `StorageRejected`, `OutcomeUnknown`, and `VolumeUnavailable` as distinct `FsError` codes and NFS maps them to `NFS4ERR_IO`; memory volumes do not emit them. `NoSpace` remains a known capacity rejection. An unknown commit outcome stops subsequent operations, including observations and watch registration. Core prepares and bounds an image before entering the masked storage commit; a preparation failure rejects the candidate without poisoning the volume. A confirmed provider rejection preserves the live state. A failed final close releases its runtime handle and stops the volume. Active watch-stream shutdown after provider failure still needs specific proof. NFS must stop the affected export on unknown outcome.[^engine][^live-store]

`FileHandle.sync` does not become a second commit mechanism. With synchronous mutations there is no pending dirty data; it checks handle and provider health. Its current memory-only documentation needs provider-aware wording.

## NFS ordering required before writable dispatch

NFS first validates the session, credential mapping, stateid, share reservation, and operation bounds. NFS state coordination spans conflict checks and the associated I/O so another NFS client cannot invalidate the check while storage waits. Direct callers remain outside this lock boundary. NFS reserves worst-case response and replay capacity before the first possible mutation, including opens that create or truncate. It then calls the durable volume, records each result, finalizes the slot, and only then sends the reply. A successful `WRITE` reports the returned prefix count, `FILE_SYNC4`, and the incarnation-derived verifier. `COMMIT` validates its arguments and state and returns that verifier after confirming a healthy provider; the synchronous volume has nothing left to flush.[^rfc]

The NFS handler reserves response and replay bytes at `SEQUENCE`. Before dispatching a compound that may change state, it records a consumed-slot marker. Operations remain interruptible while waiting on the export; their own commit boundaries protect state changes. If cancellation or a late bound check prevents a full reply, the marker remains, so a retry cannot execute the compound again. A compound with no possible state change can release its slot on interruption.[^nfs]

This boundary does not make the compound a transaction. If a later operation fails, earlier changes remain committed, and a cached reply retains each operation's result. Tests cover lost `OPEN` replies, a later operation failure, cancellation after `OPEN`, an operation defect, and capacity rejection before `OPEN`. Writable namespace and data operations still return `NFS4ERR_ROFS`; their reply bounds and storage failures need tests when dispatch is added. A stalled driver also needs the fail-closed recovery rule above.

With `cachethis=false`, retain the consumed-slot record and return `NFS4ERR_RETRY_UNCACHED_REP` on retry instead of rerunning mutations. Fatal unknown storage outcomes invalidate the affected export/session lifetime, even if no final reply can be formed. A crash after storage commit but before replay publication requires remount; this proposal does not promise exactly-once execution across restart or durable session state. #50 owns that extension.

Both exclusive `OPEN` create modes require their verifier and required creation attributes to enter the same core candidate that creates the exact object. NFS owns their interpretation; durable metadata owns the resulting bytes. A create followed by a separate verifier write has a crash gap. Verify that the accepted initial timestamp encoding covers each mode and its attribute restrictions before dispatch implementation. Sections 9, 18.3, and 18.32 also do not relax the full #47 open and lock prerequisite.[^rfc]

## Resource bounds

Require finite content, entry, object, image-byte, input-byte, handle, caller, subscriber, queued-request, and pending-event limits. Object limits count retained unlinked objects and detached directories; namespace entry limits alone cannot bound them. Bound candidate memory as old state plus candidate plus encoded image, result buffers, and driver copies. Refuse oversize candidates before SQL. Persist semantic limits and never silently relax them on restart.

The database retains one current image and reusable free pages, not one row per commit. Cap database pages and SQLite cache; budget rollback-journal space separately, including page and journal overhead. `maxBytes` remains logical content capacity and cannot promise physical free disk. Bound retained snapshots through application lifetimes. Compaction and backup are separate maintenance operations with explicit temporary-space budgets; ordinary commits must not depend on an unbounded history cleanup.

The core and staged provider use bounded per-subscriber watch queues and a rescan marker.[^watch] The accepted [watch overflow decision](../decisions/core/watch-event-overflow.md "constrained by") defines the marker, adapter projection, capacity, and admission result. A stalled watcher cannot block or reject an unrelated mutation.

Set a finite SQLite busy timeout and bounded retry count before commit. These do not bound a kernel flush that never returns. Document that limitation; worker isolation can allow application responsiveness, but killing a worker makes the transaction outcome unknown until recovery. No fixed shutdown-latency promise follows from Effect interruption masking.

## Implementation slices and proof

1. Core now stages state through the `LiveImageStore` boundary and classifies committed, rejected, and unknown outcomes. Its tests cover candidate publication and failures. Full-image throughput at candidate volume limits still needs measurement.
2. The SQLite provider Layer now owns exclusive access, atomic image replacement, finite image and database limits, and process recovery. [#129](https://github.com/lloydrichards/effect-virtual-fs/issues/129) owns database-creation directory synchronization, driver and crash qualification before any stronger durability claim. NFS remains read-only.
3. Resolve the separate watch-overflow contract and qualify the stated crash boundary on Linux and macOS. Document the filesystem, SQLite build, driver, sync settings, and storage assumptions. Only a storage configuration qualified for that crash boundary advertises `survives-power-loss`; bounded watches are a separate writable-milestone requirement.
4. After #47, implement NFS admission and replay changes, then #48 dispatch and #49 `WRITE` and `COMMIT`. #50 remains separate. No protocol implementation is part of this proposal.

The smallest convincing test set exercises observable boundaries, not only injected success callbacks:

- A controlled commit provider pauses or fails before commit. Concurrent path and reference readers, `usage`, snapshots, watches, and a second writer see no candidate state. Confirmed failure preserves bytes, namespace, revisions, quotas, cursors, and reference validity; success exposes one coherent transition and ordered events.
- Through real SQLite, write a quota-limited prefix, replace a file, perform cross-directory rename over an existing object, and update metadata. Restart and verify complete results, hard-link aliasing, stable volume identity, changed incarnation, and rejection of old capabilities. Exercise direct and NFS-facing callers on the same volume.
- Unlink an open file, write it, and close it; inject cleanup failure and restart. Verify live charging and access, eventual orphan reclamation, and no resurrection in the namespace. Include access-time commits. In the later bounded-watch slice, a stalled watcher must receive or retain a rescan signal without denying an unrelated write.
- Kill a child process at transaction-body, commit, publication, and reply checkpoints. An external observer records acknowledgments. Every acknowledged operation survives; the final unacknowledged operation is wholly absent or present. Inject disk-full, sync failure, rollback failure, malformed image, and competing ownership. Unknown outcomes stop all service access.
- Use a SQLite fault VFS or controlled VM/block-device crash setup to lose unsynced writes at storage boundaries and reopen the store. `SIGKILL` alone proves only process-crash behavior. Repeated power-cut cases must never lose an acknowledged commit; hardware qualification and SQLite assumptions remain part of the claim.
- In later NFS wire tests, drop the reply and retransmit mutating compounds with cached and uncached replies, interrupt after the first committed operation, and exhaust replay capacity before dispatch. Assert no repeated mutation, correct short count and `FILE_SYNC4`, unchanged verifier within a lifetime, changed verifier after reconstruction, and required remount after restart.

### Successful-sync write faults

The test-only SQLite VFS now has `lost-write` and `reorder-write` modes. The first reports `SQLITE_OK` while omitting one selected main-file write. The second defers that write until after the next write to the same file. Both leave `xSync` to the underlying VFS and log successful sync calls. This is a deterministic model of a device or filesystem that does not honor the order or persistence SQLite expects; it is not a physical power-cut simulation. The bounded Linux matrix uses the existing live-volume worker, acknowledgement output, reopen check, and `PRAGMA integrity_check`.[^sqlite-live-store]

One exploratory matrix on Debian 12, Linux 6.1 arm64, ext4 on a QEMU VirtIO disk, Bun 1.2.21, `@effect/sql-sqlite-bun` 4.0.0-rc.114, and SQLite 3.50.4 covered twelve cases. The six acknowledged cases injected the first, second, or third matching main-file write. All six writers reported `committed` after successful sync calls. The three lost-write cases failed to reopen and failed `PRAGMA integrity_check`; the first had an invalid page reference. The three reordered-write cases reopened the complete new image and passed integrity checking. In the six unacknowledged cases, both fault modes recovered the old image after UPDATE and before COMMIT, and the complete new image after COMMIT. All six passed integrity checking. The commit connection reported DELETE journaling, `synchronous=3` (`EXTRA`), `fullfsync=1`, and exclusive locking. These results show that the provider cannot promise acknowledged durability when the storage stack lies about writes and syncs. They do not establish a supported power-loss configuration. The gate returns failure for an invariant breach. Its fault placement and results must be rerun for any proposed driver or storage configuration.
The open performance question is the maximum useful volume size with full-image commits and durable atime reads. Measure it before choosing defaults. If the bound is too small for the intended workload, change the persistence representation to transactional rows while retaining the same staging, failure, and publication contract.

[^engine]: `coordinated`, `replaceContent`, `fileHandle`, `releaseFile`, `captureSnapshot`, and the returned `volume` in the engine source.

[^checkpoint]: `CheckpointStore.save` accepts a snapshot captured by its caller; it does not participate in the engine gate.

[^live-image]: The live image schema validates graph reachability, link counts, byte usage, names, and stored limits before recovery.

[^live-store]: `LiveVolume.open` consumes the injected store service, validates recovered image limits, and coordinates scoped shutdown.

[^sqlite-live-store]: `SqliteLiveImageStore.layer` reserves an application-supplied Effect `SqlClient` connection and its exclusive SQLite lock, uses DELETE journaling and `synchronous=EXTRA`, verifies stored image digests, and classifies commit results. `packages/persistence/scripts/linux-crash-gate.sh`, `linux-fault-gate.sh`, and `linux-write-order-gate.sh` cover distinct failure models. None proves physical power-loss durability.

[^snapshot]: Public snapshots exclude callers, open handles, watch subscriptions, and unlinked content.

[^watch]: `WatchHub.make` uses independent bounded subscriber queues and synchronous publication.

[^nfs]: `compound` reserves replay bytes at `SEQUENCE` and installs a consumed-slot marker before state-changing dispatch. Post-execution size checks remain as defensive bounds.

[^sqlite-sync]: SQLite's synchronous-mode matrix and `fullfsync` documentation. These are storage configuration conditions, not hardware-test evidence.

[^sqlite-atomic]: SQLite atomic commit describes flush, filesystem, and device assumptions and journal-based commit.

[^sqlite-recovery]: SQLite locking documentation describes hot-journal rollback before reads.

[^sqlite-wal]: SQLite WAL documentation, sections 2.1 and 6, describes checkpointing and WAL growth.

[^rfc]: RFC 8881 sections 9.1 and 9.7 for lock boundaries; 18.3 for COMMIT; 18.32 for WRITE, stable storage, short counts, and verifiers; 18.16 for exclusive creation; 2.10.6 for replay-cache recovery.
