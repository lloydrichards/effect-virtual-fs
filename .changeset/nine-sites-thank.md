---
"@effect-vfs/core": minor
"@effect-vfs/memory": minor
"@effect-vfs/persistence": minor
"@effect-vfs/nfs": minor
---

Require Effect 4.0.5 and support positioned reads, final-component `noFollow`, watch readiness, and permission-aware access checks.

Explicit read positions accept nonnegative signed-64-bit bigint offsets, including EOF beyond Number.MAX_SAFE_INTEGER, without moving the cursor. Globbing propagates closed-caller and handle failures rather than returning an empty result.

Metadata device, inode, and link-count fields now use bigint. Keep these values as bigint when comparing identities, for example `info.dev === 0n`.

Globbing now matches Unicode characters and absolute patterns, returns depth-first results, prunes exclusions before reading directories, and skips unreadable directories reached through wildcards. Named unreadable directories still fail. Directory reads may update access times. Sort returned paths explicitly when global ordering is required.

Crypto provider failures are defects. Filesystem and storage I/O failures retain their domain errors. Continue providing the matching runtime `Crypto` layer; the unreleased service split remains deferred.
