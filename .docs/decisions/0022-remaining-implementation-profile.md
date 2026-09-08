# Remaining implementation profile

Status: implementation policy, 9 September 2026, under the user's instruction to continue implementing and committing
until the accepted scope is complete. This records concrete choices rather than adopting every research example.

## Regular files

Use bigint offsets and lengths, with offsets from zero through signed 64-bit maximum. Transfers accept nonnegative
safe-integer counts and return owned bytes. Dense storage supports files up to 4294967295 bytes by default; optional
maxFileBytes can lower that implementation ceiling. maxBytes is an optional nonnegative safe-integer logical quota,
without a configured cap by default. These limits do not reserve or bound JavaScript heap memory.

Charge logical length, including zero-filled gaps, once per inode. Return the prefix fitting both the file ceiling
and volume quota. A nonempty write with no progress fails FileTooLarge if its position reaches the file ceiling,
otherwise NoSpace. Truncation preflights the whole growth and leaves state unchanged on failure. Zero transfers
validate access and arguments but change neither content nor offset nor timestamps. Nonzero read requests mark atime;
nonempty writes and every successful truncate mark mtime/ctime. Writes and truncates clear set-ID bits for all callers.

Open supports read/write/readWrite, never/ifMissing/exclusive creation, writable-only append/truncate, and optional
mode only with creation. New files use caller uid, parent gid, mode 0666 masked by umask, and ignore special bits.
Access is granted at open and is not rechecked during I/O. Scope cleanup releases once, explicit repeat-close fails,
and unlinked-open content remains charged until final close. sync validates liveness and provides no durability.

Core supports dense DATA/HOLE seek. Before EOF, DATA returns the requested position and HOLE returns EOF. At or past
EOF both fail NoData, preserving offset. pwrite uses the supplied position even on append handles. Sequential append
advances core offset; truncation never clamps it. Adapter cursor compatibility remains a separate requirement.

The same volume permit coordinates file I/O, namespace operations, metadata, and later snapshot capture. Expected
failures precede publication. Interruption after publication still does not mean rollback, as in decision 0020.

## Evidence

File.test.ts exercises ownership, separate offsets, seek/truncate, append concurrency, quota crossing, failed growth,
unlinked charge retention, scope closure, exclusive creation, access and kind failures. Initial failures reflected
missing APIs and configuration fields, not a demonstrated production regression.

## Links and enumeration

Hard links may name files or symlinks, never directories. The default source policy links the symlink itself;
followSourceSymlink explicitly selects its target. Symlink target bytes are charged once per inode, survive
dangling references, and are not validated as paths at creation. Empty targets are allowed; NUL and malformed string
encoding are rejected. Component and expansion bounds apply when following the link. Creation uses mode 0777 without umask.
Traversal follows at most 40 links and counts exact target-plus-suffix bytes, including repeated separators, before
allocating the expansion. No-follow open of a final symlink fails SymlinkLoop; exclusive creation never follows it.

Directory enumeration returns a whole-list observation under coordination, omits implicit dot entries, and promises
no ordering. It requires read permission on the selected directory and updates atime. Raw name/target outputs are
copies. String names, targets, and real paths use fatal UTF-8 decoding with BOM preserved; unrepresentable bytes fail
UnrepresentableName. realPath outputs may exceed maxPathBytes; that option bounds input/expansion, not output.

Links.test.ts covers aliases and replacement, dangling-target creation, final-link mutation, symlink-before-dot-dot,
loop and exact expansion limits, quota retention, and strict independently owned byte results. Full workspace
validation logs are retained under .docs/evidence/links. The official Issue 8 link/symlink descriptions were fetched
and read; this records the selected behavior, not exhaustive POSIX conformance.

## Metadata and authority

chmod/chown/utimes act on targets by default and accept followFinalSymlink false for own-link updates. The Handle
variants validate a live same-volume capability but use the invoking caller's identity, including for unlinked files.
chmod requires owner or privilege; unprivileged regular-file chmod clears set-group-ID for a group outside the caller's
groups. chown is restricted: only privilege changes uid; owners can retain uid and select a caller group. All regular
file ownership changes clear set-ID bits. An empty owner update validates ownership then makes no change.

Times use explicit now/omit/value variants with bigint epoch nanoseconds. Both omitted are a validated no-op. Both now
allow owner, privilege, or write access; other updates require owner or privilege. One clock sample supplies requested
now fields and ctime. chmod marks ctime even for unchanged mode. Birthtime remains creation time. access accepts bits
0 through 7; explicit privilege does not grant regular-file execution unless some execute bit is set.

Metadata.test.ts verifies these authority boundaries, open-time access survival, own-link updates, foreign/closed
handles, path truncation, timestamp omission, and failed growth. Full checks are in .docs/evidence/metadata.

## Snapshots and fixtures

Snapshot v1 uses format effect-vfs, version 1, a root ID, and directory/file/symlink records. Runtime inode numbers
and link counts are derived on restoration. Metadata stores canonical decimal nanoseconds, bounded to 128 digits
to avoid unbounded bigint parsing. ID strings are nonempty and at most 128 characters. Base64 is padded and canonical.
All schema objects reject unknown fields. Decoding requires explicit maxEncodedBytes/maxRecords/maxEntries/
maxDecodedBytes limits; the decoded budget includes names and symlink targets. Limits bound input work, not exact heap
usage. Field-shape/numeric failures are InvalidStructure; invalid UTF-8/JSON/base64 is InvalidEncoding. Graph validation
rejects duplicate IDs/names, missing references, directory aliases/cycles, unreachable records, invalid byte names,
and NUL in targets. Symlink cycles and dangling targets are valid stored content.

Opaque snapshots retain an owned validated image. Capture copies content into immutable base64 strings under volume
coordination, so same-length overwrites cannot change it. Encoding returns owned UTF-8 bytes. Each restore decodes
independent storage and checks destination file/byte/entry limits before allocating file buffers. Existing volumes
are never replaced. Image-local hard-link relationships survive; live resources and unreachable content do not.

Fixtures are absolute final-state declarations with explicit parents and forward hard-link references. Dot components,
collisions, missing parents, directory hard links, and alias cycles fail before exposure. Repeated separators compare
by resulting byte components. Defaults are uid/gid zero, epoch-zero timestamps, directory 0755/file 0644/link 0777.
Optional metadata is final, without umask. Root metadata is separate. File input bytes are captured at execution,
with shared and detached buffers rejected. Snapshot.test.ts and .docs/evidence/snapshots record behavioral evidence.

## Memory adaptation and observation

Memory now depends on core and retains no separate inode/path/storage implementation. make creates a fresh volume
with /tmp; bind constructs a caller on an existing volume without altering its tree. Default bindings use explicit
privilege and umask zero with the adapter's 0644/0755 creation modes. Optional RootCallerOptions permit explicit
credentials. The package remains private while core is private.

Adapter handles maintain their own cursor: appending preserves it; non-append handle truncation clamps it; append
handle and path truncation preserve it. Closed seek returns zero; negative seek is retained and nonempty I/O rejects
it. The no-error seek signature remains unchanged. Stable shared-memory input is copied at the adapter boundary.
Core whole-file read/write helpers keep each whole-file transfer atomic. Whole-file writes preflight all capacity
and preserve an existing inode, content, and metadata on expected failure. They publish one create/update event.
Recursive mkdir/remove/copy and temporary helpers compose individual core operations; they are not transactions
against direct-core or other-binding writers. No atomic multi-call transaction is part of the core profile.

Volume.watch acquires a scoped stream of committed byte-path create/update/remove events. It has an unbounded
subscription buffer, no replay, and no silent overflow drops. Scope exit unsubscribes. Metadata and content writes
publish every reachable alias; rename publishes remove/create. Events contain no mutable volume storage. Adapter
watchers filter by raw path before strict UTF-8 conversion, so unrelated non-UTF-8 names do not terminate a watch.
An unrepresentable relevant path fails the stream with InvalidData.

Core capacity/size/resource failures map to adapter BadResource; permission to PermissionDenied, encoding to
InvalidData, and invalid numeric arguments to BadArgument. Missing/existing names preserve NotFound/AlreadyExists.
The adapter retains its trailing-slash directory-rename compatibility while core keeps the stricter destination
rule. Error operation/path context follows the existing suite.

All 89 existing memory tests pass through core. CoreBinding.test.ts adds sharing, direct-core watches, alias events,
atomic quota rejection, strict byte filtering, copy topology/timestamps, and source-observed cursor cases. The first
migration and two focused regression logs are retained under .docs/evidence/adapter.
