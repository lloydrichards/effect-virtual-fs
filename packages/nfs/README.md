# @effect-vfs/nfs

Preview read-only NFSv4.1 export for exposing one live Effect VFS volume to local native tools.

This package runs a scoped socket server, over loopback TCP or a UNIX-domain socket, and implements the bounded NFSv4.1 session, metadata, directory, symlink, and regular-file read path. It is not a conformant NFSv4.1 server and no future profile will claim to be one: RFC 8881 requires RPCSEC_GSS with Kerberos, which this package permanently excludes because no viable server-side implementation exists in the JavaScript ecosystem. It also omits delegations, locking, layouts, migration, and recovery. Backchannels and connection trunking are implemented, but nothing is ever recalled over a backchannel because no delegation or layout is ever granted. Mutating operations return `NFS4ERR_ROFS`.

## Supported profile and maturity

The package describes what it does with a capability profile and how well that is evidenced with a maturity label. The two are tracked separately; see the [NFS profile ladder](../../.okf/decisions/nfs-profile-ladder.md) for definitions and the evidence each maturity level requires.

| Profile               | What it adds                                                                                                                           | Maturity    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `read-only-local`     | complete read path, `NFS4ERR_ROFS` on mutation, loopback binding, `AUTH_SYS` accepted as untrusted, backchannel and connection binding | preview     |
| `read-only-networked` | `AUTH_SYS` identity mapped to VFS callers by application policy, non-loopback binding behind that policy and an explicit opt-in        | not started |
| `writable`            | create, write, rename, remove, `COMMIT` semantics, explicit durability statement                                                       | not started |
| `stateful`            | share reservations, byte-range locks, grace and reclaim, persistent filehandles                                                        | not started |

`read-only-local` is currently `preview`: the protocol test suites pass, scripted macOS 26.6.2 and Linux kernel-client mounts each pass every read-side check, and a pinned pynfs run with every failure classified is recorded in the preview app's [conformance baseline](../../apps/nfs-preview/CONFORMANCE.md). The Linux mount is a repeatable opt-in CI gate rather than a manual run. Per-requirement status against RFC 8881 lives in the [operations](../../.okf/research/nfs-operations-ledger.md), [attributes](../../.okf/research/nfs-attributes-ledger.md), and [protocol rules](../../.okf/research/nfs-protocol-rules-ledger.md) ledgers. NFSv4.0 and NFSv4.2 are out of scope; mount with `vers=4.1` explicitly.

`NfsServer.make` and `NfsServer.layer` require the application to supply the live `Volume`, privileged virtual `Caller`, and Effect `SocketServer`. The application chooses and binds the platform socket implementation. NFS accepts only a loopback TCP address or a UNIX-domain socket path. It defaults to a 30-second lease, a 30-second callback timeout, and a finite resource policy. Decoded `AUTH_SYS` fields are untrusted compatibility data; they never select or grant VFS authority, and ACCESS answers derived from them are advisory because the privileged caller performs every read. RPCSEC_GSS credentials are refused with `AUTH_TOOWEAK`. This is suitable only for a trusted, single-user local machine. The [authentication and export policy decision](../../.okf/decisions/nfs-authentication-and-export-policy.md) defines how the `read-only-networked` profile will map trusted identities and gate non-loopback binding.

`NfsServerConfig`, `NfsServerConfigOverrides`, `NfsServerLimits`, `NfsServerLimitOverrides`, `NfsServerAddress`, `NfsServerTcpAddress`, and `NfsServerUnixAddress` are public Effect schemas. Byte limits use `effect/ByteSize`, so their units are explicit and validated before the server converts them to the numeric representation used by XDR. `NfsServerConfig.default`, `NfsServerLimits.default`, and `NfsServerLimits.constrained` expose frozen complete policies. Callers can override only the settings they need. `Volume`, `Caller`, and `SocketServer` remain live Effect capabilities rather than schema data.

```ts
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

The package never mounts a filesystem and never invokes `sudo`. The repository's standalone
[`@repo/nfs-preview`](../../apps/nfs-preview/README.md) app provides a runnable fixture and complete macOS mount,
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
