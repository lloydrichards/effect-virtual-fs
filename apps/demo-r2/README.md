# R2 writable NFS test app

This local test app connects one `LiveVolume` to one R2 object and the public `NfsServer` with `writable: true`.
It qualifies the volume's durability from Cloudflare R2's documented successful-write contract and uses one
gateway per image. The writable profile is experimental and requires an application-controlled trusted client
boundary; `AUTH_SYS` does not authenticate users.

## Requirements

- macOS or Linux with a native NFSv4.1 client, Bun, this repository's dependencies, and `python3` for verification;
- a private R2 test bucket and a fresh **Object Read & Write** token scoped to that bucket;
- no other gateway using the same R2 image key, and no other service using the chosen local TCP port.

The app binds only to `127.0.0.1`. It accepts `AUTH_SYS` requests from the local host whose UID is either root or
`NFS_ALLOWED_UID`, and maps them to the same VFS caller. Local users able to reach the loopback port can forge
`AUTH_SYS` identity; run this only on a trusted test machine. The app does not run `sudo`, mount, or delete the R2
image. A restart changes NFS sessions and filehandles, so unmount before stopping it and remount after it starts.

For an independent client on a trusted private network, set `NFS_BIND_ADDRESS` to the host's address on one network
interface and `NFS_ALLOWED_PEER` to that client's exact IP address. The server still accepts only root or
`NFS_ALLOWED_UID` claims. `AUTH_SYS` does not authenticate those claims, so this network setting is for an isolated
test network only. Wildcard bind addresses are rejected.

For a one-shot uncertain-write test, set `NFS_FAULT_LOST_R2_REPLY_ONCE=1` and use a fresh `R2_IMAGE_KEY`. The
gateway lets the first conditional image write complete in R2, then discards its successful reply before the
live store sees it. The initiating NFS mutation should report an error, and later mutations should fail until
the gateway is restarted. Unmount, restart without the switch using the same image key, remount, and inspect the
resulting file or directory. This switch simulates a lost reply at the R2 client boundary; it does not sever
the actual HTTP connection or crash the gateway mid-upload.

For a real HTTP-response fault, set `NFS_FAULT_LOST_HTTP_REPLY_ONCE=1`. The test handler waits until R2 returns
success for a conditional object replacement, then discards that HTTP response before the AWS SDK sees it. Set
`NFS_FAULT_HTTP_SKIP_WRITES=1` to let one successful conditional image update through before dropping the next
reply. Use a fresh test key and inspect the result after restarting without the fault settings. These switches
are for test images only.

## Configure

From the repository root:

```sh
cp apps/demo-r2/.env.example apps/demo-r2/.env
```

Edit `apps/demo-r2/.env` with the R2 S3 endpoint, bucket, and the new token's S3 Access Key ID and
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
adapter. The application explicitly asserts `survives-power-loss` based on [Cloudflare's documented guarantee](https://developers.cloudflare.com/r2/reference/durability/) that
a successful R2 API write is persisted before its reply. The public `NfsServer` rejects `writable: true` on weaker
volumes. These tests do not prove multi-gateway ownership, unattended client recovery after restart, or production
workload performance. Record the client OS, mount command, app output, and verification output before deployment.

## Test result on 2026-09-21

On macOS, the native NFSv4.1 mount passed the `create` script's write, `fsync`, rename, and readback steps against a
real R2 bucket. After a clean unmount and fresh server process, the `verify` step read the same file and removed its
test directory. The R2 token also passed a separate temporary-object create, conditional update, reopen, and cleanup
test. The first mount exposed a missing write grant in the internal NFS `ACCESS` reply; the regression test and fix
are in `packages/nfs/test/Nfs4.test.ts` and `packages/nfs/src/internal/nfs4.ts`.

`ls -la` at the export root still reports a permission error for `..` on this macOS client; plain `ls -1` and the
mounted write/restart checks succeeded. This needs a separate root-parent interoperability check.

For a simultaneous two-client check, mount the same running gateway on macOS and an independent Linux kernel, then
run `scripts/cross-client.py` in this order: `create` on Linux, `second` on macOS, `first` on Linux, and `finish` on
macOS. Pass each client's mountpoint and the same `cross-client-<number>` test directory. Each phase checks the
previous client's data, and the last phase removes only its test directory. Do not restart the gateway between
phases; this checks cross-client visibility rather than restart recovery.

On 2026-09-21, this four-phase check passed with macOS and a Debian 12 ARM64 VM mounted simultaneously on the
same R2-backed gateway. Linux wrote and synced `linux-v1`; macOS read it, wrote and synced `mac-v2`, and renamed
the file; Linux read that version, renamed it back, and wrote and synced `linux-v3`; macOS read the final version
and removed the test directory. Separately, the Debian client passed `verify-mount.sh create`, then read back and
removed its file after a clean gateway restart. Both clients were independent native NFSv4.1 implementations;
the gateway and R2 image were shared.

The Debian client also passed an abrupt gateway-stop check. Its `verify-mount.sh create` completed a write,
`fsync`, rename, and readback. The gateway process was then killed with `SIGKILL`. The Debian unmount waited for
the gateway to restart, then completed; after remounting, `verify-mount.sh verify` read the acknowledged file
and removed its test directory. This tests a server-process crash after a completed write, not loss of host power
or a crash during an in-flight write. The standalone R2 fault smoke test also covers adapter-level lost HTTP
responses and conditional-write contention. Those exact faults have not been driven through a mounted NFS client.

In a separate Debian NFSv4.1 run using a fresh image key and `NFS_FAULT_LOST_R2_REPLY_ONCE=1`, the first `mkdir`
returned `Input/output error`. A second `mkdir` returned `Remote I/O error`. After unmounting and reopening the
same image without the fault, the first directory existed and the second did not. The recovered directory was
removed. This shows the mounted client was not falsely told that the uncertain first mutation had succeeded,
and the live owner refused further writes until reopen. It does not establish behavior for every NFS operation
or for an actual network interruption during the R2 upload.

After switching this app to public `NfsServer.make({ writable: true })`, Debian passed write, `fsync`, rename,
readback, and fresh-process reopen on another R2 image. The public path also passed a real HTTP lost-response
test: the first `mkdir` returned `Input/output error`, the next returned `Remote I/O error`, and a fresh gateway
found only the first directory. For a file-content test, an existing file first contained `old-content`; the
fault skipped one successful conditional image update and dropped the next successful HTTP response. Debian's
write or `fsync` returned `EIO`. After restart and remount, it read complete `new-content` and removed the file.
An earlier marker-based fault attempt did not trigger and reported success; its result was discarded. These
results qualify the observed NFS reply and R2 recovery path for this one-gateway configuration, while the R2
power-loss guarantee itself comes from Cloudflare's storage contract.
