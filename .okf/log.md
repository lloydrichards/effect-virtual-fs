# Bundle update log

## 2026-09-10

- **Overlay design consolidation**: Added issue #8 research and four accepted decision concepts covering v1 scope, base ownership, content sharing and final-difference capture. Consolidated repeated policy, separated deferred delta research, and identified remaining planning cases through independent agent reviews. Overlay implementation remains pending.

- **Checkpoint provenance**: Grounded the stable persistence decision and validation claim in the design issue, implementation, behavior tests, and separate-process restart test.

- **NFS draft concepts**: Added object-reference and mutation-revision proposals, connected them to existing contracts, and grounded the NFS direction in current implementation sources and issue discussion. Removed the claim that historical probes remain in the checkout.

- **Phase 2 provenance**: Removed legacy `.docs` resources from concept metadata. Current claims now resolve to maintained code, tests, package manifests, CI configuration, standards, or the concepts themselves.
- **Initialization**: Migrated durable project knowledge from `.docs` into an OKF v0.2 bundle while retaining `.docs` for comparison during Stage 1.
