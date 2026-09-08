# @effect-vfs/core

Private, experimental VirtualFileSystem core. This first slice implements volumes, callers, byte paths,
directory creation/lookup, rename/removal, permissions, metadata, scoped directory resources, and optional Effect service provision.
It also implements regular-file I/O and unlink. Links and byte-preserving enumeration are implemented. Snapshots and the memory adapter binding remain later slices.

## Usage

```ts
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const volume = yield* Vfs.make({ maxEntries: 100 })
  const root = yield* volume.caller()
  yield* root.mkdir("/project")
  const project = yield* root.withDirectory("/project")
  yield* project.mkdir("src")
  const directory = yield* project.openDirectory("src")
  const metadata = yield* directory.stat()
  yield* directory.close()
  return metadata
}))
```

Every execution of `make` creates an independent volume. Callers from the same volume share its namespace but retain
separate credentials, masks, and cwd identities. Root callers need no Scope and have no close method. Derived callers
and directory handles use the acquiring scope; closing a parent caller does not close independently scoped children
or handles. Explicit double-close fails; scope cleanup tolerates an earlier explicit close.

Use `Vfs.CurrentFileSystem` with `Effect.provideService` or `Layer.succeed` to provide an existing caller. `Layer.effect`
can acquire a derived caller and own its scope. The service adds no separate filesystem state.

## Supported operations

- `Vfs.make`, `volume.caller`, `Vfs.pathFromBytes`, and `Vfs.pathToBytes`.
- `caller.stat`, exclusive nonrecursive `caller.mkdir`, `caller.withDirectory`, and `caller.openDirectory`.
- `caller.rename` and empty-directory-only `caller.rmdir`.
- `directory.stat` and `directory.close`.

Other operations are absent rather than returning placeholder successes. Metadata describes directories and regular files. The package emits JavaScript and declarations but remains private; the complete POSIX profile is unfinished.

## Contracts

Root starts at uid/gid 0 with mode 0755. Default callers are explicitly privileged, with uid/gid 0, no supplementary
groups, and umask 0022. User ID zero alone grants no privilege. Creation uses caller uid, parent gid, and requested
mode 0777 masked by umask. Sticky creation is supported; creation set-ID bits are ignored. Directory handles grant
identity, not the opener's privilege.

String paths use strict UTF-8 input; lone surrogates, NUL, and empty input fail. Byte paths preserve non-UTF-8 names.
Constructors copy byte inputs at execution and exports return independent buffers. Shared-memory-backed and detached
views are rejected. Slash is the separator on every runtime; no case folding, Unicode normalization, or host-path
expansion occurs. Dot components resolve against directory identity and root dot-dot stays at root.

Absolute paths ignore a supplied directory base. Relative paths require a live same-volume base and use the invoking
caller's permissions. Directory bases are not restricted roots.

Rename accepts independent `sourceRelativeTo` and `destinationRelativeTo` directory bases. It preserves cwd and
handle identity, including the new parent used by `..`. Replacing an empty directory retains its open handles,
whose metadata reports zero links. Removed directories reject relative lookup and creation with `NotFound`;
retained callers can still use absolute paths. Root and final dot/dot-dot mutations fail with `InvalidArgument`.
Nonempty directory removal or replacement fails with `NotEmpty`. A trailing slash on a rename destination
requires an existing directory. Same-entry rename succeeds without changing metadata or consuming quota.

Both rename parents require write/search permission. Sticky directories additionally require the invoking caller
to own the parent or affected entry, or have explicit privilege. Destination replacement checks that entry too.
No additional write permission on the moved directory itself is required. Successful rename/removal publishes
parent link counts and timestamps together. Expected failures preserve both paths and their metadata.

`maxEntries` excludes root and implicit dot entries. Zero allows root but no new names. `maxPathBytes` counts input
bytes including separators, before normalization. Both limits have no configured cap when omitted. A provisional
255-byte component bound is enforced. These are logical limits, not heap or CPU guarantees. Symlink expansion and
traversal limits are later work because this slice cannot create links.

The volume captures its Effect Clock. Directory creation publishes child metadata and parent timestamps/link count
together, using Unix-epoch bigint nanoseconds without promising physical nanosecond clock accuracy. Reads return
independent metadata objects. Failed creation leaves the namespace and metadata unchanged.

Operations use one permit per volume. Waiting is interruptible; publication and resource-state transitions are
uninterruptible. Interruption can arrive after publication, so it does not imply rollback. Cleanup is registered
before acquiring a directory reference. Acquisition into an already closed scope interrupts instead of retaining a
live reference. Expected failures use `FsError` or `ConfigurationError`; defects and interruption remain distinct.

See the [accepted contracts](../../.docs/context/first-core-contract-review.md),
[optional path limit](../../.docs/decisions/0021-optional-total-path-limit.md), and
[initial implementation evidence](../../.docs/context/first-core-implementation.md), and
[directory namespace evidence](../../.docs/context/directory-namespace-implementation.md).

## Regular files

`caller.open(path, { access: "readWrite", create: "ifMissing" })` acquires a scoped file. Handles provide read/write,
pread/pwrite, seek, truncate, stat, sync, and strict explicit close. Separate opens have separate bigint offsets.
`caller.unlink` removes the name while open handles retain bytes. See [file policy](../../.docs/decisions/0022-remaining-implementation-profile.md)
for access, limits, partial transfers, timestamp rules, and the intentional difference from Effect adapter cursors.

`caller.link` shares file or symlink identity. `caller.symlink` stores an exact raw target. `stat` follows targets;
`lstat` inspects links. `readDirectory`, `readLink`, and `realPath` have byte-preserving variants suffixed `Bytes`.
String variants fail with UnrepresentableName for non-UTF-8 names or targets. Enumeration is an atomic whole list
without implicit dot entries or an ordering promise.

Metadata operations include access, path truncate, chmod, chown, and utimes. Metadata-changing methods also have
Handle variants using invoking-caller authority. Path metadata options can select followFinalSymlink false.
Time updates use `{ kind: "now" }`, `{ kind: "omit" }`, or `{ kind: "value", nanoseconds: 0n }` for each field.
