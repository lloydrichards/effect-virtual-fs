---
type: Research Report
title: NFSv4.1 server direction
description: Evaluates a separate, bounded NFSv4.1 server for exposing a live core volume, beginning with a read-only mount experiment.
status: draft
tags: [nfs, interoperability, roadmap]
sources:
  - id: nfs41
    resource: https://www.rfc-editor.org/rfc/rfc8881.html
    title: RFC 8881 NFSv4.1
  - id: nfs41-xdr
    resource: https://www.rfc-editor.org/rfc/rfc5662.html
    title: RFC 5662 NFSv4.1 XDR
  - id: rpc
    resource: https://www.rfc-editor.org/rfc/rfc5531.html
    title: RFC 5531 RPC
  - id: xdr
    resource: https://www.rfc-editor.org/rfc/rfc4506.html
    title: RFC 4506 XDR
generated: { by: codex/okf, at: 2026-09-10T12:00:00Z }
---

# NFSv4.1 server direction

No NFS design or implementation is accepted. The recommended experiment is a separate `@effect-vfs/nfs` package that depends on core and exposes a live volume read-only. Prove a real NFSv4.1 mount and read workload before committing to the protocol surface or writable access.

Core already supplies file identity, byte-preserving paths, scoped open handles, positional I/O, permissions, and coordinated mutation. A robust server would still need narrowly reusable core capabilities: opaque object references stable across rename, per-object revisions, coordinated directory observations, and selected atomic metadata or creation results. Protocol-specific filehandles, RPC, sessions, authentication, leases, replay, resource limits, and recovery belong in the NFS package.

Writable NFS is a separate decision. Volatile `sync` and explicit SQLite checkpoints do not justify durable NFS write acknowledgements. Sharing rules must also account for direct core writers; server-only bookkeeping cannot enforce mandatory restrictions across all consumers.

The retained probes established only that core object identity has some useful properties and that the installed macOS client attempted NFSv4.1 negotiation. They did not establish a successful mount, Linux interoperability, sessions, I/O, recovery, or conformance. The next gate is a successful reference-server mount with retained operation traces for listing, reading, reopen-after-change, and unmount on a pinned Linux client and the target Mac.

If the experiment proceeds, define an explicitly bounded preview profile. A successful `ls` is insufficient, and the preview must not be called a conformant NFSv4.1 server without accounting for every applicable mandatory operation, attribute, security, and recovery obligation. NFS object references must not weaken [explicit caller privilege](/decisions/explicit-caller-privilege.md "constrained by") or change [snapshot local identity](/decisions/snapshot-local-file-identity.md "constrained by").
