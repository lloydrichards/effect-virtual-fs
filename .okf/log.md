# Bundle update log

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
