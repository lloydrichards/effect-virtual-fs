# Bundle update log

## 2026-09-13

- **Atomic watch registration**: Coordinated subscriber activation with volume mutations so committed events cannot be dropped while a watch is registering.

- **Byte path value semantics**: Defined opaque `BytePath` equality and hashing by its ordered bytes and added Effect-style pipe composition without exposing its representation.

- **Effect file-handle input compatibility**: Aligned negative-seek cursor preservation and required `readAlloc` runtime validation with the installed Effect `FileSystem` contract while retaining zero-default truncation.

- **NFS review corrections**: Grounded the macOS interoperability summary in issue #39 and the protocol claims in focused tests; removed the unsupported packet-trace claim.

- **Standalone NFS preview app**: Moved the runnable fixture out of the library package into a private workspace app with macOS mount, verification, troubleshooting, and cleanup instructions.

- **NFS configuration defaults**: Added frozen finite resource presets and optional server and limit overrides while retaining a complete validated runtime policy.

- **NFS schema-owned configuration**: Replaced the public interface-only limit model with Effect schemas, explicit `ByteSize` budgets, and a one-way public-to-internal normalization boundary.

- **NFS adversarial hardening**: Corrected client-incarnation recovery, negotiated channel enforcement, slot replay accounting, stateid and READDIR wire forms, session teardown, compound interruption atomicity, decode-error boundaries, and open-handle ownership; added an explicit pending-replacement limit and focused behavioral coverage.

- **Native macOS NFS evidence**: Verified mount, listing, reads, symlink traversal, hard-link identity, live VFS mutation refresh, read-only rejection, restart remount, and clean unmount; retained the privileged Linux-client gate.

- **Experimental NFS preview**: Accepted and implemented the private localhost-only read-only package boundary, core object-observation primitives, bounded RPC/XDR transport, volatile NFSv4.1 sessions and filehandles, browse/read operations, scoped server API, and runnable example. Retained the incomplete real-client browse/read gate and full RFC conformance exclusions.

- **Live object identity and revisions**: Implemented canonical volume-local object references, deletion lifetime, caller-authorized reference operations, runtime mutation revisions, and coherent owned directory observations while keeping snapshot version 1 unchanged.

## 2026-09-12

- **Effect-native snapshot limits**: Changed encoded and decoded snapshot work budgets to exact `ByteSize.ByteSize` values and kept persistence comparisons exact through SQLite.

- **Effect-native volume limits**: Changed volume, file, and path byte limits to exact `ByteSize.ByteSize` values while retaining numeric entry limits and the uint32 dense-file ceiling.

- **Effect RC 114 ByteSize adoption**: Updated the memory adapter to Effect's branded file metadata sizes and bigint seek contract, and changed snapshot-delta byte budgets to `ByteSize.ByteSize` while keeping record counts numeric.

- **Effect-native snapshot identity**: Replaced the internal SHA-256 implementation with the platform-neutral `Crypto.Crypto` service and added an explicit canonical-identity byte limit.

- **Portable snapshot deltas implemented**: Added exact base-dependent reconstruction, base-verified path inspection, an Effect Schema byte codec, canonical semantic SHA-256 identity, same-path inherited payloads, strict hostile-input validation, shared finite limits across every operation, and focused behavior evidence.

- **Portable snapshot delta interface**: Accepted an opaque exact delta with Schema encoding, path-oriented inspection, canonical semantic base identity, a dedicated base-mismatch error and shared finite resource policies. Kept wire layout and measured preset values as implementation research.

## 2026-09-10

- **Overlay parity evidence**: Recast the research scenario table as a broader parity matrix and distinguished representative executed overlay coverage from remaining cases.

- **Overlay API semantics**: Clarified reusable Effect execution, typed configuration and image failures, and the in-process scope of summary schemas containing opaque byte paths.

- **Overlay v1 implementation**: Added the snapshot-based overlay workspace contract, shared whole-file copy-on-write behavior, identity-based final summaries, paired complete capture, adapter and checkpoint evidence, and explicit remaining exclusions.

- **Overlay design consolidation**: Added issue #8 research and four accepted decision concepts covering v1 scope, base ownership, content sharing and final-difference capture. Consolidated repeated policy, separated deferred delta research, and identified remaining planning cases through independent agent reviews. Overlay implementation remains pending.

- **Checkpoint provenance**: Grounded the stable persistence decision and validation claim in the design issue, implementation, behavior tests, and separate-process restart test.

- **NFS draft concepts**: Added object-reference and mutation-revision proposals, connected them to existing contracts, and grounded the NFS direction in current implementation sources and issue discussion. Removed the claim that historical probes remain in the checkout.

- **Phase 2 provenance**: Removed legacy `.docs` resources from concept metadata. Current claims now resolve to maintained code, tests, package manifests, CI configuration, standards, or the concepts themselves.
- **Initialization**: Migrated durable project knowledge from `.docs` into an OKF v0.2 bundle while retaining `.docs` for comparison during Stage 1.
