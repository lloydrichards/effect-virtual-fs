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
  - id: spectrum
    resource: https://developers.cloudflare.com/spectrum/reference/configuration-options/
    title: Spectrum configuration options
generated: { by: codex/okf, at: 2026-09-21T09:30:00Z }
---

# Remote agent filesystem access through Cloudflare

## Goal

Let TypeScript agents on different hosts use the same remote filesystem, ideally through a familiar filesystem interface. There are two distinct client experiences: an application-level TypeScript filesystem client, and an operating-system NFS mount. The former can use Cloudflare's HTTP/WebSocket entry points. The latter needs a TCP-speaking NFS endpoint.[^worker-protocols][^do-websockets]

## Network boundary

Cloudflare Workers currently expose outbound TCP through `connect()`, but cannot accept inbound arbitrary TCP. The outbound socket API does not turn a Worker or Durable Object into an NFS listener. Cloudflare's documentation says inbound TCP support is forthcoming, without a date.[^worker-tcp] A Durable Object can accept a WebSocket forwarded by a Worker and coordinate multiple clients, including hibernating idle connections. It can also receive RPC calls from Workers, but that RPC is internal to Cloudflare's Worker/DO environment; an outside agent needs a reachable HTTP or WebSocket endpoint.[^do-websockets][^do-rpc]

Spectrum can proxy TCP to an external origin, potentially including an NFS server running elsewhere. Its TCP mode passes application bytes through and does not invoke Workers. It therefore does not make a Worker or Durable Object accept NFS traffic. Custom TCP applications also require an Enterprise plan and paid Spectrum add-on.[^spectrum][^spectrum-plan]

## Feasible shapes

| Shape                                                                                 | Client experience                                                            | What it proves                                                         | Main work left                                                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare Worker/DO serves filesystem operations over HTTPS or WebSocket             | Agents use a TypeScript remote filesystem client                             | Shared operations across hosts, with one deployable Cloudflare service | Design operation API, authentication, concurrency, storage, and reconnect behavior                                                         |
| Local TypeScript NFS server forwards operations to Cloudflare over HTTPS or WebSocket | OS and tools mount `localhost` with NFS; remote service owns filesystem data | Familiar local file tools operating on a remote Cloudflare filesystem  | Gateway mapping, latency, caching, NFS session state, error translation, and write acknowledgment                                          |
| Local TypeScript NFS server calls R2/D1 directly                                      | OS mounts `localhost`; local process reaches Cloudflare storage              | Remote persistent storage behind local NFS                             | Cross-host write coordination, shared filesystem semantics, stale caches, credentials; storage API alone is not a remote filesystem server |
| External NFS origin behind Spectrum                                                   | OS mounts a public TCP endpoint                                              | Native NFS can pass through Cloudflare's L4 proxy                      | Own/operate an NFS process outside Workers; Spectrum product and plan constraints                                                          |

The first shape is the shortest path to the agent use case. The second adds native OS file tooling without waiting for inbound TCP on Workers. A WebSocket byte tunnel for NFS still needs a local TCP adapter, so it does not avoid the gateway. Routing filesystem operations over HTTP or WebSocket may make error handling and versioning easier than tunneling raw NFS bytes; that is a design hypothesis to test, not a Cloudflare guarantee.

## Suggested proof

Run two TypeScript agents on separate hosts against one named Cloudflare workspace. Have one create a file and the other read and update it, then verify both observe the same result after the Cloudflare instance restarts. Once that works, add a local NFS gateway on one host and run an unmodified filesystem tool against its mount. Keep the remote operation API and native mount as separate milestones; storage selection can be evaluated within the first milestone.

## Questions for follow-up

- Should the public TypeScript client expose the existing `Volume`/filesystem operations, or a narrower remote interface?
- Which side owns identity, authorization, and per-file or per-workspace ordering?
- If an NFS gateway is built, which NFS version and subset can it honestly support through remote calls, especially after reconnect?
- How will the gateway report a write result when the remote commit succeeds but the response is lost?

[^worker-protocols]: [Workers supported protocols](https://developers.cloudflare.com/workers/reference/protocols/).

[^worker-tcp]: [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).

[^do-websockets]: [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

[^do-rpc]: [Durable Object coordination and RPC](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/).

[^spectrum]: [Spectrum configuration options](https://developers.cloudflare.com/spectrum/reference/configuration-options/).

[^spectrum-plan]: [Spectrum plans](https://developers.cloudflare.com/spectrum/).
