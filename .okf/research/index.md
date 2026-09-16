# Research

- [Bounded POSIX requirements](posix-requirements.md) records the standards frame used to define and test the core without claiming full POSIX conformance.
- [Effect adapter compatibility](effect-compatibility.md) identifies the behavior the memory adapter must preserve over the core.
- [NFSv4.1 server direction](nfs-server.md) retains the accepted read-only direction and the macOS interoperability result.
- [NFS operations ledger](nfs-operations-ledger.md) maps every RFC 8881 operation to profile, status, and follow-up issue.
- [NFS attributes ledger](nfs-attributes-ledger.md) does the same for REQUIRED and RECOMMENDED attributes.
- [NFS protocol rules ledger](nfs-protocol-rules-ledger.md) covers cross-cutting requirements, errata, and the client matrix.
- [Overlay filesystem direction](overlay-filesystem.md) retains the alternatives considered for overlay v1 and the parity cases a future harness should cover.
- [Snapshot delta representation research](overlay-changes.md) retains the open delta questions: compressed encodings, checkpoint storage, profiling, and merge or rebase.

Path-workload measurements are not a separate concept. Their durable conclusion is represented by the accepted optional total-path-limit decision: repository workloads do not justify a universal fixed cap.
