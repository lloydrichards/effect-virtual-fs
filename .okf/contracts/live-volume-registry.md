---
type: Contract
title: Shared live-volume registry
description: Defines keyed scoped ownership of live volumes and their stores, idle retention, capacity failures, and canonical identity requirements.
status: stable
tags: [resources, lifetimes, persistence, effect]
sources:
  - id: api
    resource: ../../packages/core/src/LiveVolume.ts
    title: Registry contracts and RcMap construction
  - id: tests
    resource: ../../packages/core/test/LiveVolumeRegistry.test.ts
    title: Registry sharing, failures, scope cleanup and handle isolation
  - id: sqlite
    resource: ../../packages/persistence/test/SqliteLiveImageStore.test.ts
    title: Registry SQLite ownership release and committed-content reopen
generated: { by: codex/okf, at: "2026-10-04T17:12:00Z" }
---

# Shared live-volume registry

`LiveVolume.makeRegistry` creates an explicit `get(key)` capability backed by Effect `RcMap`. The first borrower acquires a store Layer and opens its live volume. Concurrent borrowers of equal keys share that acquisition and volume. Each acquisition builds its store Layer with fresh memoization, so an inherited Layer memo cannot share mutable store ownership between entries or retain a retired store. Volume configuration is captured when the registry is created and applies to every key.

Each `get` retains the volume until its borrowing scope closes. Keep that scope alive until the caller and its handles finish using the volume. The registry owner must outlive borrowers; closing it shuts down even borrowed volumes. Volume shutdown precedes store release. Reopening an equal key waits for both to finish, even after immediate release or idle expiry removes the old RcMap entry. Cancelling that wait does not release the previous owner. Different keys can acquire independently. Independent callers and handles retain their own authority, cursor, and close state under the [resource contract](resources-and-authority.md "constrained by").

Without an idle timeout, the last borrower closes the entry immediately. A configured timeout retains unused entries for reuse, including their decoded state and storage locks. This avoids rebuilding storage and decoding images for intermittent consumers. It does not improve operations on a volume that its application already keeps open.

Capacity is an optional positive integer entry limit; omission is unlimited. Acquiring a missing key at capacity fails with native `Cause.ExceededCapacityError`. Active, acquiring, idle, and retained failed entries occupy capacity. An existing key can still be borrowed at capacity. The registry does not evict idle entries to admit another key. Invalid capacity or duration input fails with `InvalidArgument` at `LiveVolume.makeRegistry` before storage acquisition. Acquisition failures are shared until the entry's borrowing scopes and idle retention finish.

Keys follow Effect equality and must identify canonical backing-store locations. Different aliases, multiple registries, or independent processes can create competing owners. Canonicalization and external ownership coordination belong to the application. The registry exposes no invalidation operation because replacing an entry with live borrowers could violate exclusive store ownership.

Reference counting tracks consumers of a complete live volume. It does not replace inode link counts, transactionally staged open counts, opaque object references, or NFS protocol leases. Existing inode reclamation still requires no names and no open handles. Backend workload and retention policy must be qualified for the intended consumer; local in-memory timings establish no disk or network performance guarantee.
