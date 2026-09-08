# Explicit close and scope cleanup

Status: accepted, 8 September 2026. Resolves repeated-close behavior in D09.

## Decision

Explicitly closing a live file or directory handle releases it. A subsequent explicit `close()` on that handle fails
with the invalid-handle error. Automatic scope cleanup tolerates a handle already released by explicit close.

Use a private release path for scope cleanup rather than swallowing arbitrary close errors. Reference release and
any final storage reclamation must happen exactly once. This does not add a public close method to Effect's existing
`FileSystem.File` interface or settle whether callers themselves expose explicit close.

## Example

A program opens a scoped file, uses it, and explicitly closes it early. Leaving the scope succeeds. If the program
instead explicitly calls `close()` twice, the second call fails, making the lifetime mistake visible.

## Tradeoffs and basis

The user accepted the distinction between deliberate close calls and automatic cleanup. Idempotent public close
would simplify repeated manual cleanup but could hide accidental reuse. Strict public close exposes that mistake
while tolerant finalization supports early release within a scope.

The [I/O research](../context/posix-io-contract.md) verifies invalid-close behavior and distinguishes it from Effect
scope cleanup. The [resource model](0011-independent-resource-lifetimes.md) defines independent ownership.

## Remaining contracts and evidence

Specify the concrete error shape, foreign-volume validation, and close-versus-operation ordering with the operation
commit model. Unexpected cleanup defects must not be silently converted to success. This decision does not authorize
ignoring general finalizer failures.

Required cases cover first explicit close, repeated explicit close, early close followed by scope cleanup, invalid
operations after close, and exactly-once release of unlinked file storage. No implementation or runtime tests were
added for this decision.
