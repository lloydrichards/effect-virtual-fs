---
type: Decision
title: Persistence store helpers
description: Names every persistence failure by its entry point, shares live-image validation and ownership policy behind SQLite, PostgreSQL and R2 storage operations, and defines initialization and cancellation recovery.
status: stable
tags: [persistence, errors, sqlite, postgres, r2]
sources:
  - id: checkpoint-store
    resource: ../../packages/persistence/src/CheckpointStore.ts
    title: Checkpoint failures named by entry point
  - id: store-support
    resource: ../../packages/persistence/src/internal/storeSupport.ts
    title: Shared failure constructors and SHA-256 digest
  - id: live-protocol
    resource: ../../packages/persistence/src/internal/liveImageProtocol.ts
    title: Shared validation and ownership state machine
  - id: store-contract
    resource: ../../packages/persistence/test/helpers/liveImageStoreContract.ts
    title: Reusable live-image behavior contracts
  - id: protocol-contract
    resource: ../../packages/persistence/test/LiveImageProtocol.test.ts
    title: Create-race and uncertain-initialization contracts
  - id: protocol-issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/238
    title: One live-image ownership protocol
  - id: sqlite-store
    resource: ../../packages/persistence/src/SqliteLiveImageStore.ts
    title: SQLite bounded reads and transaction outcomes
  - id: r2-store
    resource: ../../packages/persistence/src/R2LiveImageStore.ts
    title: R2 reads and ETag compare-and-swap
  - id: pg-store
    resource: ../../packages/persistence/src/PgLiveImageStore.ts
    title: Private PostgreSQL session and conservative conditional writes
  - id: pg-contract
    resource: ../../packages/persistence/test/PgLiveImageStore.test.ts
    title: PostgreSQL integration and protocol-boundary tests
  - id: pg-migration
    resource: ../../packages/persistence/migrations/postgresql/001_live_images.sql
    title: Explicit version-one PostgreSQL schema
  - id: pg-ci
    resource: ../../.github/workflows/pr-validation.yml
    title: PostgreSQL qualification job
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/182
    title: Persistence store helpers
generated: { by: claude-code, at: "2026-11-17T16:00:00+01:00" }
---

# Persistence store helpers

Follows the [public API decision](core/public-api-targets-services-and-errors.md "follows"), which made `VfsError` the single error family.

## Context

`CheckpointStore` built its `VfsError`s by hand with `operation` values that disagreed within one call: a missing checkpoint reported `load`, a rejected limit `CheckpointStore.make`, and a corrupt image core's `decodeSnapshot`. The R2 and SQLite live stores each copied the same failure constructors and digest, and each kept its ownership claim in `let` variables. The persistence tests still provided `Crypto` layers that `LiveVolume.open` no longer needs.

## Decisions

1. `CheckpointStore.save` encodes under its limits without decoding the result. `CheckpointStore.load` validates stored bytes on decode.
2. **One naming scheme for `operation`: `Module.entry`.** `CheckpointError` reports `CheckpointStore.save`, `CheckpointStore.load` or `CheckpointStore.migrate`. The store's `VfsError`s, including snapshot encode and decode failures, report `CheckpointStore.make`, `CheckpointStore.save` or `CheckpointStore.load`. The live stores report `SqliteLiveImageStore.layer` and `.loadOrCreate`, and `R2LiveImageStore.layer`, `.loadOrCreate` and `.fromS3`. A commit reports an outcome, not a failure, so it has no operation.
3. **Share live-image policy, retain storage mechanics.** The internal protocol owns generation and digest validation, SHA-256 verification, image-size admission, and generation advancement. All stores require a positive image limit no greater than `Number.MAX_SAFE_INTEGER`. Oversized initial input fails with `InvalidArgument` and field `maxImageBytes` before writing; an oversized stored image remains `CorruptStore`. Existing valid bytes take precedence over initial input. Store-support keeps entry-point failure constructors and digest acquisition. SQLite keeps bounded BLOB projection, schema/version checks, transactions and rollback classification. R2 keeps ETag conditions and transport decoding. Conditional writes distinguish confirmed success, definite rejection, conflict and uncertainty. Durability defaults explicitly to `memory-only`; forwarding R2's existing qualification does not qualify SQLite.
4. **One protocol-owned `Ref` holds initialization, generation, token and availability.** Initialization claims ownership atomically. Competing calls immediately fail with `Ownership` without reading storage, as do calls after successful initialization. Failures proven to leave storage unchanged release the claim. Every uncertain attempted write, including a failed SQLite `BEGIN`, permanently freezes the owner. A successful commit advances the generation and opaque token while retaining any freeze set by another in-flight commit. Frozen loads report `Storage`; frozen commits return `unknown` without writing. SQLite cleanup observes availability through a narrow internal effect, not a second ownership Ref. Commit calls remain concurrent.

   Cancellation remains Effect interruption. Reads and hashing before a write can be cancelled without freezing; initialization releases its claim. Once creation or commit storage work starts, interruption freezes the owner and requires reopening, even after confirmed SQLite rollback. After a confirmed write, the generation/token update completes before pending cancellation takes effect and preserves any freeze. Storage I/O stays interruptible relative to the caller; short state transitions and necessary SQLite rollback cleanup are protected. Cleanup completes before connection release.
5. **One reusable live-image contract suite runs against the adapters.** It covers bounds, corruption, recovery, ownership races, delayed acknowledgements, digest failures, and cancellation with deterministic barriers. SQLite transaction, exclusivity and crash tests and R2 transport mapping remain adapter-specific. Checkpoint tests share their setup. The dead `Crypto` layers are gone, each checkpoint suite shares one migrated database and takes a fresh one where a test alters the table, and both restart suites drive their workers through `ChildProcessSpawner`, checking the worker's exit code as well as its output.

6. **PostgreSQL v1 uses application-controlled ownership and one private session per open store.** Stop the old volume owner's entire scope before starting a replacement for the same database and key. Generation CAS fences stale writes but cannot retire cached reads. There is no lease or automatic takeover. URL, TLS and connection timeout are the only connection settings. A fresh session and its reserved connection execute independent autocommit statements outside application transactions. Success requires a completed query with exactly one matching generation receipt. A successful zero-row result is conflict. Every attempted-query failure, malformed receipt or interruption freezes the owner without automatic reconnect or replay.
7. **Provision PostgreSQL explicitly.** Applications run the versioned packaged migration before opening. Use the fixed `public.effect_vfs_live_images` table, its version marker, required columns and immediate primary key. Reject missing or incompatible schema without hidden DDL or repair. Runtime schema mutation, application triggers, rules, RLS, extra constraints and automatic schema selection are unsupported. Different keys share this table independently. The PostgreSQL driver is an optional peer with a matching pinned development dependency. Non-PostgreSQL consumers do not need that peer. The public module is `PgLiveImageStore`; the root barrel remains checkpoint-only.
8. **PostgreSQL v1 reports memory-only with no stronger-durability override.** Reopen, killed-writer recovery in a fresh process, cancellation, lost-response and real database tests qualify transaction and recovery behavior. They do not establish power-loss durability or qualify writable NFS. The explicit PostgreSQL command refuses an absent test URL and CI runs the service-backed suite separately from ordinary tests. D1 remains a follow-on investigation. The protocol proxy withholds ReadyForQuery after a real committed statement. It models server rejection and cancellation at controlled barriers. PostgreSQL's bigint column cannot contain fractional generations, and its serial private session cannot deliver another result while ReadyForQuery is withheld, so those two synthetic adapter cases remain covered by SQLite/R2 and protocol tests.

## Consequences

The service shapes, stored layouts, commit outcomes, entry-point operation names and shutdown order are unchanged. SQLite oversized initial input intentionally changes from `CorruptStore` to `InvalidArgument`. Failed BEGIN and cancelled writes require a new owner. This wider protocol supersedes the failure-and-digest-only boundary from #182 because independent ownership implementations had drifted. Sharing the checkpoint database exposed that the Bun SQLite driver drops a leading U+FEFF from bound names.
