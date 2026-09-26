---
type: Decision
title: Reference keys
description: Gives every object a serialisable key of volume identity, inode-number epoch, inode number and an HMAC tag under a per-volume secret, resolved on the volume, and builds persistent, unguessable NFS filehandles from it.
status: stable
tags: [identity, references, nfs, durability, live-image]
sources:
  - id: schema
    resource: ../../../packages/core/src/Volume.ts
    title: ReferenceKey schema
  - id: engine
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: The epoch and key-secret draws, the key tag, addressable, referenceKey and resolveReferenceKey
  - id: hmac
    resource: ../../../packages/core/src/internal/hmac.ts
    title: Synchronous HMAC-SHA-256 and the tag comparison
  - id: live-image
    resource: ../../../packages/core/src/internal/tree.ts
    title: The live runtime block's epoch and key secret
  - id: tests
    resource: ../../../packages/core/test/ReferenceKey.test.ts
    title: Round trip, aliases, lifetime, refusals, forged keys, restores and overlays, live reopen, two opens of one image
  - id: export
    resource: ../../../packages/nfs/src/internal/export.ts
    title: Key-encoded filehandles and their failures
  - id: nfs-tests
    resource: ../../../packages/nfs/test/Filehandles.test.ts
    title: Handle layout, restart over a durable volume, STALE and FHEXPIRED, forged handles, PUTFH's status list
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/201
    title: Serialisable reference key for NFS filehandles
generated: { by: claude-code, at: "2026-09-26T14:00:00+02:00" }
---

# Reference keys

Extends [object references](../../contracts/object-references.md "extends") with a durable name, and amends the [public API decision](public-api-targets-services-and-errors.md "amends"), which had declined a serialisable reference key for 0.6.0, and builds on [snapshot-local file identity](snapshot-local-file-identity.md "constrained by") and the [volume durability facts](volume-durability-and-usage-facts.md "depends on"). The decisions were grilled on 2026-09-25 and recorded on [issue #201](https://github.com/lloydrichards/effect-virtual-fs/issues/201 "decided on"); decisions 5 to 8 settle what the issue left to implementation. The adversarial review of 2026-09-26 found that a client could forge a handle by changing its inode number; the owner's review decision R1 added the tag (decisions 1, 3, 4 and 9) and the review settled the PUTFH statuses (decision 7). A second review found the secret followed a seedable `Random`, and that the expire type had been written into `unique_handles` (attribute 9) while `fh_expire_type` (attribute 2) stayed 0x3 for every export; decision P3 moved the secret to the platform's secure generator (decisions 1, 5 and 9), and attribute 2 now carries decision 8's value.

## Context

An `ObjectReference` is an in-process token, so an adapter that must name an object outside the process kept its own table. The NFS export mapped a per-process serial to each reference in a `Map` and a `WeakMap`, swept the table with `stat` when `maxFilehandles` filled, and paid one `stat` per PUTFH to detect a stale handle. Its handles embedded `volume.incarnation`, so every handle answered `FHEXPIRED` after a restart, even over a durable volume. `{ identity, ino }` alone cannot replace the table: `fromSnapshot`, `makeOverlay` and fixtures accept an explicit identity and keep or assign inode numbers of their own, so one pair could name a different object in a fork.

## Decisions

1. **Key shape.** `ReferenceKey = { identity, epoch, ino, tag }`. `epoch` is 128 random bits drawn like the identity, from `Crypto` when present and `Random` otherwise. It is drawn whenever inode numbers start a namespace of their own and kept in the live image's runtime block, so a live reopen resumes it. A counter was rejected because it can repeat across forks of one identity. `tag` is the first 16 bytes of HMAC-SHA-256 over `identity | epoch | ino` (the inode number as 64 bits big-endian) under a 128-bit key secret, drawn with the epoch from `globalThis.crypto.getRandomValues` and stored beside it in the runtime block.
2. **A schema with bytes as base64.** `ReferenceKey` is a public schema in `Volume`, re-exported from `VirtualFileSystem`. `identity`, `epoch` and `tag` are 16 bytes each, carried as base64 like every other byte field; `identity` holds the bytes of the hexadecimal `VolumeIdentity`. `ino` is a bigint between 1 and the largest inode a value may hold, carried as a decimal string, the type `Metadata.ino` reports. Turning a key into bytes of a fixed layout stays the adapter's job.
3. **Resolution is on the volume, and a key cannot be guessed.** `volume.referenceKey(reference)` and `volume.resolveReferenceKey(key)` are coordinated reads. Inode numbers are small and sequential, so a caller-level resolve would bypass the search permission the object-references contract relies on; a volume holder can already mint privileged callers. An adapter hands keys to parties that are not volume holders, such as NFS clients, so the tag keeps a holder of one key from writing another: without the secret, changing the inode number of a root handle no longer names `/secret/f` below a directory the client may not search. A key reaches only an object some key was issued for, the way the NFS registry this replaces only resolved handles it had issued. The resolved value is the interned token traversal returns, so identity comparisons keep working.
4. **NFS filehandles.** A handle is `version | identity | epoch | ino | tag`, 1 + 16 + 16 + 8 + 16 = 57 bytes, within NFS4_FHSIZE (128), at version 2. The registry, its serial, the full-registry sweep, the PUTFH `stat` probe and `NfsServerLimits.maxFilehandles` are removed. `fh_expire_type` is `FH4_PERSISTENT` on durable volumes.
5. **Every construction but a live reopen draws an epoch, overlays included.** An overlay starts from its base's inode numbers and may share its identity, and it is a different volume: its objects diverge from the base's from the first write. Identity alone does not separate them, since the identity may be supplied, so the overlay draws its own epoch and a base's key never resolves in it. The rule is uniform: `make`, `fromSnapshot`, `fromFixture` and `makeOverlay` draw one, and only `LiveVolume.open` resumes a stored one. The epoch is drawn from `Random` after the incarnation, so a construction's own identity and incarnation pins keep their order, and a later construction's draws come one value later; the key secret takes nothing from `Random`.
6. **Another epoch is `ForeignReference`.** A key whose identity matches but whose epoch does not was minted by a different inode namespace, which is another volume in every sense core uses: the other volume's `ObjectReference` values are foreign here too. `StaleReference` is kept for a key of this epoch whose object is gone, including a removed directory and a file only a handle held across a reopen; an unlinked file stays resolvable while a handle holds it, as its reference does. A value that fails the schema, such as a zero inode or a 15-byte epoch, is `InvalidReference`, and so is a key of this epoch whose tag the volume did not compute. The tag is compared in constant time before the inode is looked up, so a guessed key cannot tell a used inode number from a free one.
7. **NFS maps core's codes, within PUTFH's error list.** A wrong length or version and `InvalidReference`, a forged tag included, answer `BADHANDLE`. `ForeignReference` answers `FHEXPIRED` while handles are volatile, and `STALE` when they are persistent: expiry belongs to volatile handles (RFC 8881 Section 4.2.3), and a persistent handle that names nothing is stale (Section 4.2.2). Every other code goes through the shared [error mapping](../nfs/error-mapping.md "uses"), kept only when RFC 8881 Section 15.2 lists the status for PUTFH and `SERVERFAULT` otherwise: `StaleReference` answers `STALE`, `VolumeBusy` `DELAY`, and `VolumeUnavailable`, a storage failure or a code a newer core adds `SERVERFAULT`, since PUTFH's list has no `IO`. GETFH and the `filehandle` attribute mint the handle from the key too, so a removed object answers `STALE` where the registry used to return its old handle, and they report core's code instead of `SERVERFAULT`.
8. **Durable means at least `survives-process-crash`.** Handles are declared persistent when the volume's committed state survives a process crash. Memory volumes send `FH4_VOLATILE_ANY | FH4_NOEXPIRE_WITH_OPEN` (0x3), since RFC 8881 Section 4.2.3 allows `FH4_NOEXPIRE_WITH_OPEN` only with `FH4_VOLATILE_ANY`, and their handles expire across a restart because the new volume has a new identity or epoch.
9. **An HMAC in core, not a per-inode tag.** The tag is keyed on a per-volume secret rather than a random value stored with each inode, so it needs no change to nodes, snapshots or the allocator, and a restore's new secret invalidates every older key at once. Effect's `Crypto` service offers no HMAC and would put a service requirement and a `PlatformError` on the key methods, so core computes HMAC-SHA-256 synchronously in a small internal module pinned by RFC 4231's vectors; the secret alone is drawn from `globalThis.crypto.getRandomValues` inside `Effect.sync`, and a runtime without it dies with a defect. Every key carries the identity and epoch, so a secret drawn from a seeded `Random` could be rebuilt from one key and would forge the rest; Web Crypto is global in every supported runtime, so this adds no service requirement, and the secret is never observable, so tests lose nothing by not seeding it. Identity, incarnation and epoch keep the `Crypto`-or-`Random` path, so seeded identity tests still pin them.

## Consequences

- An NFS client over a durable volume keeps its handles across a gateway restart. Sessions, opens and locks are still volatile, so the `stateful` profile still needs grace and reclaim.
- Removing `maxFilehandles` is breaking for `NfsServerLimits`, its presets and overrides; the `DELAY` answers a full registry produced are gone.
- Stored live images without an epoch and key secret no longer open. The live image has no second decoder, so they must be regenerated, as 0.6.0 already requires.
- Rolling a live store back to an older image can reuse an inode number for a different object under the same epoch. The key cannot detect this.
- Two live volumes opened from one image, such as a copied store or a second open of the same bytes, share its identity, epoch and secret, so a key minted in one resolves to whatever holds that inode in the other. A live image has one writer, and a copied store must not be served under persistent handles beside the original. Detecting it would need the epoch redrawn and committed whenever a writer takes an image, behind a store-level fence.
- The secret sits in the live image, so anyone who can read the store can mint keys; that party can already read every object.
- The export now takes its capacity attributes from the volume it resolves handles on, so the two cannot come from different volumes.
- A key resolves in constant time, one HMAC and one table lookup under one read permit, instead of a registry lookup plus `stat`.
