---
type: Research Report
title: NFS WRITE and COMMIT design for issue 127
description: Records protocol requirements, the staged WRITE and COMMIT handler, accepted decisions, and prerequisites for a durable NFS export.
status: draft
tags: [nfs, write, durability, replay]
sources:
  - id: issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/127
    title: Durable WRITE and COMMIT issue
  - id: rfc-write
    resource: https://www.rfc-editor.org/rfc/rfc8881.html#section-18.32
    title: RFC 8881 WRITE
  - id: rfc-commit
    resource: https://www.rfc-editor.org/rfc/rfc8881.html#section-18.3
    title: RFC 8881 COMMIT
  - id: rfc-replay
    resource: https://www.rfc-editor.org/rfc/rfc8881.html#section-2.10.6
    title: RFC 8881 session replay
  - id: dispatcher
    resource: ../../../packages/nfs/src/internal/nfs4.ts
    title: NFS operation decoder and dispatcher
  - id: export
    resource: ../../../packages/nfs/src/internal/export.ts
    title: NFS to core export adapter
  - id: core
    resource: ../../../packages/core/src/internal/virtualFileSystem.ts
    title: Core positional writes and live commit boundary
  - id: live
    resource: ../../../packages/core/src/LiveVolume.ts
    title: Provider-neutral live image store
  - id: public
    resource: ../../../packages/nfs/src/NfsServer.ts
    title: Public NFS export options
  - id: tests
    resource: ../../../packages/nfs/test/NfsWrite.test.ts
    title: Internal WRITE and COMMIT wire tests
generated: { by: codex/okf, at: 2026-09-19T20:09:53Z }
---

# NFS WRITE and COMMIT design for issue 127

This is research for [issue #127](https://github.com/lloydrichards/effect-virtual-fs/issues/127), not an accepted implementation decision. The accepted [writable export scope](../../decisions/nfs/writable-export-scope.md "constrained by") requires every successful write to reach `FILE_SYNC4` strength before its reply. The [live durable volume proposal](../live-durable-volume.md "constrained by") records the storage and replay prerequisites.

## Protocol facts

- `WRITE` receives the current filehandle, stateid, offset, requested stability, and data. Success reports the actual byte count, achieved stability, and an eight-byte verifier. A short write is valid; a zero-byte write succeeds after permission checks and should not change modification or change attributes. A server may report `FILE_SYNC4` for a weaker request, but must make the data and all file metadata stable first.[^rfc-write]
- A normal `WRITE` stateid identifies an open or lock owner. All-zero and all-ones special stateids have separate rules; neither can bypass applicable share or mandatory lock checks. Wrong target types have specific statuses.[^rfc-write]
- `COMMIT` has no stateid argument. Its offset and count select a range; count zero means from offset to end of file. Nothing pending to flush is success unless another error occurs. Success returns the verifier.[^rfc-commit]
- The verifier remains fixed for one NFS server instance and must be unique between instances, even if they share one live volume. It also changes whenever uncommitted data could be lost. A retried request in an NFSv4.1 session must not repeat an already executed write.[^rfc-write][^rfc-commit][^rfc-replay]

## Current implementation

The decoder accepts bounded `WRITE` data and `COMMIT` arguments. An internal `writable` handler validates ordinary open and lock stateids, write access and stability mode, calls the held writable handle's `pwrite`, and reports its returned count with `FILE_SYNC4`. An `OPEN` upgrade retains one read handle and one write handle at most, including across downgrades. `COMMIT` checks a regular file and returns the same verifier. The handler hashes the server generation and volume incarnation with SHA-256 and uses the first eight bytes; this avoids a direct XOR cancellation when both generations change. Wire tests cover short and zero writes, both upgrade orders, repeated downgrades, verifier changes, rejected and unknown storage outcomes, commit-before-reply ordering, and replay. The public server still has no writable option and passes no `writable` flag. The current live provider reports `memory-only`, so the internal handler is preparation, not a qualified public `FILE_SYNC4` service.[^dispatcher][^export][^core][^live][^public][^tests]

## Prerequisites and likely implementation path

Issue #124's lock and stateid changes are present in the local dispatcher. Issue #123's replay preparation is complete. Issues #122, #125, and #126 remain for bounded admission, writable creation, and namespace and metadata mutations. Issue #129 must qualify a provider for the required failure boundary. The public writable profile also needs independent client and fault evidence under #51.

The remaining public path must enforce the `survives-power-loss` startup gate, use the explicit one-user authorization policy, and enable internal writable dispatch only after the complete writable profile's prerequisites. An unknown commit outcome now returns no success and leaves the core volume unavailable; a later `PUTFH` returns `SERVERFAULT`, which is valid for that operation. Persistent reply recovery still belongs to #50.[^dispatcher][^export][^core][^live][^rfc-replay]

## Accepted decisions and protocol rules

1. **Accepted for the first writable profile:** require an `OPEN` or lock stateid for `WRITE`; reject all-zero and all-ones special stateids. The compound's current stateid may resolve to an ordinary valid stateid. RFC 8881 permits but does not require servicing the special forms.[^rfc-write]
2. **Accepted for the first writable profile:** server creation fails with a configuration error when an explicitly writable export receives a volume whose durability is below `survives-power-loss`. Provider qualification under issue #129 is still required before any implementation can claim that tier; a self-reported value alone is not evidence.[^live]
3. **Resolved by the protocol:** `COMMIT` has no `INVAL` or `BAD_RANGE` status in RFC 8881 Section 15.2. The synchronous profile has no unstable range to flush, so it need not add offset and count or reject their mathematical overflow. It still checks the filehandle, file type, and provider health.[^rfc-commit]
4. **Implemented internally:** a definite storage rejection returns `IO` without publishing the candidate. An unknown outcome returns no success and stops the volume until reconstruction. The next `PUTFH` returns `SERVERFAULT`; focused tests cover both outcomes.[^live][^dispatcher][^tests]
5. **Accepted and implemented internally:** the [volume facts decision](../../decisions/core/volume-durability-and-usage-facts.md "refines") now requires a verifier that depends on both the volume incarnation and a fresh NFS server generation. The handler and tests use that rule.[^rfc-write][^dispatcher][^tests]
6. **Accepted scope:** session replay prevents a second execution within one running server. A server restart requires remounting for this milestone; persistent session and reply recovery belongs to issue #50.[^rfc-replay]

[^rfc-write]: RFC 8881 Section 18.32 defines the arguments, result, stability, short and zero writes, stateids, type errors, and verifier.

[^rfc-commit]: RFC 8881 Section 18.3 defines COMMIT range and no-pending-data behavior.

[^rfc-replay]: RFC 8881 Section 2.10.6 defines session replay and its limits.

[^dispatcher]: `decodeOperation`, `case "Write"`, and `case "Commit"` in `nfs4.ts`.

[^export]: `NfsExport.open` in `export.ts`.

[^core]: `FileHandle.pwrite` and `openImageVolume` in the core engine.

[^live]: `LiveImageStore` and `LiveVolume.open` in `LiveVolume.ts`.

[^public]: `NfsServerOptions` and `make` in `NfsServer.ts`.
