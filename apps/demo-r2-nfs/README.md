# Mount an Effect VFS backed by R2 in a container

[Cloudflare's R2 FUSE example](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/) installs `tigrisfs` in a Container and mounts an R2 bucket at `/mnt/r2`. This demo explores the same container workflow with Effect. It opens an Effect VFS image stored in R2, serves the filesystem over local NFSv4.1, and mounts that export at `/mnt/r2`. The container then uses ordinary filesystem calls to list, read, and write files on the mount.

The storage layout is different. The Cloudflare example exposes bucket objects as files. This demo stores a bounded filesystem in **one R2 object** and replaces that image when the filesystem changes. Use a dedicated bucket and image key for the experiment. The [standalone NFS guide](standalone-nfs.md) covers native macOS and Linux clients, restart recovery, and earlier test results.

## How the container works

1. [`container-main.ts`](src/container-main.ts) opens the R2-backed volume and starts a loopback NFS server.
2. The Linux NFS client mounts that server at `/mnt/r2` inside the container.
3. [`container-http.ts`](src/container-http.ts) defines four Effect `HttpApi` routes. Their handlers use Effect's host `FileSystem` service through the mounted path.
4. [`container-worker.ts`](src/container-worker.ts) checks a bearer token and forwards requests to one named container.

The [Dockerfile](../../Dockerfile.r2-nfs-container) installs the Linux NFS client. The Worker and Container configuration is in [`wrangler.jsonc`](wrangler.jsonc).

| Method | Path                         | Action                                                            |
| ------ | ---------------------------- | ----------------------------------------------------------------- |
| `GET`  | `/`                          | List the mount root, or pass `?prefix=notes` to list a directory. |
| `GET`  | `/file?path=notes/hello.txt` | Read a file as bytes.                                             |
| `PUT`  | `/file?path=notes/hello.txt` | Write a file from the request body. The limit is 4 MiB.           |
| `POST` | `/directory?path=notes`      | Create a directory.                                               |

## Run it in local Docker

You need Docker, Bun, and a private R2 bucket with an Object Read & Write API token. Create a fresh image key under `effect-vfs-nfs-test/`. From the repository root:

```sh
cp apps/demo-r2-nfs/.env.example apps/demo-r2-nfs/.env
```

Set the R2 endpoint, bucket, key, and API credentials in `.env`. Keep the credentials out of Git. Then build and start the container:

```sh
docker build -f Dockerfile.r2-nfs-container -t effect-vfs-r2-nfs .
docker run --init --name effect-vfs-r2-nfs --cap-add SYS_ADMIN \
  --env-file apps/demo-r2-nfs/.env -p 127.0.0.1:8080:8080 effect-vfs-r2-nfs
```

Look for `Mounted Effect VFS at /mnt/r2` in the container logs. In another terminal, exercise the mount through HTTP:

```sh
curl http://127.0.0.1:8080/
curl -X POST 'http://127.0.0.1:8080/directory?path=notes'
curl -X PUT --data-binary 'hello from Effect VFS' \
  'http://127.0.0.1:8080/file?path=notes/hello.txt'
curl 'http://127.0.0.1:8080/file?path=notes/hello.txt'
curl 'http://127.0.0.1:8080/?prefix=notes'
```

The local port has no authentication. Keep it bound to `127.0.0.1`. Stop the foreground container with `Ctrl-C`, then remove it with `docker rm effect-vfs-r2-nfs`. The image object stays in R2 so a new container can reopen it. Delete that specific test object and revoke the API token when finished.

## Try the Cloudflare Container

Install dependencies with `bun install`. From `apps/demo-r2-nfs`, store `R2_ENDPOINT`, `R2_BUCKET`, `R2_IMAGE_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `DEMO_TOKEN` as Worker secrets with `bunx wrangler secret put NAME`. Use a fresh `R2_IMAGE_KEY` under `effect-vfs-nfs-test/`. The token protects the public Worker route.

From the repository root, deploy the Worker and Container:

```sh
bun run --filter @repo/nfs-r2-writable-test deploy:container
```

Set `WORKER_URL` to the deployed URL and `DEMO_TOKEN` to the token you stored. Send the same requests with an authorization header:

```sh
curl -H "Authorization: Bearer $DEMO_TOKEN" "$WORKER_URL/"
curl -X POST -H "Authorization: Bearer $DEMO_TOKEN" \
  "$WORKER_URL/directory?path=notes"
curl -X PUT -H "Authorization: Bearer $DEMO_TOKEN" \
  --data-binary 'hello from Effect VFS' "$WORKER_URL/file?path=notes/hello.txt"
curl -H "Authorization: Bearer $DEMO_TOKEN" "$WORKER_URL/file?path=notes/hello.txt"
```

The first request starts the container. Set the Worker variable `NFS_MOUNT_READ_ONLY=1` to mount it read-only. The Worker uses one fixed container name and `max_instances: 1` because this R2 image requires one gateway owner. Do not start the standalone gateway against the same image key at the same time.

**Cloudflare mount permission is still unverified.** The local Docker test needed `CAP_SYS_ADMIN` for the kernel NFS mount. Cloudflare documents FUSE mounts in Containers, but the linked example does not establish that a Container can perform this NFS mount. A deployment must confirm that the mount succeeds before this demo can reproduce the workflow on Cloudflare.

The image is limited to 16 MiB encoded, with 8 MiB of file contents, 4 MiB per file, and 1,000 entries. Each mutation replaces the complete R2 image. The HTTP routes demonstrate the mounted filesystem; they are not a general file API. Container restarts reopen the image. Filehandles survive a restart, because they carry the object's reference key, but NFS sessions do not.

## Local test result

On 2026-09-22, a local Docker container with `CAP_SYS_ADMIN` mounted the NFS export and passed all four HTTP routes against a fresh R2 image. The check covered binary write and read, directory listing, missing files, path traversal, and the 4 MiB upload limit. A second container reopened the same image and read the saved binary file. The test image was deleted afterward. Docker Desktop failed to reap the second container during cleanup; its shutdown path still needs investigation. This verifies the local Docker request path, but not Cloudflare's container mount permission.
