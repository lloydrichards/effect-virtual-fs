# Public interface draft

Status: proposal, 8 September 2026. Access styles are accepted in decision 0002; independent lifetimes and explicit
authority are accepted in [decision 0011](../decisions/0011-independent-resource-lifetimes.md). Names, types, and construction
rules below are proposed and do not exist in `@effect-vfs/core`. Code blocks are design examples, not runnable API
documentation or type-checked consumer tests. The [resource contract](resource-and-byte-contract.md) supplies proposed
authority, lifetime, byte ownership, and error rules; the [snapshot format example](snapshot-format-draft.md) makes
fixture and persistence shapes concrete.

## One implementation, two access styles

Recommend one caller object containing filesystem methods and a service tag that supplies that same object.
The service layer does not wrap every operation in another implementation. Direct consumers pass caller objects;
Effect applications can obtain them from their environment. Both get identical errors and filesystem behavior.

Use `VirtualFileSystem` as the proposed module name, `Volume` for shared state, `Caller` for caller-bound methods,
and `CurrentFileSystem` for the optional service identity. The latter must remain distinct from Effect's existing
`FileSystem.FileSystem`, supplied by the memory adapter.

| Object           | What it exposes                                                                 | What stays private                                        |
| ---------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Volume           | Caller construction and snapshot capture.                                       | Inode maps, locks, mutable storage, descriptor tables.    |
| Caller           | Path operations, identity-preserving cwd derivation, opening files/directories. | Resolution traversal state and permission implementation. |
| File handle      | Sequential and positional I/O, seek, metadata, truncate, explicit close.        | Numeric descriptor allocation and mutable offsets.        |
| Directory handle | An opaque base for directory-relative operations and explicit close.            | Mutable directory entries.                                |
| Snapshot         | A value accepted by encode/load operations.                                     | Mutable byte arrays and persistent record tables.         |

Do not require a pluggable storage interface in the first version. The concrete variations already needed are caller
provision, the Effect adapter, and external persistence/build consumers. Keep storage replaceable internally without
making every caller understand it.

## Construction and lifetime proposal

Recommend effectful construction, root callers with volume lifetime, and scoped derived callers, file handles, and
directory handles. A root caller needs no extra cwd-retention resource because the volume already retains its root.
A caller derived with a different cwd receives its own directory reference and scope registration. Once acquired,
it survives parent-caller finalization while its own scope remains live.
Finalizing that scope stops subsequent derived-caller operations but does not independently close handles opened
into other live scopes. Handle ownership follows the scope in which each handle was acquired.

This split preserves `MemoryFileSystem.make` with no `Scope` requirement: its default caller can have volume lifetime.
Do not open an undisposable internal scope or add a new `Scope` requirement to the existing adapter constructor.
Explicit caller close is not proposed yet. Scoped caller operations executed after finalization must fail with a
typed closed-caller error, including lazy Effects constructed while the caller was still live.

Independent lifetimes are accepted for D09. The root-caller construction split above remains proposed, and removed
cwd behavior still needs a contract and tests.
The volume itself can be an ordinary managed-memory object initially: no host descriptor or background task is required
by construction. Watch subscriptions, if added internally for adapter compatibility, have explicit scoped ownership.

Schematic signatures, using placeholder domain types:

```ts
// Domain names are proposed; Scope.Scope and Effect.Effect refer to Effect.
make(options?: VolumeOptions): Effect.Effect<Volume, ConfigurationError>
volume.caller(options?: RootCallerOptions): Effect.Effect<Caller, ConfigurationError>
caller.withDirectory(path: PathInput): Effect.Effect<Caller, FsError, Scope.Scope>
caller.open(path: PathInput, options: OpenOptions): Effect.Effect<FileHandle, FsError, Scope.Scope>
caller.openDirectory(path: PathInput): Effect.Effect<DirectoryHandle, FsError, Scope.Scope>
```

Construction captures implementation dependencies. Ordinary operations need no caller service in their Effect
requirements once a concrete caller exists. Scoped acquisitions intentionally require `Scope.Scope`.
Do not use an ambient default service to grant privilege. `volume.caller()` explicitly requests the documented
privileged defaults; identity options can explicitly disable privilege regardless of UID.

## Direct consumer example

```ts
import { VirtualFileSystem } from "@effect-vfs/core" // proposed export
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const volume = yield* VirtualFileSystem.make()
  const admin = yield* volume.caller()
  yield* admin.mkdir("/project", { mode: 0o755 })
  yield* admin.mkdir("/project/src", { mode: 0o755 })

  const project = yield* admin.withDirectory("/project")
  const file = yield* project.open("src/main.js", {
    access: "readWrite",
    create: "exclusive",
    mode: 0o644
  })
  const written = yield* file.write(new TextEncoder().encode("export default 1"))
  yield* file.seek(0n, "start")
  const bytes = yield* file.read(written)
  yield* file.close()
  return { written, bytes }
}))
```

This example proposes bigint offsets and number-sized transfer buffers; that representation is not accepted yet.
`write` proposes a number-sized transfer count, distinct from bigint file offsets. The example retains that count
without assuming the entire input was written. `read(n)` proposes an owned buffer of up to `n` bytes, with an empty
buffer at EOF; it may return fewer bytes than requested. A `writeAll` convenience needs an explicit partial-progress
and failure contract.
Returned read bytes are owned by the caller. Early close must coexist with safe scope cleanup.

## Optional service example

```ts
import { Context, Effect, Layer } from "effect"

// Proposed service definition, using the proposed Caller shape.
class CurrentFileSystem extends Context.Service<CurrentFileSystem, Caller>()(
  "@effect-vfs/core/CurrentFileSystem"
) {}

const inspect = Effect.gen(function*() {
  const fs = yield* CurrentFileSystem
  return yield* fs.stat("src/main.js")
})

// Within the scope that owns project:
const byContext = inspect.pipe(Effect.provideService(CurrentFileSystem, project))
const byLayer = inspect.pipe(Effect.provide(Layer.succeed(CurrentFileSystem, project)))
```

Both examples provide the exact same caller. `Layer.succeed` does not acquire or extend its lifetime. A convenience
`CurrentFileSystem.layer(volume, options)` could construct a root caller and optionally derive a cwd caller in the
layer's scope; its signature remains open.
Neither providing a service nor closing a service layer should destroy a volume shared with other consumers.

## Identity and directory-relative example

<!-- dprint-ignore -->
```ts
// Inside an Effect scope with an existing volume and privileged admin caller:
const aliceRoot = yield* volume.caller({
  identity: { uid: 1000, gid: 100, groups: [], privileged: false },
  umask: 0o022
})
const alice = yield* aliceRoot.withDirectory("/project")
const base = yield* alice.openDirectory("src")
yield* admin.rename("/project", "/renamed")
const throughCwd = yield* alice.stat("src/main.js")
const throughDirectory = yield* alice.stat("main.js", { relativeTo: base })
```

Both lookups identify the same file after rename. `relativeTo` is a proposed option shared across path operations;
two-path operations need separate source and destination bases. The proposed base supplies identity, while Alice
supplies the lookup credentials; it does not transfer the opener's privilege. Search-handle semantics remain separate.
Reject foreign-volume or closed bases explicitly.
Absolute-path treatment with a supplied base must follow the selected POSIX profile. Directory removal while held as
a cwd/base remains an open contract; rename behavior alone does not answer it.

## Proposed operation inventory

This is a candidate whitelist for D01, not a claim that every POSIX variant is covered.

| Family            | Proposed caller or handle operations                                                 | Contract that must accompany the names                                                    |
| ----------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Lookup            | `stat`, `lstat`, handle `stat`, `realPath`, `readDirectory`, `readLink`              | Follow/no-follow, bytes versus strings, metadata fields and timestamps.                   |
| Namespace         | `mkdir`, `rmdir`, `unlink`, `rename`, `link`, `symlink`                              | Distinct kind rules, directory bases, final symlinks, atomicity, permission checks.       |
| Files             | `open`, handle `read`, `write`, `pread`, `pwrite`, `seek`, `truncate`, `close`       | Modes, short transfers, offsets, error behavior, scope release, positional append policy. |
| Path truncation   | caller `truncate`                                                                    | Must not clamp existing core offsets.                                                     |
| Metadata changes  | `chmod`, `chown`, `utimes`, caller-owned handle variants                             | Privilege exceptions, preserved fields, special bits, time precision.                     |
| Synchronization   | handle `sync`                                                                        | Explicitly volatile; no durable host flushing.                                            |
| Caller derivation | `withDirectory`; identity/mask derivation shape still open                           | Immutable caller state and retained directory identity.                                   |
| Persistence       | `fromFixture`, `volume.snapshot`, `encodeSnapshot`, `decodeSnapshot`, `fromSnapshot` | Final-state validation, owned bytes, JSON/base64, independent restores.                   |

Recommend structured open options instead of numeric platform bitmasks. Define access, creation, truncation, append,
and final-symlink policy explicitly and reject invalid combinations. Directory search handles and supported flags
need their own profile decisions. `SEEK_DATA` and `SEEK_HOLE` must be included explicitly or listed as exclusions.
No directory-stream cursor API is proposed until the enumeration contract is settled. Authority-sensitive handle
metadata changes belong on the invoking caller under the resource proposal, for example
`caller.chmodHandle(file, mode)`. A file handle does not silently retain its opener's metadata-changing privilege.

## Bytes and errors

[Decision 0012](../decisions/0012-copying-byte-ownership.md) accepts copying byte inputs when Effects execute and
returning independent read buffers. Exact capture scheduling and shared-memory handling remain open.

Recommend a validated immutable byte-path value plus string conveniences. A raw `Uint8Array` must not become a mutable
map key or a retained input alias. Define when lazy operations copy inputs. Recommend rejecting lone surrogates in
string paths rather than encoding them lossily; this input policy is still open.

Recommend explicit `readDirectoryBytes`/`readLinkBytes` counterparts for byte results rather than an option that
changes the return type. Filename results use strict conversion under decision 0003. Listing unrepresentable names
fails; looking up a representable sibling still works. Applying strict conversion to raw symlink targets is a
recommendation, not settled by that decision. String watch failures need a separate stream contract.

Define a structured filesystem error with a distinguishable code and operation context. Keep invalid argument,
foreign handle, decoding, and filesystem failures distinguishable. Exact class/tag layout remains open. Do not encode
byte paths in a lossy message field or parse descriptions to map errors into `PlatformError`.

## Before these examples become the contract

[Proposed declarations and consumers](../contracts/README.md) now compile against the pinned dependencies. The
checked examples live in that directory; the schematic snippets above remain explanatory fragments. New declaration
choices, including numeric types and constructor signatures, remain proposals despite successful compilation.

The Effect composition primitives were checked against the exact `effect@4.0.0-rc.112`
[npm artifact](https://registry.npmjs.org/effect/-/effect-4.0.0-rc.112.tgz), extracted outside the repository.
Relevant source locations are `src/Context.ts` class-style `Service` at line 309; `src/Layer.ts` `succeed` at 1078
and `effect` at 1427; `src/Effect.ts` `provideService` at 12517, `scoped` at 12815, and `acquireRelease` at 12928.
The archive SHA-256 is `8ce8e4a5f65987c11f1efa094bc7a36730d989437946932314c9e8321fcc073f`.
These locations belong to that archive, not the repository's source tree or an unpinned latest release.

`Effect<A, E>` defaults its requirements to `never`. `acquireRelease` adds `Scope`, and its finalizer has no typed
failure channel. `scoped` removes the scope requirement but cannot prevent returning an already-finalized handle.
Public explicit close and infallible scope cleanup therefore need separate internal behavior if repeat-close fails.
This source check verifies the composition primitives, not the proposed core types or implementations.

Resolve remaining construction details, operation/flag whitelist, numeric ranges, path/string constructors, and
partial I/O contracts. Independent resource lifetimes and explicit-close behavior are already accepted. Once the
interface is accepted and implementation is authorized, replace the declaration-only imports with the real package
and add behavioral checks. Passing the present check proves composition and types, not implemented behavior.
