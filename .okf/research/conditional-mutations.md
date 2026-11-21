---
type: Research
title: Conditional whole-file writes
description: Compares guards for read-edit-write consumers and proposes one atomic whole-file replacement.
status: draft
tags: [core, revisions, concurrency, writes]
sources:
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/31#issuecomment-5811239401
    title: Alchemy editFile consumer and atomicity gap
  - resource: agent-filesystem-landscape.md
    title: Evidence for the read-edit-write consumer
  - resource: ../contracts/mutation-revisions.md
    title: Runtime revision advancement and lifetime
  - resource: ../contracts/object-references.md
    title: Object identity, authorization, and retirement
  - resource: ../contracts/mutation-and-observation.md
    title: Coordinated mutation and durable publication
  - resource: ../../packages/core/src/internal/runtime.ts
    title: Core caller adapters and current guards
  - resource: ../../packages/effect-preview/src/virtual-file-system/internal/atomic.ts
    title: Engine observed read and guarded whole-file staging
  - resource: ../../packages/nfs/src/internal/nfs4.ts
    title: Existing NFS guarded metadata handling
---

# Conditional whole-file writes

Alchemy's `editFile` reads current bytes, checks the expected digest and computes the replacement before calling
`writeFile`. Another writer can commit between those calls. The existing metadata and child-open guards cannot
make the resulting replacement conditional. Alchemy is a concrete example of the gap. A downstream integration
owner and a decision to adopt the interface are still needed before implementation.

The first candidate is a coordinated whole-file read that returns bytes with an object observation, paired with
a guard on whole-file replacement. The proposal uses the existing
[mutation revisions](../contracts/mutation-revisions.md "depends on"). Keep namespace guards, generic transactions, digest guards and protocol
changes outside this candidate.

## Guard choice

| Option                                | What it checks                                                       | Consequence                                                                                                                                                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime object reference and revision | The same resolved file at the same committed object revision         | Uses existing observations and rejects even a same-size write or permission change. Aliases may share the guard.                                                                                                                                         |
| Content digest                        | Equality of bytes at the moment of the mutation                      | Fits Alchemy's existing tool token and can survive image transfer. A byte-only digest cannot distinguish an unlink and recreate with identical bytes. Adding object identity or a digest computed under the appropriate gate requires a separate policy. |
| Parent entry binding and revision     | The same direct name binding, optionally including its file revision | Useful for entry replacement and conditional remove. Renames and rebinding have different semantics from editing a file through an alias. No named consumer currently requires this wider contract.                                                      |

Avoid a read followed by a separate metadata call. Either can race with an unguarded writer. A guarded
`open({ truncate: true })` followed by a handle write can already publish truncation before the replacement
arrives. Keeping a handle open pins the object but does not serialize its other writers.

## Proposed caller interface

Add a coordinated `readFileObserved` that returns owned bytes, the canonical `ObjectReference`, and the public
bigint revision of that same file. Keep `readFile` returning bytes. Let `WriteFileOptions.expected` accept the
reference and revision together. This shape makes the expected identity explicit and follows the naming of
`SetattrOptions.expected`. A first implementation can restrict the guard to replacing existing regular-file
contents with `truncate: true`. Reject guard combinations that create, append or replace the final symlink
as `InvalidArgument` before staging. The ordinary unguarded call forms retain their current behavior.

```ts
// Proposed interface, not a compiled API example.
const replace = Effect.gen(function*() {
  const { bytes, reference, revision } = yield* caller.readFileObserved("/notes.txt")
  const edited = applyEdit(bytes)
  yield* caller.writeFile("/notes.txt", edited, {
    access: "write",
    truncate: true,
    expected: { reference, revision }
  })
})
```

Compare the file the requested entry actually resolves to. Honor the caller's existing confinement, traversal,
symlink and write-authority rules. A guard grants no authority and does not bypass lookup or access failures.
For an authorized operation, return `StaleReference` with `field: "expected"` when the observed file disappeared,
resolved to a different file, or advanced its revision. Preserve `InvalidReference` for a forged reference and
`ForeignReference` for one issued by another volume. Match the existing guarded `setattr` mismatch convention
rather than adding an `FsCode` or making stale observations indistinguishable from admission pressure
(`VolumeBusy`).

A hard-link alias can accept the observation while the object and revision match. A change via any alias stales
observations of that object. A committed rename advances the moved object's revision today, so even a write to
the new path with an older observation fails. Unlink and recreate fails on identity even if bytes, times or
revision values coincide. A file retained only by an open handle cannot be reached by this path-based operation.
Existing handles keep their current lifetime and write authority. A guard can survive an ordinary read that
refreshes relatime because that refresh does not advance the revision.

Use the opaque runtime reference for volume locality. Restore, fixture construction, overlay creation and live
reopen all require a fresh observation. Durable images may retain revision information and authenticated
reference keys may survive live reopen. A supported caller keeps the reference and revision from one observation
and discards them together. The structural pair cannot detect a caller substituting a newly resolved reference
for an old one when the revision coincides. If the consumer needs to enforce that provenance, return an opaque
observation token issued by the live volume. Portable guarded edits need a separate identity policy.

## Coordination and publication

Core already runs whole-file reads and writes through its coordinated caller operation. The pinned preview's
`readFileObserved` returns copied bytes and their object observation from one operation, including the existing
atime behavior. Its whole-file writer accepts an engine `expectedRevision` and checks it before staging content
or mode changes. Core would translate the public observation to the preview revision only after verifying
identity and revision in the admitted write. The revision and identity check and the guarded engine write must
share the same gate hold. Reuse the core path resolution and authorization path so the compared object is the one
the engine will write. Keep unguarded callers, including synchronous adapters, on the existing coordinator.
No two public calls should be composed to implement this guarantee.

Preview condition failures are currently mapped generically to `VolumeBusy`. Map only a guarded write's
object-revision condition failure to the proposed `StaleReference` with field `expected`. A guard mismatch
offers no changed candidate to storage and publishes no bytes, metadata, namespace change, revision or watch event.
A passing guard permits the existing staging and durable commit protocol. It does not eliminate storage
rejection, unknown commit outcomes, or shutdown failures.

After a stale-observation error, read again and reapply the edit to the fresh bytes. Do not resubmit replacement
bytes calculated from the old read. After uncertain publication, follow the volume's recovery contract before
attempting another write. NFS has operation-specific handling already. Its guarded `SETATTR` re-observes with a
bounded retry and returns `DELAY` if it runs out, and its guarded child open has separate handling. This proposal
does not expose a new NFS operation or change those mappings.

## Qualification before adoption

- Prove the returned bytes and reference/revision match one observation while a writer is admitted concurrently.
- Race two replacements that each change the bytes using one observation. Exactly one succeeds. Inspect bytes, mode,
  identity, revision, events and commit offers after the rejection.
- Check same-size writes under fixed and backward clocks, rename, hard-link writes from an alias, unlink/recreate
  with identical bytes, a final symlink retarget, and an unlinked file retained by an existing handle.
- Check permissions and confinement independently of the guard. Cover forged and foreign references, restore,
  overlay, live reopen and no-op and cancellation paths.
- Exercise durable rejection and unknown outcomes independently of guard mismatch. Keep existing `setattr`,
  child-open and adapter behavior covered.

Review this proposal with the consumer before changing the stable revision or reference contracts.
