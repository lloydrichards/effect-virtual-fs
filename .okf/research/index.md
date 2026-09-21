# Research

- [Bounded POSIX requirements](posix-requirements.md) records the standards frame used to define and test the core without claiming full POSIX conformance.
- [Effect adapter compatibility](effect-compatibility.md) retains the reasoning behind the adapter boundary that the memory-adapter contract now owns.
- [Overlay filesystem direction](overlay-filesystem.md) retains the alternatives considered for overlay v1 and the parity cases a future harness should cover.
- [Snapshot delta representation research](overlay-changes.md) retains the open delta questions: compressed encodings, checkpoint storage, profiling, and merge or rebase.
- [Live durable volume proposal](live-durable-volume.md) records the staged core mutation boundary and proposes a bounded storage provider, with crash recovery and NFS replay prerequisites.
- [Cloudflare Durable Object live image store](cloudflare-durable-object-live-image.md) examines the storage adapter, native NFS gateway, and durability evidence needed for a Cloudflare-backed volume.
- [Cloudflare remote volume storage options](cloudflare-remote-volume-storage-options.md) compares DO SQLite, D1, and R2 for a remotely accessible volume with replaceable storage.
- [Remote agent filesystem access through Cloudflare](cloudflare-remote-agent-filesystem.md) separates a TypeScript remote client from a native NFS mount and compares feasible connection paths.

## NFS export

- [NFSv4.1 server direction](nfs/nfs-server.md) retains the accepted read-only direction and the macOS interoperability result.
- [NFS operations ledger](nfs/nfs-operations-ledger.md) maps every RFC 8881 operation to profile, status, and follow-up issue.
- [NFS attributes ledger](nfs/nfs-attributes-ledger.md) does the same for REQUIRED and RECOMMENDED attributes.
- [NFS protocol rules ledger](nfs/nfs-protocol-rules-ledger.md) covers cross-cutting requirements, errata, and the client matrix.
- [NFS WRITE and COMMIT design](nfs/write-commit-issue-127.md) records protocol facts, staged behavior, accepted decisions, and remaining prerequisites for issue #127.
- [NFS OPEN creation](nfs/open-create-issue-125.md) records all four internal create modes, atomic verifier storage, and the remaining public release gates.
- [NFS namespace and metadata mutations](nfs/namespace-metadata-issue-126.md) records internal CREATE, LINK, REMOVE, RENAME, and SETATTR behavior and its wire evidence.

Path-workload measurements are not a separate concept. Their durable conclusion is represented by the accepted optional total-path-limit decision: repository workloads do not justify a universal fixed cap.
