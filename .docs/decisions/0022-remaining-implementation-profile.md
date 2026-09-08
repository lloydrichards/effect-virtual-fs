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
