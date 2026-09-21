# R2 writable NFS test app

This local test app connects one `LiveVolume` to one R2 object and the repository's staged writable NFSv4.1
handler. It imports the handler from `packages/nfs/src/internal/` deliberately: the published `NfsServer` remains
read-only. This app is for mounted-client interoperability and recovery tests, not a public writable NFS profile.

## Requirements

- macOS or Linux with a native NFSv4.1 client, Bun, this repository's dependencies, and `python3` for verification;
- a private R2 test bucket and a fresh **Object Read & Write** token scoped to that bucket;
- no other gateway using the same R2 image key, and no other service using the chosen local TCP port.

The app binds only to `127.0.0.1`. It accepts `AUTH_SYS` requests from the local host whose UID is either root or
`NFS_ALLOWED_UID`, and maps them to the same VFS caller. Local users able to reach the loopback port can forge
`AUTH_SYS` identity; run this only on a trusted test machine. The app does not run `sudo`, mount, or delete the R2
image. A restart changes NFS sessions and filehandles, so unmount before stopping it and remount after it starts.

## Configure

From the repository root:

```sh
cp apps/nfs-r2-writable-test/.env.example apps/nfs-r2-writable-test/.env
```

Edit `apps/nfs-r2-writable-test/.env` with the R2 S3 endpoint, bucket, and the new token's S3 Access Key ID and
Secret Access Key. The root `.gitignore` excludes `.env`. Do not share or commit the credentials. Use the same
`R2_IMAGE_KEY` on restarts to reopen the test volume; it must begin with `effect-vfs-nfs-test/`. Use a fresh key for
this app, not an object that already holds other data. The default NFS port is 2049. `NFS_ALLOWED_UID` defaults to
the UID running the app; set it if the mounted client's file operations use a different local UID.

The volume is bounded to a 16 MiB encoded image, 8 MiB of file contents, 4 MiB per file, and 1,000 entries. Every
mutation replaces the complete image in R2, so keep the test workload small.

## Start and mount

```sh
bun install
bun run build
bun run --filter @repo/nfs-r2-writable-test start
```

Leave the app running. In a second terminal, mount it on macOS:

```sh
sudo mkdir -p /Volumes/effect-vfs-nfs-r2-test
sudo mount_nfs -o vers=4.1,tcp,sec=sys,port=2049,actimeo=1,noowners \
  127.0.0.1:/ /Volumes/effect-vfs-nfs-r2-test
```

Or on Linux:

```sh
sudo mkdir -p /mnt/effect-vfs-nfs-r2-test
sudo mount -t nfs -o nfsvers=4.1,tcp,sec=sys,port=2049,actimeo=1 \
  127.0.0.1:/ /mnt/effect-vfs-nfs-r2-test
```

If you set `NFS_PORT`, use the same value in the mount command. For the first run, verify a small write, `fsync`,
rename, read, and restart recovery. On macOS:

```sh
bun run --filter @repo/nfs-r2-writable-test verify-mount create /Volumes/effect-vfs-nfs-r2-test
```

Record the printed `TEST_DIRECTORY`. Unmount, stop the app with `Ctrl-C`, start it again with the same `.env`, and
remount. Then run:

```sh
bun run --filter @repo/nfs-r2-writable-test verify-mount verify \
  /Volumes/effect-vfs-nfs-r2-test YOUR_TEST_DIRECTORY
```

On Linux, substitute `/mnt/effect-vfs-nfs-r2-test`. Unmount with `sudo umount MOUNTPOINT` before each stop and
after verification. The verify step removes only its named test file and directory. The R2 image remains so the
volume can reopen; delete that specific object in the R2 dashboard when the experiment is over, then revoke the
test token and remove the local `.env`.

## What this can establish

The test shows whether a native NFS client can write, sync, rename, and recover file contents through this R2
adapter. It does not prove multi-gateway ownership, power-loss behavior across the complete NFS response path,
unattended client recovery after server restart, or production workload performance. `Volume.durability` is still
`memory-only`, and the public NFS export stays read-only. Record the client OS, mount command, app output, and
verification output before considering a release decision.

## Test result on 2026-09-21

On macOS, the native NFSv4.1 mount passed the `create` script's write, `fsync`, rename, and readback steps against a
real R2 bucket. After a clean unmount and fresh server process, the `verify` step read the same file and removed its
test directory. The R2 token also passed a separate temporary-object create, conditional update, reopen, and cleanup
test. The first mount exposed a missing write grant in the internal NFS `ACCESS` reply; the regression test and fix
are in `packages/nfs/test/Nfs4.test.ts` and `packages/nfs/src/internal/nfs4.ts`.

`ls -la` at the export root still reports a permission error for `..` on this macOS client; plain `ls -1` and the
mounted write/restart checks succeeded. This needs a separate root-parent interoperability check.
