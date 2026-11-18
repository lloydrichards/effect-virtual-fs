---
type: Research
title: Remote agent filesystem access through Cloudflare
description: Separates TypeScript filesystem access across hosts from native NFS transport and records Cloudflare's current network boundary.
status: draft
tags: [cloudflare, nfs, agents]
sources:
  - id: worker-protocols
    resource: https://developers.cloudflare.com/workers/reference/protocols/
    title: Workers supported protocols
  - id: worker-tcp
    resource: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
    title: Workers TCP sockets
  - id: do-websockets
    resource: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
    title: Durable Object WebSockets
  - id: do-rpc
    resource: https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
    title: Durable Object RPC and coordination
  - id: workspace-issue
    resource: https://github.com/lloydrichards/effect-virtual-fs/issues/153
    title: Shared workspace requirements and ownership discussion
  - id: do-storage
    resource: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
    title: Durable Object SQLite storage and transactions
  - id: local-replay
    resource: ../../packages/persistence/test/CheckpointStore.test.ts
    title: Local SQLite image and replay transaction qualification
  - id: do-lifecycle
    resource: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
    title: Durable Object activation and eviction behavior
  - id: do-gates
    resource: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
    title: Durable Object storage gates and request interleaving
  - id: spectrum-plan
    resource: https://developers.cloudflare.com/spectrum/
    title: Spectrum product and plan boundaries
  - id: spectrum
    resource: https://developers.cloudflare.com/spectrum/reference/configuration-options/
    title: Spectrum configuration options
generated: { by: codex/okf, at: 2026-11-17T23:17:18+01:00 }
---

# Remote agent filesystem access through Cloudflare

## Goal

Let TypeScript agents on different hosts use the same remote filesystem, ideally through a familiar filesystem interface. There are two distinct client experiences: an application-level TypeScript filesystem client, and an operating-system NFS mount. The former can use Cloudflare's HTTP/WebSocket entry points. The latter needs a TCP-speaking NFS endpoint.[^worker-protocols][^do-websockets]

## Network boundary

Cloudflare Workers currently expose outbound TCP through `connect()`, but cannot accept inbound arbitrary TCP. The outbound socket API does not turn a Worker or Durable Object into an NFS listener. Workers can receive TCP passed by another Worker over a service binding, while the TCP documentation describes inbound support from other sources as forthcoming.[^worker-tcp] A Durable Object can accept a WebSocket forwarded by a Worker and coordinate multiple clients, including hibernating idle connections. It can also receive RPC calls from Workers, but that RPC is internal to Cloudflare's Worker/DO environment; an outside agent needs a reachable HTTP or WebSocket endpoint.[^do-websockets][^do-rpc]

Spectrum can proxy TCP to an external origin, potentially including an NFS server running elsewhere. Its TCP mode passes application bytes through and does not invoke Workers. It therefore does not make a Worker or Durable Object accept NFS traffic. Custom TCP applications also require an Enterprise plan and paid Spectrum add-on.[^spectrum][^spectrum-plan]

## Feasible shapes

| Shape                                                                                 | Client experience                                                            | What it proves                                                         | Main work left                                                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare Worker/DO serves filesystem operations over HTTPS or WebSocket             | Agents use a TypeScript remote filesystem client                             | Shared operations across hosts, with one deployable Cloudflare service | Design operation API, authentication, concurrency, storage, and reconnect behavior                                                         |
| Local TypeScript NFS server forwards operations to Cloudflare over HTTPS or WebSocket | OS and tools mount `localhost` with NFS; remote service owns filesystem data | Familiar local file tools operating on a remote Cloudflare filesystem  | Gateway mapping, latency, caching, NFS session state, error translation, and write acknowledgment                                          |
| Local TypeScript NFS server calls R2/D1 directly                                      | OS mounts `localhost`; local process reaches Cloudflare storage              | Remote persistent storage behind local NFS                             | Cross-host write coordination, shared filesystem semantics, stale caches, credentials; storage API alone is not a remote filesystem server |
| External NFS origin behind Spectrum                                                   | OS mounts a public TCP endpoint                                              | Native NFS can pass through Cloudflare's L4 proxy                      | Own/operate an NFS process outside Workers; Spectrum product and plan constraints                                                          |

The first shape is the shortest path to the agent use case. The second adds native OS file tooling without waiting for inbound TCP on Workers. A WebSocket byte tunnel for NFS still needs a local TCP adapter, so it does not avoid the gateway. Routing filesystem operations over HTTP or WebSocket may make error handling and versioning easier than tunneling raw NFS bytes; that is a design hypothesis to test, not a Cloudflare guarantee.

## Proposed private workspace service

Start with two trusted TypeScript clients and one named workspace. A Worker accepts authenticated HTTPS requests, resolves the authenticated principal and workspace membership, and sends validated operations to the workspace's Durable Object. Start with list, read, and bounded whole-file create and replacement. Keep the application API narrow until a consumer needs handles, streaming, watch delivery, or a full Effect `FileSystem` adapter. The [local mount milestone](https://github.com/lloydrichards/effect-virtual-fs/pull/420) builds on this service contract as separate work tracked in [#154](https://github.com/lloydrichards/effect-virtual-fs/issues/154).

### Identity and authority

Resolve a display name or alias through application metadata to a canonical workspace ID. Include the tenant in the namespace or canonical key and route every client and alias to the same Durable Object identity. A workspace deleted and recreated under the same name gets a different ID. Keep the namespace stable across deployment updates, and separate production and test namespaces. Persist the workspace identity with the image so reopening can reject a mismatched record. A registry in one Worker isolate can manage resources for that isolate. Ownership of the workspace belongs to the designated Durable Object.

Authenticate at the Worker, check workspace membership and operation permissions for each request, and pass verified identity through the internal binding. The owner selects a confined VFS caller from that authority and applies the same policy to both clients. Clients never supply caller privileges, a raw storage key, or a namespace binding. Validate request shape, paths, and payload limits before work begins. Define how long a list cursor is valid and what a later read may observe after intervening writes.

### Owner activation and publication

Give each active object instance a single initialization path. Open the persisted image before admitting operations and retain the volume scope for that activation. Each request has its own caller resources. Cloudflare can discard memory on hibernation or eviction, so recovery must reopen the verified image from storage. An in-memory scope finalizer is useful for deliberate shutdown. Recovery correctness must hold when the old instance gets no cleanup opportunity. A failed reopen must surface as a failure rather than creating an empty workspace over existing state. [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

The owner admits mutations through the existing VFS coordination boundary, even where request handlers can interleave around asynchronous work. Use an explicit revision precondition for a read-edit-write test once that surface is selected. Concurrent unconditional replacements can overwrite each other under serialized ownership. Agent proposals that need isolation can use execution-owned overlays and explicit merge, a different workflow from writing directly to the shared volume.

SQLite-backed Durable Object storage is a candidate for a compact image and its operation outcomes because both can be stored in one transaction. The prototype must prove that the existing staging and publication hook can commit the image generation and replay result atomically, then acknowledge only after the provider confirms the selected storage boundary. Store the outcome for an operation ID bound to workspace, principal, operation, and request content. A valid retry returns the recorded result, and conflicting reuse fails. The server must enforce a finite replay window, including across reactivation. Expired operation IDs require reconciliation and cannot be admitted again as new writes. In-memory completion tracking and the provider's response gate alone do not resolve a lost reply. An R2 or D1 image with a replay ledger in a different store needs a separate atomicity or reconciliation design. Keep existing adapter guarantees unchanged. [DO SQLite transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync), [DO input and output gates](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).

On returned rejection, preserve the previous published image. On uncertainty, stop admitting writes for that owner until the storage outcome has been reconciled. Client cancellation stops waiting. It proves neither cancellation nor completion of an admitted commit. A workspace snapshot captures filesystem state, and an executor must qualify resumption and external tool effects under a separate contract.

### Local transaction qualification

The persistence test uses the pinned Bun SQLite client and public CheckpointStore to save real encoded
VFS snapshots. One transaction advances a named workspace's head, saves its image, and records the operation
result. After closing and reopening the connection, an exact retry returns the recorded generation even
after a later write. Reusing an operation ID with different bytes or a different principal leaves the
head unchanged. Stale generations are rejected. Aborting after all three writes leaves the prior head
readable, the candidate checkpoint absent, and the operation ID available for a subsequent commit.

Run the local qualification after building the persistence package and its dependencies.

```sh
bun run --cwd packages/persistence test CheckpointStore.test.ts
```

This qualifies transaction composition with CheckpointStore on one local SQLite file. The production
LiveVolume commit hook, hosted Durable Object activation, replay expiry, and crash durability remain
separate qualification steps.

### Acceptance evidence

- From two independent hosts, resolve the same workspace through the allowed aliases. Create a file from one client, read and update it from the other, and observe the update from both. Check that a principal outside the workspace cannot read or mutate it.
- Run concurrent replacements and a stale guarded edit once the guard semantics are chosen. Record acknowledged order, content, and generation. Confirm unrelated workspace ownership remains separate.
- Reinstantiate the owner against the same persisted state. Check exact reopened content and workspace identity. Simulate a lost successful reply. Retry the same operation ID before and after reactivation and check one application, one generation change, and the original outcome.
- Exercise known rejection, uncertain completion, retry expiry, and a recreation with a new workspace ID. Record runtime, backend, size limits, and what each acknowledgement proves. Keep mounted-client behavior and stronger durability claims for their own qualification.

No hosted run, storage selection, or remote filesystem interface has been qualified by this design.

[^worker-protocols]: [Workers supported protocols](https://developers.cloudflare.com/workers/reference/protocols/).

[^worker-tcp]: [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).

[^do-websockets]: [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

[^do-rpc]: [Durable Object coordination and RPC](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/).

[^spectrum]: [Spectrum configuration options](https://developers.cloudflare.com/spectrum/reference/configuration-options/).

[^spectrum-plan]: [Spectrum plans](https://developers.cloudflare.com/spectrum/).
