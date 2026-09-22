# Alchemy R2 virtual notebook

This demo runs an Effect VFS volume inside a Cloudflare Worker. A `POST` request creates a notebook, writes
`/notes/hello.txt`, and publishes it by renaming the file to `/published/hello.txt`. A later `GET` request opens a new
volume from the same R2 image and reads the published file.

`LiveVolume` stores the complete virtual filesystem as one R2 object. Alchemy provisions the Worker and its private R2
binding, so the application does not use a mounted disk or S3 credentials.

## How the demo works

Read the implementation in this order:

1. [`src/notebook.ts`](src/notebook.ts) defines `NotebookService` and manages each `LiveVolume` scope.
2. [`src/notebook-worker.ts`](src/notebook-worker.ts) maps authenticated HTTP requests to notebook operations and encodes schema-validated JSON replies.
3. [`src/from-alchemy.ts`](src/from-alchemy.ts) adapts Alchemy's native R2 binding to the image-store transport.
4. [`alchemy.run.ts`](alchemy.run.ts) defines the Alchemy stack and its outputs.

Each notebook operation opens its own volume. When the scope closes, `LiveVolume` commits any changes to R2. A later
request reconstructs the filesystem from that image rather than reusing Worker memory.

The notebook uses core VFS callers directly instead of Effect's `FileSystem` adapter:

- A privileged bootstrap caller creates `/notes` and `/published`, then assigns both directories to the author.
- The author caller writes through a scoped `/notes` working directory and moves the file into `/published`.
- The reader caller lists and reads `/published`. Its identity cannot modify the published file because the persisted ownership and mode bits deny write access.

The Worker composes `BrowserCrypto.layer`, the R2 transport, and `NotebookService.Live` into one request layer. The
handler checks the bearer token before it opens a volume or reads from the bucket. `NotebookService` keeps R2 keys,
volume scopes, and partial-image cleanup out of the HTTP handler.

## Limits

Each `POST` creates a new R2 image. The demo does not edit an existing notebook or coordinate multiple writers for one
image. `DELETE` removes the R2 object directly as an administrative storage operation.

A read can race with deletion. The service pins the R2 record that it observed before opening the volume, then confirms
that the object still exists. This prevents a read from recreating an image that another request deleted.

If creation fails after an image write, the service tries to delete the partial image. A failed cleanup response includes
the notebook ID so the caller can retry `DELETE`.

## Deploy the Worker

Set a long random `NOTEBOOK_TOKEN` in an ignored `.env` file. Configure the default Cloudflare profile:

```sh
bun alchemy profile edit --profile default --add Cloudflare
```

You can set `CLOUDFLARE_API_TOKEN` instead. Then run these commands from the repository root:

```sh
bun install
cd apps/demo-alchemy
bun --env-file=.env run plan
bun --env-file=.env run deploy
```

Alchemy prints the private bucket name and the Worker URL. Every request to the Worker requires the bearer token.

## Exercise the notebook

Set `WORKER_URL` to the deployed URL and `TOKEN` to the value of `NOTEBOOK_TOKEN`. Then send separate requests:

```sh
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$WORKER_URL/notebooks"
curl -fsS -H "Authorization: Bearer $TOKEN" "$WORKER_URL/notebooks/ID_FROM_POST"
curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" "$WORKER_URL/notebooks/ID_FROM_POST"
```

Successful `POST` and `GET` replies use the `Notebook` tag:

```json
{
  "_tag": "Notebook",
  "id": "...",
  "files": ["/published/hello.txt"],
  "content": "A virtual file, committed as one R2 image."
}
```

`DELETE` returns `{"_tag":"Deleted","deleted":true}`. A later `GET` returns HTTP 404 with an `Error` reply.
Creation failures use the `CreationFailed` tag and include `id` and `cleanup` fields.

For a repeatable live check, set `NOTEBOOK_URL` to the deployed Worker URL in `.env`. Run this command from the app
directory:

```sh
bun run test:live
```

The live check covers authentication, creation, reopening in a separate request, deletion, and the final 404. The local
test suite does not require Cloudflare credentials.

See [the Alchemy R2 research note](../../docs/research/alchemy-r2-effect.md) for the adapter contract and validation
evidence.
