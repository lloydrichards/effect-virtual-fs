# NFS preview app

This app exposes a small live Effect VFS volume through the experimental read-only NFSv4.1 server. It is a runnable
consumer of `@effect-vfs/nfs`, separate from the library package.

The fixture contains:

- `hello.txt` and `hello-alias.txt`, which are two hard links to the same file;
- `latest`, a symlink to `notes/live.txt`;
- `notes/live.txt`, which the app replaces every two seconds so native cache refresh can be observed.

## Requirements

- a native NFSv4.1 client: the built-in `mount_nfs` on macOS, or `nfs-common` on Linux;
- Bun and this repository's dependencies installed;
- permission to use `sudo` for mounting and unmounting;
- TCP port 2049 available on loopback.

The app itself does not run `sudo` or mount anything. It listens only on `127.0.0.1`. You control the native mount in
a separate terminal.

## Start the server

From the repository root:

```sh
bun install
bun run --filter @repo/nfs-preview start
```

Leave that process running. It should report:

```text
NFS preview listening at 127.0.0.1:2049
```

If the port is already in use, stop the process using it before retrying. The mount command and server must use the
same port.

## Mount it on macOS

In another terminal:

```sh
sudo mkdir -p /Volumes/effect-vfs-nfs-preview
sudo mount_nfs -o vers=4.1,tcp,sec=sys,port=2049,actimeo=1,noowners \
  127.0.0.1:/ /Volumes/effect-vfs-nfs-preview
```

The options have specific jobs:

- `vers=4.1,tcp,sec=sys` selects the protocol profile implemented by the preview;
- `port=2049` connects to the app's fixed loopback port;
- `actimeo=1` asks macOS to refresh cached attributes after about one second;
- `noowners` prevents the preview's numeric owner strings from being treated as macOS identities;
- the mount stays writable on the client on purpose, so that rejected writes are the server's `NFS4ERR_ROFS` rather than the local kernel's read-only flag.

## Mount it on Linux

Linux spells the version option `nfsvers` and has no `noowners` equivalent:

```sh
sudo mkdir -p /mnt/effect-vfs-nfs-preview
sudo mount -t nfs -o nfsvers=4.1,tcp,sec=sys,port=2049,actimeo=1 \
  127.0.0.1:/ /mnt/effect-vfs-nfs-preview
```

Passing `nfsvers=4.1` is deliberate. A bare `mount -t nfs` also works, but the Linux client
starts at 4.2 and ladders down through the server's `NFS4ERR_MINOR_VERS_MISMATCH` replies; naming
the version skips that negotiation. The scripted gate below checks both paths.

## Try the filesystem

These examples use the macOS mountpoint; on Linux substitute `/mnt/effect-vfs-nfs-preview` and the
GNU `stat -c '%i %n'` spelling.

```sh
ls -la /Volumes/effect-vfs-nfs-preview
cat /Volumes/effect-vfs-nfs-preview/hello.txt
cat /Volumes/effect-vfs-nfs-preview/latest
stat -f '%i %N' \
  /Volumes/effect-vfs-nfs-preview/hello.txt \
  /Volumes/effect-vfs-nfs-preview/hello-alias.txt
```

The first `cat` prints `hello from Effect VFS`. The symlink reads the current live revision. The two `stat` lines
should report the same inode number because both names refer to one virtual file.

To observe a VFS-side update through the native mount:

```sh
cat /Volumes/effect-vfs-nfs-preview/notes/live.txt
sleep 3
cat /Volumes/effect-vfs-nfs-preview/notes/live.txt
```

The revision should increase. The one-second attribute-cache setting keeps this visible without disabling caching.

## Stop and clean up

Unmount before stopping or restarting the server:

```sh
sudo umount /Volumes/effect-vfs-nfs-preview
```

Then stop the app with `Ctrl-C`. A server restart creates new volatile sessions and filehandles, so an old mount must
be unmounted and mounted again.

If a failed run leaves a stale mount, unmount it before retrying. If the mountpoint directory was removed, recreate
it with the `mkdir` command above.

## Scripted verification

With the app running and the volume mounted, run the read-side checks without `sudo`:

```sh
bun run --filter @repo/nfs-preview verify-mount
```

Pass a different mountpoint as the first argument if you did not use the default. The script checks listing, file
reads, symlink traversal, hard-link identity, the live update after the cache window, reopening, and that writes are
rejected. It prints one line per check and exits non-zero on any failure. Unmounting stays a manual `sudo umount`.

## Opt-in Linux mount gate

On Linux the whole cycle is scripted, including the privileged parts:

```sh
bun run --filter @repo/nfs-preview linux-mount-gate
```

It starts the server, waits for loopback 2049, mounts with `nfsvers=4.1`, runs the read-side checks
above, mounts a second time with no version option to confirm the client still settles on 4.1, then
unmounts both and stops the server. A single trap covers every exit path, so a failure never leaves a
hung mount behind. It also prints the kernel, distribution, and `nfs-utils` versions it ran against,
because the NFSv4.1 client is the host kernel and therefore recorded rather than pinned.

It requires Linux, `nfs-common` for `mount.nfs4`, the ability to run `sudo mount` and `sudo umount`
without an interactive password prompt, and a free TCP port 2049. This script is the only place that
escalates: `@effect-vfs/nfs` never invokes `sudo`, and `verify-mount.sh` stays unprivileged.

In CI the gate is opt-in. The `NFS Linux mount gate` workflow runs on `workflow_dispatch`, and on a
pull request only once that pull request carries the `nfs-gate` label, so privileged mounting stays
out of the normal validation suite.

## External suite

`bun run --filter @repo/nfs-preview conformance` serves a pynfs-shaped fixture with generous client and session
limits. [CONFORMANCE.md](CONFORMANCE.md) records the pinned pynfs run, how to repeat it, and why each remaining
failure is expected.

## Scope

This is a local single-user interoperability preview, not a conformant or production NFS server. It is read-only and
does not implement remote authentication, encryption, locking, delegations, durable recovery, or the full NFSv4.1
operation set. Do not expose port 2049 beyond the local machine.
