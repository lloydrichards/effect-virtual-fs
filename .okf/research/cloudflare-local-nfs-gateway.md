---
type: Research
title: Local NFS gateway for a Cloudflare workspace
description: Proposes a private loopback mount backed by a single remote workspace owner and distinguishes it from the existing direct R2 gateway.
status: draft
tags: [nfs, cloudflare, resources, persistence]
sources:
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/154
    title: Native local mount requirements and storage follow-up
  - resource: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
    title: Worker TCP and service binding limits
  - resource: https://developers.cloudflare.com/r2/reference/consistency/
    title: Object consistency and conditional write semantics
  - resource: cloudflare-remote-agent-filesystem.md
    title: Shared remote filesystem milestone
  - resource: cloudflare-remote-volume-storage-options.md
    title: Remote storage and ownership choices
  - resource: ../../apps/demo-r2-nfs/src/gateway.ts
    title: Existing direct R2 image gateway and listener ownership
  - resource: ../decisions/persistence-store-helpers.md
    title: Store ownership, local request drainage, and remote completion uncertainty
  - resource: ../decisions/nfs/nfs-profile-ladder.md
    title: NFS listener lifecycle and profile requirements
  - resource: ../decisions/nfs/writable-export-scope.md
    title: Writable scope, NFS locking, and stable acknowledgement
---

# Local NFS gateway for a Cloudflare workspace

Start with one named workspace, one trusted workstation, and one loopback NFSv4.1 gateway. The gateway sends
authenticated filesystem requests to the authoritative service from [#153](https://github.com/lloydrichards/effect-virtual-fs/issues/153).
A second trusted TypeScript client uses the same remote service. Start with mount, lookup, list, and read after an
update through the TypeScript client. Add mount-side create and write after the remote write contract and the
applicable NFS guarantees are established.

Cloudflare documents inbound TCP between Workers through service bindings. Outside TCP clients still need a native
TCP listener elsewhere. The local gateway can use HTTPS for filesystem operations. A WebSocket is a future transport
option if the experiment needs it. Use the [remote agent access study](cloudflare-remote-agent-filesystem.md) for the
service milestone and the [Worker TCP documentation](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
for the transport boundary.

## Ownership and request path

| Component                | Responsibility                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local gateway            | Own the listener, NFS client and session state, slot replay, export identity, opens, share reservations, and locks for its mounted clients. Translate protocol requests and outcomes to and from the remote operation contract. |
| Remote workspace service | Keep one authoritative live owner per workspace and admit operations into that owner's coordinated filesystem. Apply authorization and ordering to gateway and TypeScript clients alike.                                        |
| Storage adapter          | Persist the authoritative image under its provider contract. Classify conditional rejection and uncertain completion.                                                                                                           |

Keep the gateway free of a second writable volume and of speculative read or metadata caches in the prototype. A
successful remote operation still passes through the kernel client's own lookup and attribute caching, so measure
visibility from the mounted client separately from the service. Define lookup, listing continuation, read, and
reference lifetime in the remote API before using its adapter for a mount. Use authority scoped to one workspace and
the operations under test. Bind the native listener to loopback in a trusted local environment and apply an explicit
caller policy. The gateway's remote credentials stay in the process. Choose a concrete consumer before expanding
beyond one gateway per workspace.

The existing experimental R2 app takes a different path. It opens one image under an externally controlled local
owner for the lifetime of its NFS listener. It demonstrates remote persistence behind a local NFS process. R2
conditional writes protect a committed object generation, but cannot keep two independently decoded volumes
coherent or share NFS session state. A live-image D1 binding also supplies storage rather than a remote filesystem
owner. It runs within a Worker, and the released adapter has no D1 HTTP transport for a native gateway. See the
[storage comparison](cloudflare-remote-volume-storage-options.md) and [R2 consistency documentation](https://developers.cloudflare.com/r2/reference/consistency/).

Direct TypeScript mutations use the remote service's authority and coordination, while the current NFS share
reservations and locks only cover the gateway's NFS clients. The first shared-workspace experiment makes no
cross-interface lock promise. Before accepting mixed writes, decide which operations need that promise and how
to enforce it at the authoritative service boundary.

## Interruption, reconnect, and shutdown

- **Connection loss.** Keep the NFS listener alive for a transient upstream disconnect when it can respond within
  a bounded request budget. Reconnect to the same authenticated service. Verify that the same workspace instance
  and reference identity remain valid before reusing mapped handles. Leave the NFS error mapping and kernel retry
  behavior for the prototype to qualify.
- **Missing write reply.** Keep a mutation's outcome uncertain until the remote service can resolve it. A retry
  must prove it is the same operation and recover the previous outcome without executing it twice. The remote
  protocol needs either durable operation completion records across service restart or an explicit reconciliation
  path. NFS slot replay at the local gateway alone does not supply that remote guarantee. A fresh read can precede
  a still-pending write, so it cannot establish definitive completion on its own.
- **Gateway restart.** Await listener termination and surface serving failure to the local operator. Stop admission
  and drain pending gateway transport work before closing its client. The service remains the workspace owner. A
  local drain only establishes that local work settled. Remote uncertainty still needs reconciliation. Treat a
  gateway restart that loses its in-memory state as
  a remount case for this milestone. Persistent file reference keys do not restore sessions, opens, or locks.
- **Remote restart.** Reopen the authoritative image through the service's ownership protocol and check its
  generation and workspace identity. Reject old handles if the service cannot preserve or verify their identity.
  Qualify warning and recovery behavior with an actual kernel client before offering unattended reconnect.

## Qualification and open decisions

1. After the remote API is concrete, demonstrate two trusted TypeScript clients working against the same workspace,
   including a remote service restart. Select the one workstation, filesystem tool, and backend to qualify.
2. Mount a read-only export in the private local environment. List a directory, read a file with an unmodified tool,
   update it through the TypeScript client, and record when the mount observes the update. Compare local gateway
   latency with direct remote calls. Separate cold mount, steady-state operations, reconnect, and remount. Record
   operation counts, request and response sizes, and latency percentiles under a representative workload before
   setting bounds.
3. Once write acknowledgement and remote retry semantics are reviewed, trace native create, write, and read on a
   disposable workspace. Compare visible bytes and outcomes after both process restarts, known rejection, and a
   deliberately withheld reply in a controlled fixture. Keep mount state and authoritative image checks separate.
4. Before advertising the existing writable profile, show that a successful reply follows durable storage of
   both data and metadata at `FILE_SYNC4` strength on the exact provider configuration. The R2 experiment's
   verified endpoint and single-owner conditions do not carry over automatically through a remote service. The
   current D1 and PostgreSQL profiles are `memory-only`. Use read-only export for providers below the existing
   writable requirement. A weaker writable profile would require its own reviewed protocol decision.

The remote operation interface, error mapping, latency budget, cross-interface lock semantics, and provider
qualification remain open. Track protocol recovery and writable release requirements in their existing gates.
