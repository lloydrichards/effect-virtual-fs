# Named checkpoint persistence

Status: accepted and implemented, 9 September 2026. The user authorized the first
checkpoint milestone from [issue #10](https://github.com/lloydrichards/effect-virtual-fs/issues/10).
Snapshot comparison in [issue #9](https://github.com/lloydrichards/effect-virtual-fs/issues/9) remains separate work.

## Decision

Add `@effect-vfs/persistence` as a separate package that depends on core. Core remains independent of storage I/O.
The first implementation uses SQLite through Effect's SQL client, with Bun SQLite as the first runtime proof.
The application supplies the SQLite `SqlClient` layer and database location. The persistence package provides
its migration separately so applications control when schema changes run.

The public operations accept and return opaque core snapshots:

- `save(name, snapshot)` creates a checkpoint. An existing name fails with typed `AlreadyExists` and retains the
  saved checkpoint. There is no replacement operation.
- `load(name)` returns a `Snapshot`. A missing name fails with typed `NotFound`.

SQLite stores the existing encoded snapshot bytes. The package owns encoding on save and decoding on load;
it does not expose the internal snapshot graph or add fields to snapshot format version 1. Snapshot-local identity
and byte ownership continue to follow decisions [0005](0005-snapshot-local-identity.md) and
[0012](0012-copying-byte-ownership.md).

Checkpoint names are opaque, nonempty strings of at most 255 UTF-8 bytes and cannot contain NUL or lone UTF-16
surrogates. They are not filesystem paths. The byte limit applies to the encoded name, not its JavaScript string
length. Preserve leading BOM characters and do not normalize Unicode.

Construction requires explicit core `DecodeLimits`. Validate and copy these limits during construction so later
mutation of the caller's configuration cannot change the store's policy. Saving must enforce the same limits as
loading. A store must not successfully save a snapshot that its configured decoder would reject.
Snapshot encoding, validation and decoding failures remain typed errors. Database failures must remain
distinguishable from missing names and duplicate names.

## Commit and lifetime semantics

A checkpoint captures the supplied snapshot. Later writes to the original volume require another explicit capture
and save under a new name. Loading does not replace a live volume; callers use `VirtualFileSystem.fromSnapshot`
to create a fresh volume and choose its destination limits.

Create-only behavior must hold under concurrent saves. Enforce name uniqueness in SQLite rather than using an
unchecked read followed by an insert. A failed competing insert must not overwrite the winning checkpoint.

A database commit can happen before the caller receives completion or observes interruption. Interruption does
not establish that no checkpoint was created. A retry under the same name can therefore return `AlreadyExists`.
This milestone proves explicit checkpoints across process restarts. It does not promise persistence of every live
filesystem write or power-loss durability independent of the application's SQLite configuration.

## Example

An agent captures `yield* volume.snapshot` and saves it as `run-42`. Another process opens the same database,
loads `run-42`, and restores an independent volume with `VirtualFileSystem.fromSnapshot`. Saving another snapshot
as `run-42` fails with `AlreadyExists`; the first checkpoint remains available.

## Scope and required evidence

The first milestone excludes checkpoint history, replacement, listing, deletion, revisions, compare-and-swap,
automatic saving, snapshot changes and additional storage backends.

Acceptance checks exercised by the implementation:

- A writer process saves and exits; a separate reader process opens the database and restores the checkpoint.
- Restored bytes, metadata, byte paths, symlink targets and hard-link relationships match the captured state.
- Missing names and duplicate saves return their specified errors. Concurrent creation preserves one checkpoint.
- Invalid names and invalid construction limits fail; later configuration mutation does not change limits.
- Save and load enforce the same limits. Invalid stored images return typed decoding errors.
- Migration is explicit and can be run again without losing checkpoints.
- Independent restores and subsequent source-volume edits cannot change saved state.

The separate-process test exercises the built persistence package exports.
