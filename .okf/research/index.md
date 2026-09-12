# Research

- [Bounded POSIX requirements](posix-requirements.md) records the standards frame used to define and test the core without claiming full POSIX conformance.
- [Effect adapter compatibility](effect-compatibility.md) identifies the behavior the memory adapter must preserve over the core.
- [NFSv4.1 server direction](nfs-server.md) is draft research for exposing live volumes to native tools.
- [Overlay filesystem direction](overlay-filesystem.md) maps current implementation constraints, behavior evidence and unresolved planning cases to the accepted decisions.
- [Snapshot delta representation research](overlay-changes.md) retains the wire-layout, measurement and validation work needed by the accepted public interface.

- [Object references](object-references.md) proposes path-independent identity with caller authority.
- [Mutation revisions](mutation-revisions.md) proposes reliable change tracking and coordinated observations.

Path-workload measurements are not a separate concept. Their durable conclusion is represented by the accepted optional total-path-limit decision: repository workloads do not justify a universal fixed cap.
