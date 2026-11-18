---
type: Decision
title: Persistence store helpers
description: Names every persistence failure by its entry point, shares live-image validation and ownership policy behind SQLite, PostgreSQL, D1 and R2 storage operations, and defines initialization and cancellation recovery.
status: stable
tags: [persistence, errors, sqlite, postgres, d1, r2]
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
    resource: ../../packages/persistence/test/R2Store.test.ts
    title: Create-race and uncertain-initialization contracts
  - id: protocol-issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/238
    title: One live-image ownership protocol
  - id: sqlite-store
    resource: ../../packages/persistence/src/SqliteLiveImageStore.ts
    title: SQLite bounded reads and transaction outcomes
  - id: r2-store
    resource: ../../packages/persistence/src/R2Store.ts
    title: R2 client capability and ownership
  - resource: ../../packages/persistence/src/R2S3Transport.ts
    title: AWS SDK reads and ETag conditions
  - resource: ../../tools/checks/consumers.mjs
    title: Packed R2Store resolution without the AWS SDK
  - id: sql-image-key
    resource: ../../packages/persistence/src/internal/sqlLiveImageKey.ts
    title: Well-formed SQL image keys preserve UTF-8 identity
  - id: r2-contract
    resource: ../../packages/persistence/test/R2LiveImageStore.test.ts
    title: R2 SDK Promise and scoped owner handoff
  - id: pg-store
    resource: ../../packages/persistence/src/PgLiveImageStore.ts
    title: Private PostgreSQL session and conservative conditional writes
  - id: pg-contract
    resource: ../../packages/persistence/test/PgLiveImageStore.test.ts
    title: PostgreSQL integration and protocol-boundary tests
  - id: pg-migration
    resource: ../../packages/persistence/migrations/postgresql/001_live_images.sql
    title: Explicit version-one PostgreSQL schema
  - id: d1-store
    resource: ../../packages/persistence/src/D1LiveImageStore.ts
    title: Primary-binding D1 adapter and scoped statement drainage
  - id: d1-contract
    resource: ../../packages/persistence/test/D1LiveImageStore.test.ts
    title: Miniflare contracts and late-write handoff
  - id: d1-worker
    resource: ../../packages/persistence/test/fixtures/d1-worker.ts
    title: Local and hosted Worker qualification harness
  - id: d1-migration
    resource: ../../packages/persistence/migrations/d1/001_live_images.sql
    title: Explicit STRICT D1 schema and version row
  - id: pg-ci
    resource: ../../.github/workflows/pr-validation.yml
    title: PostgreSQL qualification job
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/182
    title: Persistence store helpers
generated: { by: codex/okf, at: "2026-11-17T21:24:50+01:00" }
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

6. **PostgreSQL v1 requires an application-supplied native PgClient.** Supply a fresh, dedicated single-connection client for each open store with `PgClient.layerFrom(PgClient.makeClient(...))`. Keep application queries, other stores, transactions, listeners and streams on different clients. Pools are outside the supported setup. This exclusivity is a caller obligation; a service tag cannot prove it. The store reserves one connection for its scope and executes directly through it, outside ambient application transaction routing. Stop both the old store and its dedicated client before building fresh replacements. Generation CAS fences stale writes but cannot retire cached reads. There is no lease or automatic takeover. Success requires a completed query with exactly one matching generation receipt. A successful zero-row result is conflict. Every attempted-query failure, malformed receipt or interruption freezes the owner without automatic reconnect or replay.
7. **Provision PostgreSQL explicitly and configure its supplied client.** Applications run the versioned packaged migration before opening. Use the fixed `public.effect_vfs_live_images` table, its version marker, required columns and immediate primary key. Reject missing or incompatible schema without hidden DDL or repair. Both the key column and its primary index must use deterministic collations. Keys contain 1 to 256 UTF-16 code units of well-formed Unicode without NUL; reject lone surrogates before reservation or store SQL. The client layer can already have connected before store admission. Native client startup failures remain in that layer's SQL error channel; reservation and store work retain VFS mapping. Require default PostgreSQL type decoding, no acquisition hooks and an advertised receive limit of at least `max(16 MiB, maxImageBytes + 90 bytes)`. Reject incompatible advertised limits and hooks with `InvalidArgument` before reservation. Do not mutate supplied client configuration after construction. Runtime schema mutation, application triggers, rules, RLS, extra constraints and automatic schema selection are unsupported. Different keys share the table independently, each through its dedicated client. The PostgreSQL driver is an optional peer with a matching pinned development dependency. Non-PostgreSQL consumers do not need that peer. The public module is `PgLiveImageStore`; the root barrel remains checkpoint-only.
8. **PostgreSQL v1 reports memory-only with no stronger-durability override.** Reopen, killed-writer recovery in a fresh process, cancellation, lost-response and real database tests qualify transaction and recovery behavior. They do not establish power-loss durability or qualify writable NFS. The explicit PostgreSQL command refuses an absent test URL and CI runs the service-backed suite separately from ordinary tests. The protocol proxy withholds ReadyForQuery after a real committed statement. It models server rejection and cancellation at controlled barriers. PostgreSQL's bigint column cannot contain fractional generations, and its serial private session cannot deliver another result while ReadyForQuery is withheld, so those two synthetic adapter cases remain covered by SQLite/R2 and protocol tests.

9. **D1 v1 requires an application-supplied native D1Client.** Validate the client's configured binding is a plain primary-serving D1Database before querying. Native driver configuration excludes D1DatabaseSession at the type boundary; the store rejects cast session bindings at runtime. Use raw response envelopes without query/result-name transforms. Single conditional statements replace generic transactions or reserve, which the pinned D1 driver does not support. Different keys may share a supplied client while each store retains its own owner scope. A fixed STRICT image table and separate version table are provisioned through explicit app-run migrations. Compare both tables with their published v1 declarations, admitting only whitespace, keyword-case and ordinary quoted-identifier spelling differences. Retain the column, required-value, version, binary primary-key collation, trigger and index checks. Added CHECK constraints, foreign keys and other non-published clauses fail startup without repair. Keys share PostgreSQL's well-formed, 1-to-256-code-unit, no-NUL admission. Lone surrogates fail before any database query; valid Unicode identities remain distinct through UTF-8 transport. Image limits are positive and at most 1 MiB, leaving metadata headroom below D1's complete-row limit. Read images through a bounded BLOB projection. Validate native numeric byte arrays and their lengths before converting to Uint8Array. Receipts require a successful response envelope and exactly one matching generation. Attempted errors or malformed responses are Unknown, without adapter replay.
10. **D1 ownership handoff drains pending statements.** Applications control one owner per database and key. Independent Worker isolates must not cache the same live volume. The adapter supplies no Durable Object hosting, routing or automatic takeover. D1 Promises may complete after caller interruption. Run queries uninterruptibly in fibers attached to the store scope, while callers wait interruptibly. The shared protocol freezes interrupted writes. Closing the entire old owner waits for its pending statements to settle before replacement. It can wait for an unresponsive binding. Do not destroy the borrowed database binding. Shared contracts account explicitly for writes that finish while a cancelled owner closes.
11. **D1 release qualification remains separate from local emulation.** The guarantee is memory-only, with no override and no writable NFS. Node-driven Miniflare/workerd contracts cover binary views, the 1 MiB cap, malformed data and receipts, lost replies, stale CAS, cancellation and drained handoff. The bundled qualification Worker checks primary metadata and images across fresh owners inside workerd. CI runs this through an explicit job, and ordinary Bun tests skip it. Hosted Cloudflare qualification is still required before release. The provided hosted harness uses disposable keys and cleans its rows. Worker CPU, memory, query budgets and the deployment's ownership lifecycle need workload qualification. Local tests do not establish hosted behavior or power-loss durability.

12. **Live-image layers require supplied clients and retain owner-local resources.** SQLite continues to require its dedicated SQL client, verified filename and platform services. R2 requires a service over its existing explicit `R2Client` capability; `Options.client` is removed and callers provide the service through native Layer composition. `fromS3` continues to borrow a supplied SDK client and closing the store does not destroy it. Supply each driver locally to its store before composing application layers, because PostgreSQL and D1 also publish the generic SQL service SQLite consumes. A store-layer instance is one memoized owner; separate owners need separate layer instances and scopes. Shared transport does not share protocol state or pending work scopes. Closing a PostgreSQL or SQLite store releases its reservation before the supplied client finalizes; it does not independently destroy a client whose scope remains open. Existing byte layouts, schema checks and commit outcomes remain unchanged.

13. **R2 ownership handoff drains local requests.** Run reads and conditional writes in the store scope. The caller may stop waiting while the transport continues, and the request owns its write bytes until it settles. Keep the store scope open for direct store use and for the lifetime of any volume using it. Closing the old owner waits for pending transport operations, including S3 response-body consumption, and does not close the borrowed SDK client. Scope closure establishes local drainage only. If a settled transport failure leaves remote completion uncertain, keep the key offline until provider or transport evidence rules out a later remote write and the authoritative image has been verified. A GET while that uncertainty remains cannot establish a safe replacement.

14. **R2 uses the store's image limit during S3 reads.** Prefer the optional `R2Client.readBounded` capability so the transport can release oversized bodies before fully materializing them. The S3 implementation rejects a reported length above the limit, then counts actual bytes when a body is read. A transport may have buffered some bytes before exposing them to the adapter. An oversized stored image still fails with `CorruptStore`. Legacy clients and direct calls to the unbounded S3 `read` method retain their previous transport behavior.

## Consequences

Existing service implementations remain compatible. Stored layouts, commit outcomes, entry-point operation names and shutdown order are unchanged. SQLite oversized initial input intentionally changes from `CorruptStore` to `InvalidArgument`. Failed BEGIN and cancelled writes require a new owner. This wider protocol supersedes the failure-and-digest-only boundary from #182 because independent ownership implementations had drifted. Sharing the checkpoint database exposed that the Bun SQLite driver drops a leading U+FEFF from bound names.

## R2 transport import boundaries

Use `R2Store` for the SDK-independent store and `R2S3Transport` to adapt a supplied S3 client. The original
`R2LiveImageStore` entrypoint re-exports the same bindings. Keep the existing service key and operation names
so both import paths interoperate and preserve failure handling. The AWS SDK remains a package dependency.

The packed consumer extracts the actual persistence and core archives with the Effect peer, omitting the SDK
and ambient Node types. It imports `R2Store` on Node and checks the declarations on the supported TypeScript
versions. A manifest-driven package manager still installs the SDK, including for consumers using only other
persistence subpaths.

On the #394 merge baseline with this split applied, Node 26.12.0 module tracing recorded 12 distinct AWS or
Smithy package names while importing `R2LiveImageStore`, and zero for `R2Store`. Bun 1.4.4 browser builds that
exported only `Client` and `layer` produced 5,082 bytes for each route after minification, or 1,948 bytes with
gzip. Both builds externalized Effect and core. Bun already removed the unused S3 adapter from the legacy
bundle in this probe. These results justify an independent runtime and declaration boundary. Installed
dependencies remain the same, and optional-peer migration needs a separate compatibility decision.
