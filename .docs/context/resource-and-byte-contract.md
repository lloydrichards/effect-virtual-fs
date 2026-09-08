# Resource, authority, and byte contract

Status: mixed accepted model and technical proposals, 8 September 2026. Refines D02, D06, D09, and D11.
[Decision 0011](../decisions/0011-independent-resource-lifetimes.md) accepts independent lifetimes and explicit authority.
[Decision 0012](../decisions/0012-copying-byte-ownership.md) accepts execution-time input copying and independent read buffers.
[Decision 0013](../decisions/0013-explicit-close-and-scope-cleanup.md) accepts strict explicit close and tolerant scope cleanup.
[Decision 0016](../decisions/0016-scope-free-root-callers.md) accepts scope-free root callers without public close.
Construction defaults, detailed capture timing, shared-memory policy, and error mappings remain proposals. Nothing here
is implemented; this document supports review of the [interface draft](public-api-draft.md).

## Lifetime and authority are separate

| Resource         | Proposed lifetime                                   | Proposed authority                                                |
| ---------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| Root caller      | Volume lifetime; no acquired cwd reference.         | Its immutable explicit identity and mask.                         |
| Derived caller   | Its own acquiring scope.                            | A copy of its parent's identity and mask at derivation.           |
| File handle      | Its own acquiring scope, or explicit earlier close. | Access granted by successful open governs read/write/truncate.    |
| Directory handle | Its own acquiring scope, or explicit earlier close. | A directory identity used with the invoking caller's credentials. |

Creating a derived caller retains its cwd independently. Its parent must be live when derivation executes, but later
parent finalization does not invalidate the child. Finalizing the child releases only its own reference.
Likewise, caller finalization does not invalidate a file handle acquired in another live scope.

After scope finalization, operations through a derived caller fail with a typed closed-caller error. Check liveness
when an Effect executes, not only when the operation is constructed. Effect requirements do not prevent stale values
from escaping a scope. See the pinned Effect source evidence in the interface draft.

Explicit file/directory close is strict under decision 0013: repeating it returns an invalid-handle error. Scope finalization uses
a private release operation that tolerates an already-released resource. It must not swallow unrelated failures.
Keep reference release and quota reclamation serialized with operations so they happen exactly once.

## Directory bases do not transfer opener privilege

The accepted ordinary-base model supplies directory identity without transferring opener privilege. The invoking caller supplies credentials and must
satisfy search checks starting at that base and along the remaining path. Passing a privileged caller's directory
handle does not grant that privilege to another caller.

For example, Alice using a base opened by an administrator still receives Alice's checks on that directory and its
descendants. Lookup begins at the supplied base, so this is not a promise to recheck the path used to obtain it.
Possession of a base permits addressing that directory independently of its current ancestor path.

This proposal covers ordinary directory bases. Do not claim `O_SEARCH` behavior from it; search-handle access rules
need a separate profile decision. For initial lookup-only directory handles, recommend checking search permission
when opening and using them; directory enumeration separately requires its selected access checks.

[Decision 0017](../decisions/0017-path-base-selection.md) rejects relevant foreign-volume and closed bases for
relative paths, and ignores unused bases for absolute paths. Invoking-caller liveness and path permissions still apply.

## Metadata mutations take a caller

Authority-sensitive handle metadata changes use the invoking caller. Proposed operation names include
`caller.chmodHandle(file, mode)`, `caller.chownHandle(file, owner)`, and `caller.utimesHandle(file, times)`.
They use the invoking caller's identity and the handle's file identity. They do not inherit the opener's privilege.

Handle `stat` inspects the referenced file. Read/write/truncate use the access granted on open. These operations can
continue after the originating caller's scope closes, provided the handle remains live in its own scope.
The selected permission rules must specify which checks apply to metadata mutations; see the
[permission proposal](permissions-and-metadata.md).

This avoids storing an invisible authority-bearing caller inside every handle. It also makes changing the caller
for a metadata operation explicit. The existing memory adapter does not expose these new handle metadata mutations.

Path representation and separator/dot rules are accepted in [decision 0018](../decisions/0018-path-input-policy.md).
The shared-memory and detailed capture-timing rules below remain proposals.

## Mutable inputs and results

Mutable input is consumed and copied when the Effect executes under decision 0012. Recommend copying it synchronously before the operation first
suspends or waits for volume coordination. Validation and mutation then use the owned copy. Constructing an Effect
does not capture the current bytes, and running it twice consumes the input separately each time.

For example, construct a write with bytes `A`, change the input to `B`, then execute it: the operation writes `B`.
Changing the original buffer after that execution has copied it must not change the committed bytes. Document that
callers keep inputs stable until consumption; reject shared-memory-backed inputs initially because a concurrent
thread can mutate them during a copy. Shared-memory support is not required by runtime-neutral browser support.

The existing memory adapter accepts `Uint8Array` inputs that may have shared backing. Preserve that input acceptance
by copying into an ordinary buffer before calling core rather than forwarding a newly rejected view. This does not
promise a coherent snapshot of input concurrently modified by another thread; no such guarantee has been established
for the existing adapter. Document its consumption timing and add a focused compatibility case for stable shared input.

| Boundary                 | Proposed ownership rule                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| Byte path construction   | Validate and copy; retain an opaque immutable value, with no lexical dot/dot-dot collapse. |
| String paths             | Reject lone surrogates instead of replacing them during UTF-8 encoding.                    |
| File writes              | Own the consumed bytes before waiting for commit.                                          |
| File reads               | Return owned bytes; mutating the result never changes the file.                            |
| Snapshot capture         | Copy reachable content while mutations are excluded; expose an opaque image.               |
| Fixture and decode input | Retain no mutable aliases in the returned volume or snapshot.                              |
| Encoded output           | Return caller-owned bytes; mutation cannot alter the snapshot.                             |
| Restore                  | Each restored volume owns independent storage.                                             |

Input copying can consume memory beyond the volume quota, including bytes that a short write cannot commit. Do not
confuse this simple ownership policy with a bounded-memory guarantee. Transfer and decode limits still need numbers.

For a multi-buffer fixture, define one synchronous input-capture phase before asynchronous work; do not copy one
record, yield, and later copy another while claiming a single input version. A streaming input format would require
a different explicit consumption contract.

## Typed failures

Recommend three distinct failure families: filesystem operation failures, invalid configuration, and snapshot/fixture
validation failures. Exact class names remain open. Filesystem errors retain a code and operation context; closed
callers and unrepresentable string results need distinct project reasons in addition to POSIX-derived distinctions.

| Failure                                                 | Proposed Effect adapter treatment                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Missing entry                                           | Preserve `NotFound`.                                                                               |
| Existing entry where creation is exclusive              | Preserve `AlreadyExists`.                                                                          |
| Denied access or privilege                              | Preserve `PermissionDenied`.                                                                       |
| Wrong kind, invalid handle, capacity or size exhaustion | Map deliberately to `BadResource`, retaining the distinct structured core cause.                   |
| Invalid numeric or string input                         | Use `BadArgument` with the adapter operation context.                                              |
| Unrepresentable string result                           | Propose `BadResource` with a distinct structured cause; do not return a partial directory listing. |

The first categories preserve current mappings; new cases need focused compatibility checks. Existing symlink-loop
mapping and operation-specific exceptions must be read from the adapter before completing the table. These error
names exist in pinned `effect@4.0.0-rc.112` `src/PlatformError.ts`; the table is a proposed mapping, not a new API.
Do not turn defects or interruption into ordinary filesystem failures, and never recover error codes from prose.

For raw paths in diagnostic context, retain owned byte data with a separate display representation. A display string
must never be reused as the path's identity. Watch-stream handling for unrepresentable event paths remains open.

## Review and proof cases

Implement the accepted lifetime and authority model only after resolving the remaining construction details. Require
focused cases for child survival after parent finalization; a lazy operation executed after caller closure; a
privileged opener's base used by an unprivileged caller; metadata mutation under a different caller; early close and
scope cleanup; input mutation before and after execution; and mutation of read/snapshot results.
No such behavior has been implemented or tested in this documentation pass.
