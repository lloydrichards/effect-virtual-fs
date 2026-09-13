# NFS preview app

This app exposes a small live Effect VFS volume through the experimental read-only NFSv4.1 server. It is a runnable
consumer of `@effect-vfs/nfs`, separate from the library package.

The fixture contains:

- `hello.txt` and `hello-alias.txt`, which are two hard links to the same file;
- `latest`, a symlink to `notes/live.txt`;
- `notes/live.txt`, which the app replaces every two seconds so native cache refresh can be observed.

## Requirements

- macOS with the built-in `mount_nfs` client;
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
sudo mount_nfs -o vers=4.1,tcp,sec=sys,port=2049,actimeo=1,noowners,ro \
  127.0.0.1:/ /Volumes/effect-vfs-nfs-preview
```

The options have specific jobs:

- `vers=4.1,tcp,sec=sys` selects the protocol profile implemented by the preview;
- `port=2049` connects to the app's fixed loopback port;
- `actimeo=1` asks macOS to refresh cached attributes after about one second;
- `noowners` prevents the preview's numeric owner strings from being treated as macOS identities;
- `ro` makes the native mount read-only.

## Try the filesystem

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

## Scope

This is a local single-user interoperability preview, not a conformant or production NFS server. It is read-only and
does not implement remote authentication, encryption, locking, delegations, durable recovery, or the full NFSv4.1
operation set. Do not expose port 2049 beyond the local machine.
