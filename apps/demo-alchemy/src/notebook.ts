import { LiveVolume } from "@effect-vfs/core"
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

const open = (client: R2LiveImageStore.R2Client, id: string, mode: "create" | "read") => {
  const store = R2LiveImageStore.layer({
    client,
    key: keyFor(id),
    maxImageBytes: options.maxImageBytes,
    durability: "survives-power-loss"
  }).pipe(Layer.provide(WorkerCrypto.layer))

  return Effect.scoped(Effect.gen(function*() {
    const volume = yield* LiveVolume.open(options)
    const files = yield* volume.caller()

    if (mode === "create") {
      yield* files.mkdir("/notes")
      yield* files.mkdir("/published")
      yield* files.writeFile(
        "/notes/hello.txt",
        new TextEncoder().encode("A virtual file, committed as one R2 image."),
        {
          access: "write",
          create: "exclusive"
        }
      )
      yield* files.rename("/notes/hello.txt", "/published/hello.txt")
    }

    const names = yield* files.readDirectory("/published")
    const content = new TextDecoder().decode(yield* files.readFile("/published/hello.txt"))

    return {
      id,
      files: names.map((name) => `/published/${name}`),
      content,
      durability: volume.durability
    } satisfies Notebook
  })).pipe(Effect.provide(Layer.merge(store, WorkerCrypto.layer)))
}

export const createNotebook = (client: R2LiveImageStore.R2Client, id: string) => open(client, id, "create")

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

    return yield* open(snapshotClient, id, "read").pipe(
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
    const created = yield* Effect.exit(createNotebook(client, id))

    if (Exit.isSuccess(created)) return { _tag: "Created" as const, notebook: created.value }

    const cleanup = yield* Effect.exit(remove)

    return {
      _tag: "Failed" as const,
      id,
      cleanup: Exit.isSuccess(cleanup) ? "removed" as const : "retry-delete" as const
    }
  })
