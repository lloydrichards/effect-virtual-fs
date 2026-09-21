# Alchemy R2 virtual notebook

Alchemy provisions a private Cloudflare R2 bucket and a Worker. The Worker creates a virtual file tree with Effect `LiveVolume` and stores its image through the native R2 binding. The app needs no S3 credentials.

The pieces are:

1. [`alchemy.run.ts`](alchemy.run.ts) declares the bucket and Worker.
2. [`src/from-alchemy.ts`](src/from-alchemy.ts) connects the Worker's native R2 binding to `R2LiveImageStore`.
3. [`src/notebook-worker.ts`](src/notebook-worker.ts) creates `/notes/hello.txt`, moves it to `/published/hello.txt`, and reopens it on a later request.

Each `POST` uses a new image key. A later `GET` opens that image in a new request scope and reads the published file. This demonstrates persistence across independent Worker requests. The image store still requires one writer per image; this example never edits a previously created image.

## Deploy

Set a long random `NOTEBOOK_TOKEN` in an ignored `.env` file. Configure a Cloudflare Alchemy profile with `bun alchemy profile edit --profile default --add Cloudflare`, or supply `CLOUDFLARE_API_TOKEN`. Then run from the repository root:

```sh
bun install
cd apps/alchemy-vfs-demo
bun --env-file=.env alchemy plan
bun --env-file=.env alchemy deploy
```

Alchemy prints the private bucket name and Worker URL. The Worker requires the bearer token on every request.

## Exercise the notebook

Set `WORKER_URL` to the deployed URL and `TOKEN` to the value from `.env` in your shell. Keep the token out of command history if your shell records it. Then send separate requests:

```sh
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$WORKER_URL/notebooks"
curl -fsS -H "Authorization: Bearer $TOKEN" "$WORKER_URL/notebooks/ID_FROM_POST"
curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" "$WORKER_URL/notebooks/ID_FROM_POST"
```

The `POST` and `GET` responses both contain `"files": ["/published/hello.txt"]` and the same text. `DELETE` removes the image. A later `GET` returns 404.

Each `POST` creates a new image. The app does not edit an existing image or coordinate multiple writers on one image. A read can return 404 if deletion races with it. If creation fails, the Worker tries to remove the partial image. Its error response includes the ID so you can retry `DELETE` if cleanup fails.

For a repeatable live check, set `NOTEBOOK_URL` to the deployed Worker URL in `.env` and run `bun run test:live` from this app directory. This checks unauthorized access, creation, a separate reopen request, deletion, and the final 404. The regular `bun run validate` gate runs the local tests without requiring Cloudflare credentials.

See [the research note](../../docs/research/alchemy-r2-effect.md) for the adapter contract and validation evidence.
