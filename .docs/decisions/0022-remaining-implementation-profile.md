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
