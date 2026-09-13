# @effect-vfs/nfs

Private, experimental read-only NFSv4.1 interoperability preview for exposing one live Effect VFS volume to local native tools.

This package runs a scoped TCP server and implements the bounded NFSv4.1 session, metadata, directory, symlink, and regular-file read path needed by the preview. It is not a conformant NFSv4.1 server. Among other omissions, it does not implement RPCSEC_GSS, callbacks, backchannels, delegations, locking, layouts, migration, recovery, or the full RFC-required operation set. Mutating operations that the preview decodes return `NFS4ERR_ROFS`.

<!-- TODO(gauntlet-29): Add the opt-in privileged Linux gate tracked by https://github.com/lloydrichards/effect-virtual-fs/issues/39. The equivalent macOS 26.6 gate passed manually on 2026-09-13. -->

`NfsServer.make` and `NfsServer.layer` require the application to supply the live `Volume`, privileged virtual `Caller`, and Effect `SocketServer`. The application chooses and binds the platform socket implementation. NFS accepts only a loopback TCP address. It defaults to a 30-second lease and a finite resource policy. Decoded `AUTH_SYS` fields are untrusted compatibility data; they never select or grant VFS authority. This is suitable only for a trusted, single-user local machine.

`NfsServerConfig`, `NfsServerConfigOverrides`, `NfsServerLimits`, `NfsServerLimitOverrides`, and `NfsServerAddress` are public Effect schemas. Byte limits use `effect/ByteSize`, so their units are explicit and validated before the server converts them to the numeric representation used by XDR. `NfsServerConfig.default`, `NfsServerLimits.default`, and `NfsServerLimits.constrained` expose frozen complete policies. Callers can override only the settings they need. `Volume`, `Caller`, and `SocketServer` remain live Effect capabilities rather than schema data.

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
