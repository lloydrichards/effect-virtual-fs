# @effect-vfs/nfs

`@effect-vfs/nfs` exports one live VFS volume to native NFSv4.1 clients. The loopback read-only profile has `preview`
evidence; the trusted-network profile remains `experimental`. Start with the [runnable preview app](../../apps/nfs-preview/README.md)
to mount a fixture and observe live updates.

The scoped server supports TCP or a UNIX-domain socket, metadata and directory reads, symlinks, regular-file reads,
and NFSv4.1 sessions. Mutations return `NFS4ERR_ROFS` by default. Explicit `writable: true` requires a volume whose
`durability` is at least `survives-power-loss`; the server rejects weaker volumes before listening. It is not a conformant NFSv4.1 server: RFC 8881 requires
RPCSEC_GSS with Kerberos, which this package excludes. It also omits delegations, write locks, layouts, migration,
and recovery. Backchannels and connection trunking are implemented, but the server grants no delegation or layout to
recall.

## Supported profile and maturity

The package describes what it does with a capability profile and how well that is evidenced with a maturity label. The two are tracked separately; see the [NFS profile ladder](https://github.com/lloydrichards/effect-virtual-fs/blob/main/.okf/decisions/nfs/nfs-profile-ladder.md) for definitions and the evidence each maturity level requires.

| Profile               | What it adds                                                                                                                           | Maturity     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `read-only-local`     | complete read path, `NFS4ERR_ROFS` on mutation, loopback binding, `AUTH_SYS` accepted as untrusted, backchannel and connection binding | preview      |
| `read-only-networked` | `AUTH_SYS` identity mapped to VFS callers by application policy, non-loopback binding behind that policy and an explicit opt-in        | experimental |
| `writable`            | create, write, rename, remove, durable `WRITE` and `COMMIT`, share reservations, and advisory byte-range locks                         | experimental |
| `stateful`            | grace and reclaim, restart recovery, persistent filehandles                                                                            | not public   |

The current read-only export tracks advisory byte-range read locks between NFS clients. `LOCK` requires an open stateid; `LOCKU` releases an exact range. Write locks still return `NFS4ERR_ROFS`. `maxLockOwners` and `maxLocks` bound the in-memory state, which is removed on lease expiry or client revocation. Direct VFS callers do not participate in NFS locks.

`read-only-local` is currently `preview`: the protocol test suites pass, scripted macOS 26.6.2 and Linux kernel-client mounts each pass every read-side check, and a pinned pynfs run with every failure classified is recorded in the preview app's [conformance baseline](https://github.com/lloydrichards/effect-virtual-fs/blob/main/apps/nfs-preview/CONFORMANCE.md). The Linux mount is a repeatable opt-in CI gate rather than a manual run. Per-requirement status against RFC 8881 lives in the [operations](https://github.com/lloydrichards/effect-virtual-fs/blob/main/.okf/research/nfs/nfs-operations-ledger.md), [attributes](https://github.com/lloydrichards/effect-virtual-fs/blob/main/.okf/research/nfs/nfs-attributes-ledger.md), and [protocol rules](https://github.com/lloydrichards/effect-virtual-fs/blob/main/.okf/research/nfs/nfs-protocol-rules-ledger.md) ledgers. NFSv4.0 and NFSv4.2 are out of scope; mount with `vers=4.1` explicitly.

`NfsServer.make` and `NfsServer.layer` accept local `{ volume, caller }` or networked `{ volume, policy, peer }` options. Both require an Effect `SocketServer`; the application chooses and binds its platform implementation. Local mode accepts only loopback TCP or a UNIX-domain socket. Networked mode can bind elsewhere only with `allowNonLoopback: true`. The server defaults to a 30-second lease, a 30-second callback timeout, and finite resource limits. RPCSEC_GSS credentials are refused with `AUTH_TOOWEAK`.

The optional `writable: true` profile is limited to one gateway owning one qualified live volume. The application
must prevent another gateway from opening the same storage image; the server does not provide a distributed lease.
Successful mutations rely on the live provider's synchronous commit guarantee. The [R2 writable test app](../../apps/demo-r2/README.md)
shows the public API with a bounded R2 image, a trusted-client policy, mounted Debian and macOS checks, restart
recovery, and an injected lost R2 HTTP response. Remount clients after gateway restart; this is not the `stateful`
recovery profile. Do not set a stronger `Volume.durability` for an unqualified storage provider.

In local mode, one application-supplied caller performs every read. Decoded `AUTH_SYS` fields never grant VFS authority, and ACCESS answers derived from them are advisory. In networked mode, the application supplies a peer resolver evaluated for each accepted socket and a policy that maps the decoded credential and peer to a VFS identity or denies it. The server creates and caches callers per distinct identity, bounded by `maxIdentities`. Policy denials and cache exhaustion answer RPC `AUTH_FAILED` before the compound executes. A resolver returning `null` closes the connection. UNIX peers have `address: null` and `port: null`; `path` is the server socket path, not a client address. Applications must enforce their trusted-client boundary in the policy. This profile is experimental: protocol and socket tests pass, but a networked kernel-client gate has not been recorded. See the [authentication and export policy decision](https://github.com/lloydrichards/effect-virtual-fs/blob/main/.okf/decisions/nfs/nfs-authentication-and-export-policy.md).

`NfsServerConfig`, `NfsServerConfigOverrides`, `NfsServerLimits`, `NfsServerLimitOverrides`, `NfsServerAddress`, `NfsServerTcpAddress`, `NfsServerNetworkTcpAddress`, and `NfsServerUnixAddress` are public Effect schemas. Byte limits use `effect/ByteSize`, so their units are explicit and validated before the server converts them to the numeric representation used by XDR. `NfsServerConfig.default`, `NfsServerLimits.default`, and `NfsServerLimits.constrained` expose frozen complete policies. Callers can override only the settings they need. `Volume`, `Caller`, and `SocketServer` remain live Effect capabilities rather than schema data.

The following configuration assumes an existing `volume` and `caller`. The preview app supplies both in a complete
runnable example.

```ts
import { NfsServer } from "@effect-vfs/nfs/NfsServer"
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"

const program = Effect.scoped(
  NfsServer.make({
    volume,
    caller,
    limits: { maxReadBytes: ByteSize.mebibytes(4) }
  })
).pipe(
  Effect.provide(BunSocketServer.layer({ host: "127.0.0.1", port: 2049 }))
)
```

For Node or Bun networked mode, the resolver can read `NodeSocket.NetSocket` from each connection's Effect context. The policy must check the peer before mapping a credential to authority:

```ts
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

const peer = Effect.map(
  Effect.serviceOption(NodeSocket.NetSocket),
  Option.match({
    onNone: () => null,
    onSome: (socket) =>
      socket.remoteAddress === undefined || socket.remotePort === undefined
        ? null
        : { transport: "tcp" as const, address: socket.remoteAddress, port: socket.remotePort }
  })
)

const networked = NfsServer.make({
  volume,
  peer,
  allowNonLoopback: true,
  policy: ({ credential, peer }) => {
    if (peer.transport !== "tcp" || peer.address !== "192.0.2.10" || credential.flavor !== "sys") return null
    return { uid: credential.uid, gid: credential.gid, groups: credential.groups, privileged: false }
  }
})
```

Provide the platform `SocketServer` and `Crypto` services and run this Effect in a scope, as in the local example. The peer address check above is only an example; applications choose their own trusted-client policy.

The package never mounts a filesystem and never invokes `sudo`. The repository's standalone
[`@repo/nfs-preview`](https://github.com/lloydrichards/effect-virtual-fs/blob/main/apps/nfs-preview/README.md) app provides a runnable fixture and complete macOS mount,
verification, troubleshooting, and cleanup instructions. Start it from the repository root with:

```sh
bun run --filter @repo/nfs-preview start
```

Applications continue writing through the VFS API while native clients read the mounted view. Stop the server,
unmount, and mount again after a restart because filehandles and sessions are intentionally volatile.

Run the focused checks from this directory:

```sh
bun run type-check
bun run test
bun run build
```
