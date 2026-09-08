# Path input policy

Status: accepted, 8 September 2026. Resolves input representation and selected resolution choices in D02 and POSIX-P01 through POSIX-P06.

## Decision

Encode well-formed JavaScript string paths as UTF-8. Reject lone surrogates, embedded NUL, and empty paths.
Byte paths preserve exact bytes, including names that are not valid UTF-8; reject embedded NUL and empty byte paths.

Use slash as the separator on every runtime. Backslash is an ordinary filename character. Repeated slashes act as one
separator during lookup, including exactly two leading slashes. Resolve dot and dot-dot during lookup, with dot-dot
at root remaining at root. Preserve trailing slashes so each operation enforces its directory requirement.

Do not apply case folding, Unicode normalization, URI decoding, or platform-specific expansion. Byte-path construction
must not lexically collapse components. Its owned representation can preserve repeated separators even though lookup
treats them equivalently.

The user accepted these rules after reviewing the [path contract](../context/path-and-base-contract.md).

## Examples and consequences

`/../work`, `//work`, and `///work` resolve to `/work`. A trailing slash on a regular file fails the directory
requirement. `link/../child` must resolve the link before interpreting the following dot-dot component when symlink
support is implemented. A constructor cannot replace this with lexical normalization.

The same inputs have the same interpretation across supported runtimes. Consumers must explicitly convert Windows-style
paths or malformed strings. Different Unicode spellings remain different byte names. Strict string filename output
continues to follow decision 0003; invalid UTF-8 byte names are not silently replaced.

## Remaining work and evidence

This policy does not settle raw symlink target validation, component/path byte limits, symlink traversal limits,
shared-memory-backed inputs, or exact constructor-versus-operation error mapping. Input ownership follows decision 0012.

Required cases cover rejected empty/NUL/lone-surrogate inputs, lossless byte names, literal backslash and percent
characters, distinct Unicode spellings, repeated separators, root dot-dot, trailing slash requirements, and symlink
resolution before dot-dot. No core implementation or runtime filesystem evidence was added by this decision.
