# @effect-vfs/nfs

`@effect-vfs/nfs` exports one live VFS volume to native NFSv4.1 clients. The loopback read-only profile has `preview`
evidence; the trusted-network profile remains `experimental`. Start with the [runnable preview app](../../apps/nfs-preview/README.md)
to mount a fixture and observe live updates.

The scoped server supports TCP or a UNIX-domain socket, metadata and directory reads, symlinks, regular-file reads,
and NFSv4.1 sessions. Mutations return `NFS4ERR_ROFS` by default. Explicit `writable: true` requires a volume whose
`durability` is at least `survives-power-loss`; the server rejects weaker volumes before listening. It is not a conformant NFSv4.1 server: RFC 8881 requires
RPCSEC_GSS with Kerberos, which this package excludes. It also omits delegations, layouts, migration, and restart recovery. Backchannels and connection trunking are implemented, but the server grants no delegation or layout to
recall.

## Supported profile and maturity

The package describes what it does with a capability profile and how well that is evidenced with a maturity label. The two are tracked separately; see the [NFS profile ladder](https://github.com/lloydrichards/effect-virtual-fs/blob/main/.okf/decisions/nfs/nfs-profile-ladder.md) for definitions and the evidence each maturity level requires.

| Profile               | What it adds                                                                                                                           | Maturity     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `read-only-local`     | complete read path, `NFS4ERR_ROFS` on mutation, loopback binding, `AUTH_SYS` accepted as untrusted, backchannel and connection binding | preview      |
| `read-only-networked` | `AUTH_SYS` identity mapped to VFS callers by application policy, non-loopback binding behind that policy and an explicit opt-in        | experimental |
| `writable`            | create, write, rename, remove, durable `WRITE` and `COMMIT`, share reservations, and advisory byte-range locks                         | experimental |
| `stateful`            | grace and reclaim, restart recovery of sessions, opens, and locks                                                                      | not public   |

`read-only-local` has recorded macOS, Linux, and pinned pynfs read-side checks. The preview app's
[conformance baseline](../../apps/nfs-preview/CONFORMANCE.md) records the tested clients and remaining failures.
Mount explicitly with NFSv4.1. The package excludes NFSv4.0, NFSv4.2, and RPCSEC_GSS.

`NfsServer.make` and `NfsServer.layer` accept local `{ volume, caller }` or networked `{ volume, policy, peer }`
options. Both require an Effect `SocketServer`. Local mode accepts loopback TCP or a UNIX-domain socket.
Networked mode requires an application identity policy and `allowNonLoopback: true` to bind elsewhere.

Read locks are advisory between NFS clients. Direct VFS callers do not participate. Write locks return
`NFS4ERR_ROFS` in read-only mode. Lease expiry and client revocation remove in-memory lock state.

The optional `writable: true` profile is limited to one gateway owning one qualified live volume. The application
must prevent another gateway from opening the same storage image; the server does not provide a distributed lease.
Successful mutations rely on the live provider's synchronous commit guarantee. The [R2 writable test app](../../apps/demo-r2-nfs/README.md)
shows the public API with a bounded R2 image, a trusted-client policy, mounted Debian and macOS checks, restart
recovery, and an injected lost R2 HTTP response. Filehandles carry the object's core reference key, so over a volume
whose commits survive at least a process crash they persist across a restart and `fh_expire_type` reports
`FH4_PERSISTENT`. The key's tag keeps a client from forging a handle for an object by guessing its inode number. Sessions, opens, and locks do not survive, so remount clients after gateway restart; this is not
the `stateful` recovery profile. Do not set a stronger `Volume.durability` for an unqualified storage provider.

## Configure and run

Start with the [local NFS guide](../../apps/docs/app/content/guides/local-nfs.mdx) for a complete server program.
The [API reference](../../apps/docs/app/content/api/nfs/nfs-server.mdx) lists configuration, schemas, and finite
resource limits. Byte limits use Effect `ByteSize`.

In local mode, one supplied caller performs every read. `AUTH_SYS` credentials grant no VFS authority.
In networked mode, the application resolves each socket's peer and maps its credentials to a VFS identity or denies
access. Applications own the trusted-client policy. See the
[authentication and export policy](../../.okf/decisions/nfs/nfs-authentication-and-export-policy.md) for that contract.

The package never mounts a filesystem and never invokes `sudo`. The repository's standalone
[`@repo/nfs-preview`](https://github.com/lloydrichards/effect-virtual-fs/blob/main/apps/nfs-preview/README.md) app provides a runnable fixture and complete macOS mount,
verification, troubleshooting, and cleanup instructions. Start it from the repository root with:

```sh
bun run --filter @repo/nfs-preview start
```

Applications continue writing through the VFS API while native clients read the mounted view. Stop the server,
unmount, and mount again after a restart because its memory volume's filehandles and every session are intentionally
volatile.

Run the focused checks from this directory:

```sh
bun run type-check
bun run test
bun run build
```
