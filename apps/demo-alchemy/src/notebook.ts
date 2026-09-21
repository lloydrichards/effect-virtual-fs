import { LiveVolume, type VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as WorkerCrypto from "./worker-crypto.js"

const options = {
  maxImageBytes: ByteSize.kilobytes(64),
  volume: {
    maxEntries: 100,
    maxBytes: ByteSize.kilobytes(32),
    maxFileBytes: ByteSize.kilobytes(16),
    maxPathBytes: ByteSize.bytes(1024)
  }
}

export const keyFor = (id: string) => `effect-vfs-notebooks/${id}`

export interface Notebook {
  readonly id: string
  readonly files: ReadonlyArray<string>
  readonly content: string
  readonly durability: string
}

const withNotebook = <A, E, R>(
  client: R2LiveImageStore.R2Client,
  id: string,
  use: (files: Vfs.Caller, durability: string) => Effect.Effect<A, E, R>
) => {
  // Each request owns its volume scope. A later GET must load the image from R2
  // rather than reuse handles or in-memory state left by POST.
  const store = R2LiveImageStore.layer({
    client,
    key: keyFor(id),
    maxImageBytes: options.maxImageBytes,
    durability: "survives-power-loss"
  }).pipe(Layer.provide(WorkerCrypto.layer))

  return Effect.scoped(Effect.gen(function*() {
    const volume = yield* LiveVolume.open(options)
    const files = yield* volume.caller()

    return yield* use(files, volume.durability)
  })).pipe(Effect.provide(Layer.merge(store, WorkerCrypto.layer)))
}

const describeNotebook = Effect.fn("Notebook.describe")(function*(files: Vfs.Caller, id: string, durability: string) {
  const names = yield* files.readDirectory("/published")
  const content = new TextDecoder().decode(yield* files.readFile("/published/hello.txt"))

  return {
    id,
    files: names.map((name) => `/published/${name}`),
    content,
    durability
  } satisfies Notebook
})

export const createNotebook = (client: R2LiveImageStore.R2Client, id: string) =>
  withNotebook(client, id, (files, durability) =>
    Effect.gen(function*() {
      // These are filesystem operations on the virtual tree. The R2 adapter
      // persists the resulting image; callers never manage individual R2 objects.
      yield* files.mkdir("/notes")
      yield* files.mkdir("/published")
      yield* files.writeFile(
        "/notes/hello.txt",
        new TextEncoder().encode("A virtual file, committed as one R2 image."),
        { access: "write", create: "exclusive" }
      )
      yield* files.rename("/notes/hello.txt", "/published/hello.txt")

      return yield* describeNotebook(files, id, durability)
    }))

export const readNotebook = (client: R2LiveImageStore.R2Client, id: string) =>
  Effect.gen(function*() {
    const record = yield* client.read(keyFor(id))

    if (record === null) return null

    // Opening a live volume normally creates a missing image. Pin this read to
    // the observed record so a concurrent deletion cannot recreate the key.
    const snapshotClient: R2LiveImageStore.R2Client = {
      read: () => Effect.succeed(record),
      write: client.write
    }

    return yield* withNotebook(snapshotClient, id, (files, durability) => describeNotebook(files, id, durability)).pipe(
      Effect.catch((error) =>
        client.read(keyFor(id)).pipe(
          Effect.flatMap((current) => current === null ? Effect.succeed(null) : Effect.fail(error))
        )
      )
    )
  })

export const createWithCleanup = <E, R>(
  client: R2LiveImageStore.R2Client,
  id: string,
  remove: Effect.Effect<void, E, R>
) =>
  Effect.gen(function*() {
    // A failed create can leave an image containing only the earlier writes.
    // Report the ID if removal fails so the caller can retry DELETE.
    const created = yield* Effect.exit(createNotebook(client, id))

    if (Exit.isSuccess(created)) return { _tag: "Created" as const, notebook: created.value }

    const cleanup = yield* Effect.exit(remove)

    return {
      _tag: "Failed" as const,
      id,
      cleanup: Exit.isSuccess(cleanup) ? "removed" as const : "retry-delete" as const
    }
  })
