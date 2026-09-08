# Consolidated first-core contract review

Status: accepted sections 1-4, 8 September 2026, under [decision 0020](../decisions/0020-first-core-contracts.md).
Decision 0021 subsequently resolves the total-path gate with an optional bound, omitted by default. This is not authorization to implement core or acceptance of later
I/O, snapshot, adapter, or release contracts. Decisions 0001-0020 remain authoritative.

## Scope and readiness

The [first slice](first-core-slice.md) includes construction, byte paths, stat, mkdir, scoped cwd derivation, directory
handles, and optional service provision. It establishes directory identity and caller authority before regular files.

The original total-path evidence gate is now resolved by decision 0021 after measurement and compatibility review.
Do not quietly substitute 4096 or describe the unfinished profile as unlimited. Measurements, exact baseline commands,
and source-backed implementation details are engineering work, not another series of preference questions. Return for
review only if they expose a consequential tradeoff or conflict with an accepted decision.

## 1. Construction, permissions, and directory metadata

| Item                      | Recommendation                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Fresh construction        | Each execution of make creates an independent volume. Each caller execution captures an independent immutable identity and umask. |
| Initial namespace         | Root only; no implicit `/tmp`, home directory, or dependency tree. Adapter conveniences are separate.                             |
| Root metadata             | uid 0, gid 0, mode 0755. Root ownership is independent of the caller used later.                                                  |
| Default caller            | uid 0, gid 0, no supplementary groups, privileged true, umask 0022. Explicit privilege is already accepted.                       |
| Credentials               | Nonnegative safe-integer uid/gid/group values; membership uses primary and supplementary groups. No host-user lookup.             |
| Mode arguments            | Integer permission/special bits in 0000-7777; reject negative, fractional, or out-of-range input. Umask accepts 0000-0777.        |
| Default mkdir mode        | Request 0777, then apply the caller mask to permission bits. Under the default mask, create 0755.                                 |
| New directory owner/group | Caller uid and parent directory gid. No automatic permission inheritance.                                                         |
| Creation special bits     | Retain requested sticky bit, ignore requested set-ID bits; do not inherit set-ID bits. Later chmod has its own contract.          |
| Directory stat            | kind directory, size 0, nlink 2 plus immediate child directories, opaque volume-local bigint inode identity.                      |
| Inode identity            | Stable for a live inode, distinct within a volume; no cross-volume equality meaning or chosen sequence promised.                  |

Use exactly one mode-bit class: owner if uid matches, otherwise group if any caller group matches, otherwise other.
Do not fall through after a denied owner or group check. Explicit privilege bypasses directory read/write/search
checks, not malformed input, wrong kind, invalid resources, or capacity limits.

For pathname stat, check search on directories traversed; do not require read permission on the final object.
For mkdir, require search along the path prefix and write plus search on the parent. Do not require parent read
permission merely to create a known name. Existing destinations fail; mkdir is exclusive and nonrecursive.
For withDirectory/openDirectory, additionally require search on the selected final directory. Directory handles
provide lookup identity, not enumeration or O_SEARCH semantics. Use of a supplied base repeats search checks under
the invoking caller as already accepted. Handle stat requires a live handle, without rechecking opener credentials.

A root mode of 0755 means unprivileged callers cannot create root entries by default. A privileged caller can create
an appropriately owned/mode-controlled working directory through caller credentials and mkdir. This is intentional,
not a reason to make the entire root writable.

### Time policy

Capture the Effect Clock service when constructing the volume. Use that service for later timestamps, so a writer's
environment cannot silently switch the clock used for the same volume. Store Unix-epoch bigint nanoseconds and retain
the precision supplied by the clock. The default clock's physical precision is not a nanosecond-accuracy promise.

Sample once inside each successful creation commit. Initialize child atime/mtime/ctime/birthtime to that value and
update parent mtime/ctime to the same value. Root construction initializes its four timestamps together. Directory
stat, cwd derivation, directory-handle acquisition, and close do not change timestamps. Failed creation changes none.
Do not require timestamps to increase: clocks can move backward and successive calls can share a value. Directory
lookup does not introduce incidental atime updates in this first profile. Explicit timestamp mutation is later scope.

## 2. Input ownership and entry limits

Reject shared-memory-backed byte views at the core byte-input boundary initially, with InvalidArgument. Copy ordinary
views at Effect execution before the first wait; store no caller-owned mutable aliases. Copy configuration objects
and group arrays before retaining them too. A detached/unreadable view must fail rather than silently become a
successful empty input. Runtime tests must cover the actual view kinds the chosen runtime supports.

This makes byte ownership straightforward, but callers with SharedArrayBuffer views must first create an ordinary
copy. The memory adapter must preserve its existing stable shared-input acceptance by copying at its own boundary
when migration arrives. Concurrent external mutation during that adapter copy has no coherent-snapshot guarantee.
Do not add adapter code in this slice.

Count one entry for each named directory added below root. Exclude root and implicit dot/dot-dot references from the
entry quota. Directory metadata and handles do not consume file-content bytes. Thus maxEntries 0 constructs an empty
root successfully but rejects its first mkdir; maxEntries 1 permits exactly one new directory. Quotas are logical
usage limits, not heap budgets.

An explicit maxEntries must be a nonnegative safe integer. When omitted, propose no configured entry quota; this is
not infinite storage or protection from allocation failure. Keep the omitted-limit behavior documented and use small
explicit quotas in tests. Do not guess a finite default from unmeasured dependency counts. Separate inode/handle limits
and later file-content accounting remain outside this directory slice.

Keep 255 component bytes and 40 traversals provisional under decision 0019. A component limit counts encoded bytes,
not UTF-16 code units. The total-path/expansion bound stays open until measurement; future symlink tests are not a gate
for this directory-only implementation. Fixtures and snapshots will need the same final naming rules later.

## 3. Errors and validation boundaries

Use the existing concrete Data error families. Add a distinct PathTooLong filesystem code for component/path bounds;
do not collapse it into FileTooLarge. These recommendations complete the initial operation subset, not all core errors.

| Condition                                                                        | Proposed typed failure                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Invalid construction configuration                                               | ConfigurationError with the offending field.                               |
| Empty pathname supplied to an operation                                          | FsError NotFound, matching the selected path-operation profile.            |
| Empty input to pathFromBytes                                                     | FsError InvalidArgument: the constructor cannot produce an empty BytePath. |
| Embedded NUL, unsupported backing, invalid numeric operation input               | FsError InvalidArgument.                                                   |
| Lone surrogate in a string path                                                  | FsError InvalidPathEncoding.                                               |
| Overlong path/component                                                          | FsError PathTooLong.                                                       |
| Missing prefix/target                                                            | FsError NotFound.                                                          |
| Non-directory where traversal or a directory resource is required                | FsError NotDirectory.                                                      |
| Directory search/write denied                                                    | FsError AccessDenied.                                                      |
| mkdir destination exists                                                         | FsError AlreadyExists.                                                     |
| Entry quota exhausted                                                            | FsError NoSpace.                                                           |
| Finalized derived caller                                                         | FsError ClosedCaller.                                                      |
| Relevant foreign directory base                                                  | FsError ForeignHandle.                                                     |
| Relevant closed directory base, closed handle operation, repeated explicit close | FsError InvalidHandle.                                                     |

Failures retain a stable operation identifier, code, and owned path context where applicable. Do not parse error prose
or expose host errno numbers as the core contract. Effect interruption stays interruption; unexpected defects are not
converted into ordinary filesystem failures. Schema validation failures are mapped at the public boundary, rather than
leaking SchemaError through an API declared to return ConfigurationError or FsError.

Validate input representation before entering coordinated lookup. Inside coordination, validate caller liveness, then
relevant base association and liveness; for a base both foreign and closed, ForeignHandle wins. Absolute paths ignore
the base under decision 0017. Resolve prefixes with search checks before inspecting inaccessible descendants. Complete
all predictable typed-failure checks, including quota and creation arguments, before publication.

Do not promise a universal error ordering when unrelated input faults coexist. Tests should isolate the condition
under test except for the specific ordering guarantees above. Privilege does not bypass input or resource validation.

## 4. Mutation, interruption, and resource acquisition

Coordinate lookup, authority checks, reference acquisition/release, and mutations against one consistent volume state.
Begin with one coordination mechanism per volume; it is an implementation choice, not a public lock API. No user
callbacks or asynchronous host work should execute in a mutation commit.

Waiting to enter an operation is interruptible. Once committing mkdir, update the entry, inode, parent link count,
quota, and timestamps as one uninterruptible publication. No observer sees a partial directory. An expected typed
failure before publication leaves the previous state intact. This does not promise recovery from out-of-memory
failure or arbitrary defects after process-level failure.

Interruption before commit leaves no mutation. Interruption arriving after commit may be observed instead of a
success result even though the directory exists. Do not roll back the directory or promise exactly-once retries.
A caller can inspect the destination before deciding what to do next; this inspection is a separate operation.

Scoped acquisitions must couple reference retention with cleanup registration without an interruptible gap. Waiting
for coordination can remain interruptible; after acquisition starts committing, protect retention and finalizer
registration. If acquisition is interrupted before delivery, cleanup releases the retained reference. Do not make a
long wait uninterruptible by wrapping the entire acquisition indiscriminately.

Serialize close against operations. If an operation takes its turn first, it sees the live resource; if close wins,
later use fails. This orders state transitions, not delivery of fiber results. Scope cleanup tolerates earlier release
through a private release path and must not swallow unexpected failures. These rules preserve decisions 0011-0013.

## Evidence checked and work still required

- [mkdir DESCRIPTION and ERRORS](https://pubs.opengroup.org/onlinepubs/9799919799/functions/mkdir.html) were retrieved
  directly and reread for this proposal: parent access, exclusive creation, owner/group alternatives, creation bits,
  timestamps, and no-directory-on-failure behavior. Parent-group inheritance and special-bit policy select documented
  alternatives. This is not a complete POSIX conformance claim.
- The [permission research](permissions-and-metadata.md) records verified Issue 8 class selection and privilege rules.
- Pinned effect@4.0.0-rc.112 Clock.ts defines currentTimeNanos/currentTimeNanosUnsafe as Unix wall-clock bigint values.
  Effect.ts exposes acquireRelease with an interruptibility option and uninterruptibleMask. Those primitives support
  implementation; their existence is not proof of a correct interruptible-acquisition composition.
- Current memoryFileSystem.ts toFileInfo reports directory size 0. Core inode identity and link-count rules still need
  behavioral proof and a later adapter compatibility check.

Before coding: review this package, complete the path-length measurement proposal, and establish the exact pinned
workspace baseline. During coding: prove the public behavior cases in the first-slice document, adding quota-zero,
clock-capture, shared-input rejection, error-boundary, and coordinated interruption cases from this package. No core
behavioral tests were executed in this review. Subsequent [evidence gathering](preimplementation-evidence.md) measured
four dependency trees and ran the isolated workspace baseline; its failures are the next preparation task.

## One review, not another questionnaire

Sections 1-4 are accepted together, subject to the explicitly open path-length measurement gate. The main
tradeoffs are a protected default root, explicit copying for shared memory, no configured entry quota when omitted,
and possible committed work when interruption races with completion. If those fit, the remaining work is evidence
and implementation preparation rather than further broad product questions.
