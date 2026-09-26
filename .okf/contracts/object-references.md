---
type: Contract
title: Object references independent of paths
description: Defines opaque volume-local object identity, caller-authorized reference operations, and deletion lifetime.
status: stable
tags: [identity, references, authority]
sources:
  - id: core
    resource: ../../packages/core/src/VirtualFileSystem.ts
    title: Runtime node identity and public capabilities
  - id: file-tests
    resource: ../../packages/core/test/ObjectReference.test.ts
    title: Object-reference identity, authority, and lifetime tests
  - id: link-tests
    resource: ../../packages/core/test/Links.test.ts
    title: Hard-link and rename behavior
  - id: mutation-tests
    resource: ../../packages/core/test/ReferenceMutation.test.ts
    title: Reference mutation identity, authority, and lifetime tests
  - id: create-tests
    resource: ../../packages/core/test/ReferenceCreate.test.ts
    title: Conditional child creation and initial metadata tests
  - id: key-tests
    resource: ../../packages/core/test/ReferenceKey.test.ts
    title: Reference key round trip, lifetime, refusals, forks, and live reopen
generated: { by: claude-code, at: "2026-09-26T12:30:00+02:00" }
---

# Object references independent of paths

Core exposes canonical opaque `ObjectReference` values for runtime files, directories, and symbolic links. Hard-link aliases and renamed paths return the same reference; replacing a reused path returns a different reference.[^link-tests] References are local to one live volume and are excluded from snapshot version 1.[^core][^file-tests] A [reference key](#reference-keys) is the durable name core provides for a reference.

`Caller` owns reference operations for the volume root, single-component byte-name lookup, directory parent lookup, permission checks, metadata and directory observation, symbolic-link reads, named-entry mutations, exact-object metadata and truncation, writable file opening, and atomic child lookup-or-create-and-open. The byte layout of an export identifier remains an adapter responsibility; the identity it encodes is core's reference key.[^mutation-tests]

The reference identifies an object; it does not carry the authority of the caller that obtained it. Permission checks apply to the invoking caller. Operations preserve the [resource and authority contract](resources-and-authority.md "constrained by"). Restore constructs fresh references under [snapshot-local identity](../decisions/core/snapshot-local-file-identity.md "constrained by").

`openChildReference` accepts `initialSize`, ownership, mode, and timestamps in the same creation operation. Those initial attributes are ignored when opening an existing file. `exactMode` preserves an explicit mode without applying the caller's umask, subject to core permission policy. Its optional `expectedChild` condition requires either an absent direct entry or the same observed object, revision, and timestamps under the volume gate. A mismatch fails with `StaleReference` before any creation or truncation. The condition checks the direct entry before optional symbolic-link traversal; adapters that require the observed file itself disable traversal.[^create-tests]

## Authority

Each operation requires on the referenced object exactly the mode bits its path-based equivalent requires on the resolved node. `accessReference` checks requested mode bits for the invoking caller without opening the object, including the execute-bit rule used by path-based `access`. `lookupReference` and `parentReference` require execute on the directory, matching traversal of a component and of `..`; `observeDirectory` requires read, matching `readDirectory`; opening requires its requested access; namespace mutations require write and execute on each affected parent. A reference identifies an exact object, so metadata changes and hard linking do not carry path-only symlink-following options.[^mutation-tests][^file-tests]

`observeMetadata` and `readLinkReference` require nothing on the object. POSIX `stat` and `readlink` need search permission along the path prefix but no permission on the object itself, and the path-based `stat`, `lstat`, and `readLink` behave the same way. A reference is reachable only through `rootReference` and the two traversal operations, so the prefix was authorized when the reference was obtained. Unreadable metadata would make a mode `0o000` entry invisible to `ls -l` in a readable directory.[^authority-tests]

## Lifetime and failure

Forged values fail with `InvalidReference`; a valid reference presented to another volume fails with `ForeignReference`; and a deleted object whose reference lifetime has ended fails with `StaleReference`. A removed directory stales immediately. A moved directory follows its current parent, and the root is its own parent.

A regular file's reference remains observable after final unlink only while a file handle that was already open retains it. The existing handle can finish reading or writing, but the reference cannot open another handle or resurrect the file through `linkReference`. Final handle close reclaims content and stales the reference. This avoids allowing an externally held reference to retain deleted content indefinitely.[^file-tests][^mutation-tests]

## Reference keys

`volume.referenceKey(reference)` returns a `ReferenceKey` of the volume identity, the epoch of its inode numbers, the object's inode number, and a tag of HMAC-SHA-256 over the other three under a secret only the volume holds; `volume.resolveReferenceKey(key)` returns the same interned reference traversal returns. The `ReferenceKey` schema carries the identity, epoch and tag as base64 and the inode number as a decimal string. Every construction draws a new epoch and secret except a live reopen, which resumes the stored ones, so a key survives a restart of a live volume and never resolves in a restore, fixture, or overlay, even under the same identity. Keys fail with the reference codes: `InvalidReference` for a malformed key, a key whose tag the volume did not compute, or a forged reference, `ForeignReference` for another identity or epoch, and `StaleReference` under the lifetime rules below. Resolution lives on `Volume`, not `Caller`, and checks no permission: inode numbers are guessable, so a caller-level resolve would skip the prefix authorization traversal proves. The tag keeps a holder of one key, such as an NFS client, from writing a key for an object no key was issued for. The [reference keys decision](../decisions/core/reference-keys.md "specified by") records the choices.[^key-tests]

## Acceptance evidence

Focused tests demonstrate rename followed by path reuse, hard-link identity, owned symbolic-link bytes, moved and removed directory parents, distinct reference failures, caller authority, unchecked metadata and link-target reads, and open-unlinked lifetime.[^file-tests]

[^core]: Inspect `Metadata`, `Caller`, `FileHandle`, `DirectoryHandle`, internal Node records and rename in the current implementation.

[^file-tests]: `ObjectReference.test.ts` exercises the public reference interface and deletion lifetime.

[^authority-tests]: `ObjectReference.test.ts` checks a non-privileged caller against a mode `0o000` file and symbolic link: metadata and link-target reads succeed where opening fails.

[^link-tests]: The link tests ground alias and rename behavior; `ObjectReference.test.ts` covers the reference interface itself.

[^mutation-tests]: `ReferenceMutation.test.ts` checks named-entry mutation results, permissions, and retained object identity.

[^key-tests]: `ReferenceKey.test.ts` checks the schema round trip, alias and rename stability, lifetime, the three refusals, keys forged by inode number or tag, restores, fixtures and overlays under the same identity, resolution after a live reopen, and two opens of one image.

[^create-tests]: `ReferenceCreate.test.ts` checks missing and replaced children, timestamp changes, initial ownership, capacity rejection, and existing-file attribute preservation.
