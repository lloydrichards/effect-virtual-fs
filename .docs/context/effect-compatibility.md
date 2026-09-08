# Effect compatibility and migration evidence

Status: research draft, 8 September 2026. This is a source audit, not a fresh test run or an approved API.

`@effect-vfs/memory` already defines observable behavior that the new backend must support through adaptation.
Preserve that behavior while giving `@effect-vfs/core` its own tested contract.
The [design](../design/VirtualFileSystem-design.md) and [package decision](../decisions/0001-package-boundaries.md)
establish that direction. They do not settle the adapter constructor, cursor implementation, or event API.

## What exists

- [MemoryFileSystem.ts](../../packages/memory/src/MemoryFileSystem.ts) exports `make` and `layer`.
  `make` constructs a fresh service; layer memoization shares an instance unless callers use a fresh layer.
- [memoryFileSystem.ts](../../packages/memory/src/internal/memoryFileSystem.ts) owns the entire implementation today.
  Its `make` creates a private volume and `/tmp`, then passes operations to `FileSystem.make`.
- [FileSystemTest.ts](../../packages/memory/test/FileSystemTest.ts) exports `suite`, the shared adapter contract.
  [MemoryFileSystem.test.ts](../../packages/memory/test/MemoryFileSystem.test.ts) invokes it and adds memory-specific tests.
- [package.json](../../packages/memory/package.json) pins the Effect peer dependency to `4.0.0-rc.112`.
  These findings describe this checkout. Recheck the pinned Effect contract when changing dependencies.

All implementation symbols below refer to `memoryFileSystem.ts`. Test names refer to the two linked suites.
No dependencies were installed and no tests were executed for this audit. A test's presence is evidence of intent;
it does not establish that the current checkout passes or that the assertion detects every related regression.
Historical exploratory POSIX counts in the design are a separate evidence source.

## Reusable structure and limits

| Current structure                                                    | Useful property                                                            | Work needed for core                                                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `State.inodes`, `DirectoryInode.entries`, `OpenFileDescriptor.inode` | File identity is independent of names and open handles.                    | Replace string names with a byte-preserving representation and define public opaque identities. |
| `nlink`, `openCount`, `reclaimInode`                                 | Open unlinked files survive until their final reference closes.            | Define caller-directory references and accounting for unlinked storage.                         |
| `resolve`, `resolveParent`, `resolveEntry`                           | Component traversal handles symlinks, dot/dot-dot and trailing separators. | Add caller directory identity, credentials, permission checks and byte paths.                   |
| `makeVolume`, `TransitionResult`, `mutate`                           | A semaphore serializes state changes and event publication.                | Specify atomic operations and snapshot capture under the same coordination boundary.            |
| `readFile`, `readDescriptor`                                         | Public reads copy bytes into independent buffers.                          | State ownership rules for every new byte-taking and byte-returning API.                         |
| `writeDescriptorUnlocked`                                            | In-place overwrites avoid an allocation when the file does not grow.       | Copy snapshot bytes; persistent maps alone do not make buffers immutable.                       |
| `collectDirectoryEntries`, `collectInodePaths`, `glob`               | Iterative traversal avoids recursive JavaScript calls.                     | Preserve deep-tree behavior through migration and snapshot traversal.                           |
| `fileInfo`                                                           | Projects internal metadata into Effect's metadata shape.                   | Expose backend metadata separately; internal `ctime` is currently absent from this projection.  |

The existing private `Volume` is an implementation mechanism, not the proposed public volume API.
It contains descriptors and Effect watch subscriptions and exposes state callbacks internally.
Do not publish it unchanged merely to make it available to another package.

## Cursor and handle contracts

| Operation              | Current adapter behavior                                                   | Migration consequence                                                                         |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Separate `open` calls  | Each descriptor starts at position zero and has its own position.          | Binding a common volume must not share handles or positions.                                  |
| Ordinary read/write    | Reads advance by bytes read; non-append writes advance by bytes written.   | Preserve access-mode errors, EOF counts and zero-filled gaps.                                 |
| Append write           | Writes at the current file end without changing `descriptor.position`.     | Backend append moves its offset; the adapter needs an independent cursor strategy.            |
| `MemoryFile.truncate`  | Clamps only this non-append handle when its cursor exceeds the new length. | Do not clamp all descriptors or apply backend offset semantics directly.                      |
| Path `truncate`        | Changes file bytes without changing descriptor positions.                  | Keep path truncation distinct from the handle convenience behavior.                           |
| Append-handle truncate | Leaves its position unchanged.                                             | Specify this edge case alongside the better-tested non-append case.                           |
| `MemoryFile.seek`      | Supports start/current positioning; its Effect type has no typed error.    | A backend seek that can fail needs an explicit adapter policy.                                |
| Closed-handle seek     | Currently succeeds with position zero.                                     | Source observation, not an explicit shared regression test. Decide preservation deliberately. |
| Seek below zero        | Currently stores the position; nonempty I/O later rejects it.              | Source observation, not proof of the desired backend behavior.                                |
| Scope close            | `open` uses `Effect.acquireRelease`; `closeDescriptor` is idempotent.      | Core explicit close and scoped cleanup must coexist without double release.                   |
| `MemoryFile.sync`      | Validates that the descriptor is open and otherwise succeeds.              | Keep volatile synchronization honest; it does not persist data.                               |

The shared suite explicitly protects these cursor cases:

- `should preserve the read cursor when appending through a handle`
- `should preserve or clamp a file-handle cursor based on the truncated length`
- `should read appended bytes from a cursor clamped by truncation`
- `should return the resulting cursor when seeking`
- `should keep read cursors independent when a file has multiple handles`

For example, append `foo`, seek to zero, append `bar`, then read three bytes. The adapter returns `foo`.
A direct backend append that advances the offset would instead leave the handle at EOF.

Prefer an adapter cursor with backend positional I/O if the final core API supports it cleanly.
Do not implement append as a separate stat followed by positional write: another writer can change EOF between them.
The append placement and write must remain one backend operation. This is a recommendation, not an approved API.

## Paths, names and permissions

`resolve` starts relative paths at `/`, follows at most 40 symlinks, and treats `/` as the separator.
It walks components before processing subsequent dot/dot-dot segments. `stat` follows the final symlink;
`readLink`, removal and rename have their own final-link handling. There is no public `lstat` here.
`DirectoryInode.entries` uses JavaScript string equality, and `SymbolicLinkInode.target` stores a string.

The memory-specific suite protects dot/dot-dot, repeated separators, final-link removal/rename,
exclusive creation against a dangling symlink, and rename between aliases of one inode.
The shared suite protects relative/absolute symlink targets, traversal through a file, trailing separators,
and loop errors with operation context.

`chmod`, `chown` and `utimes` store metadata. `access` checks existence and does not enforce permission bits.
The test `should store POSIX metadata without enforcing a virtual user identity` makes that behavior explicit.
Core permissions must therefore not accidentally make the existing default adapter less permissive.

Decisions needed before migration:

Accepted constraints now include [strict filename results](../decisions/0003-strict-string-filename-boundary.md)
and [explicit privilege](../decisions/0004-explicit-caller-privilege.md). Questions below concern their remaining
operation details, not whether to use lossy names or automatic UID-zero privilege.

- Should binding an existing volume always use the privileged default, or optionally accept a caller context?
  Keep existing `make` behavior unchanged either way.
- How does the string adapter report non-UTF-8 names in directory listings, `realPath`, symlink targets and watch events?
  Filename results must fail strictly; choose exact error mapping and stream reporting. Raw symlink-target conversion remains open.
- What happens to JavaScript strings containing lone surrogates? UTF-8 encoding can replace them and merge names
  that the current string map distinguishes. Validate or define encoding before inserting names.
- Does binding a volume create `/tmp`, and what happens if it already exists as another file kind?
  Fresh `make` currently creates it; binding a shared volume adds a new initialization case.

## Error translation

The existing implementation creates `PlatformError` directly through `fileSystemError`, `argumentError`,
`descriptorError`, `withSystemErrorPath` and `withOperationError`.
Core must retain its own distinctions before the binding maps them into this smaller error vocabulary.

| Existing evidence                                                          | Required adapter result                                                                                                                               |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `should normalize stable filesystem errors when path operations fail`      | Missing read gives `NotFound`; existing mkdir gives `AlreadyExists`; read-directory on a file gives `BadResource`. Preserve method and original path. |
| `should normalize missing-path errors when primitive path operations fail` | Preserve missing-path context across metadata, copy, links, rename and truncation. The test deliberately leaves the `utimes` method assertion open.   |
| `getOpenFile`, `descriptorError`                                           | Closed, wrong-access and non-file descriptors become `BadResource` with a descriptor and operation method.                                            |
| `should leave bytes unchanged when file-size mutations are invalid`        | Invalid truncate sizes produce `BadArgument` without altering bytes.                                                                                  |
| `should preserve error context when symbolic links form a loop`            | Preserve the adapter error shape while core can distinguish link-loop failure.                                                                        |

Create a mapping table keyed by backend error tags and operation context. Never parse description strings to recover
missing core distinctions. Allocation failure currently becomes `BadResource`; configured capacity errors need an
explicit mapping choice rather than reusing that behavior accidentally.

## Helpers, watches and operation boundaries

`FileSystem.make` supplies derived behavior such as string reads/writes, streams and sinks from the provided operations.
Keep its use in the adapter. Preserve `copy`, recursive removal/mkdir, temporary resources and glob support as adapter
conveniences unless a separate core consumer justifies a backend operation.

The shared suite covers scoped cleanup after success and failure, bounded stream ranges, sink append behavior,
and `should finalize derived stream and sink handles when their operations succeed or fail`.
Copy behavior needs care: `should preserve existing destination links and handles when copying file contents`
requires updating destination identity rather than replacing it with a fresh inode.

Memory watches publish normalized absolute paths after state assignment, under the mutation permit.
Rename publishes remove/create events. Content updates publish through every currently reachable hard-link alias.
`watch` registers a path subscription, buffers events while its callback queue attaches, and unregisters on scope exit.
It follows the resolved path recorded at subscription time; it is not a directory-inode watch abstraction.

The memory suite protects direct-child versus recursive events, normalized mutation events, alias updates,
and directory creation events when recursive mkdir ends in dot or dot-dot.
Globbing excludes directory symlink traversal, tested by `should not traverse directory symbolic links while globbing`.

Core mutations made by another consumer must reach adapter watchers. An adapter wrapper that emits only for its own
calls cannot preserve shared-volume observation. Decide an internal or public core notification contract, including
ordering, subscription lifetime and overflow behavior. No snapshot should retain these subscriptions.

`writeFile` currently opens, writes and closes within one `volume.mutate`; `makeTempFileWithMethod` stages its changes
with `mutateInterruptibly`. Composing those helpers from several public core calls changes their concurrency boundary.
Review each helper before decomposition and document any deliberate behavioral change.

## Verification gates for implementation

1. Establish a fresh baseline with the pinned dependencies before moving behavior. Record the command and result.
2. Keep `FileSystemTest.suite("memory", MemoryFileSystem.layer)` and the memory-specific tests passing after migration.
3. Add separate core offset tests for append and truncate. Pair them with adapter tests that expect the different behavior.
4. Add targeted adapter regressions for path truncate, append-handle truncate and the chosen seek policy.
5. Test two bindings and a standalone caller against one volume: shared bytes, independent positions and caller state,
   correct scope cleanup, and watcher events for mutations through every consumer.
6. Test wrong-kind, closed-handle, permission and capacity mappings without inspecting error description prose.
7. Exercise byte names and symlink targets that cannot round-trip through the string interface under the chosen policy.
8. Preserve the deep-tree test `should write, list, copy, and rename a deeply nested volume`, which uses 6,000 levels.
9. Run the existing package build checks after the dependency moves to core.
   The browser entry is a bundling check, not a browser runtime filesystem test; NodeNext checks module/type resolution.

The [CI workflow](../../.github/workflows/pr-validation.yml) runs formatting, lint, type checking, tests and build.
The [memory build script](../../packages/memory/package.json) also checks emitted NodeNext imports and browser bundling.
These are planned verification commands here, not newly observed successes.
