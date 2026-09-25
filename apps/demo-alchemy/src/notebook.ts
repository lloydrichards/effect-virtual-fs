import { LiveVolume, type VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
import * as ByteSize from "effect/ByteSize"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import type * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

export interface NotebookR2Client extends R2LiveImageStore.R2Client {
  readonly remove: (key: string) => Effect.Effect<void, Vfs.VfsError>
}

/** Request-bound image transport, including deletion. */
export class NotebookR2 extends Context.Service<NotebookR2, NotebookR2Client>()(
  "@repo/alchemy-vfs-demo/NotebookR2"
) {}

const options = {
  maxImageBytes: ByteSize.kilobytes(64),
  volume: {
    maxEntries: 100,
    maxBytes: ByteSize.kilobytes(32),
    maxFileBytes: ByteSize.kilobytes(16),
    maxPathBytes: ByteSize.bytes(1024)
  }
}

const authorIdentity = { uid: 1000, gid: 1000, groups: [], privileged: false } satisfies Vfs.Identity

const readerIdentity = { uid: 2000, gid: 2000, groups: [], privileged: false } satisfies Vfs.Identity

const encoder = new TextEncoder()

const decoder = new TextDecoder()

export const keyFor = (id: string) => `effect-vfs-notebooks/${id}`

export const Notebook = Schema.Struct({
  id: Schema.String,
  files: Schema.Array(Schema.String),
  content: Schema.String
})

export type CreateResult = Result.Result<typeof Notebook.Type, {
  readonly id: string
  readonly cleanup: "removed" | "retry-delete"
}>

export interface NotebookOperations {
  readonly create: Effect.Effect<CreateResult, PlatformError.PlatformError>
  readonly read: (id: string) => Effect.Effect<
    typeof Notebook.Type | null,
    Vfs.VfsError
  >
  readonly remove: (id: string) => Effect.Effect<void, Vfs.VfsError>
}

const make = Effect.gen(function*() {
  const client = yield* NotebookR2
  const crypto = yield* Crypto.Crypto

  const withNotebook = <A, E, R>(
    imageClient: R2LiveImageStore.R2Client,
    id: string,
    use: (volume: Vfs.Volume) => Effect.Effect<A, E, R>
  ) => {
    // Each operation owns its volume scope; a later request reloads the image.
    const store = R2LiveImageStore.layer({
      client: imageClient,
      key: keyFor(id),
      maxImageBytes: options.maxImageBytes,
      durability: "survives-power-loss"
    })

    return Effect.scoped(Effect.gen(function*() {
      const volume = yield* LiveVolume.open(options)

      return yield* use(volume)
    })).pipe(Effect.provide(store), Effect.provideService(Crypto.Crypto, crypto))
  }

  const createNotebook = Effect.fn("Notebook.create")(function*(id: string) {
    return yield* withNotebook(client, id, (volume) =>
      Effect.gen(function*() {
        const bootstrap = yield* volume.caller({ umask: 0 })
        yield* bootstrap.mkdir("/notes", { mode: 0o700 })
        yield* bootstrap.mkdir("/published", { mode: 0o755 })
        yield* bootstrap.chown("/notes", { uid: authorIdentity.uid, gid: authorIdentity.gid })
        yield* bootstrap.chown("/published", { uid: authorIdentity.uid, gid: authorIdentity.gid })

        const author = yield* volume.caller({ identity: authorIdentity, umask: 0o022 })
        const notes = yield* author.withDirectory("/notes")
        yield* notes.writeFile("hello.txt", encoder.encode("A virtual file, committed as one R2 image."), {
          access: "write",
          create: "exclusive",
          mode: 0o644
        })
        yield* author.rename("/notes/hello.txt", "/published/hello.txt")

        const reader = yield* volume.caller({ identity: readerIdentity, umask: 0o022 })

        const names = (yield* reader.readDirectory("/published")).value.map((entry) =>
          new TextDecoder().decode(entry.name)
        )

        const content = decoder.decode(yield* reader.readFile("/published/hello.txt"))

        return {
          id,
          files: names.map((name) => `/published/${name}`),
          content
        }
      }))
  })

  const readNotebook = Effect.fn("Notebook.read")(function*(id: string) {
    const record = yield* client.read(keyFor(id))

    if (record === null) return null

    // Pin the observed image so a deletion cannot make open create a new one.
    const snapshotClient: R2LiveImageStore.R2Client = {
      read: () => Effect.succeed(record),
      write: client.write
    }

    return yield* withNotebook(
      snapshotClient,
      id,
      (volume) =>
        Effect.gen(function*() {
          const reader = yield* volume.caller({ identity: readerIdentity, umask: 0o022 })

          const names = (yield* reader.readDirectory("/published")).value.map((entry) =>
            new TextDecoder().decode(entry.name)
          )

          const content = decoder.decode(yield* reader.readFile("/published/hello.txt"))

          return {
            id,
            files: names.map((name) => `/published/${name}`),
            content
          }
        })
    ).pipe(
      Effect.catch((error) =>
        client.read(keyFor(id)).pipe(
          Effect.flatMap((current) => current === null ? Effect.succeed(null) : Effect.fail(error))
        )
      )
    )
  })

  const create = Effect.gen(function*() {
    const id = yield* crypto.randomUUIDv4

    // A failed create can leave an image containing only the earlier writes.
    const created = yield* Effect.exit(createNotebook(id))

    if (Exit.isSuccess(created)) return Result.succeed(created.value)

    const cleanup = yield* Effect.exit(client.remove(keyFor(id)))

    return Result.fail({
      id,
      cleanup: Exit.isSuccess(cleanup) ? "removed" as const : "retry-delete" as const
    })
  }).pipe(Effect.withSpan("Notebook.createWithCleanup"))

  const remove = Effect.fn("Notebook.remove")(function*(id: string) {
    return yield* client.remove(keyFor(id))
  })

  return { create, read: readNotebook, remove } satisfies NotebookOperations
})

/** Notebook operations; their R2 transport and filesystem scope are private. */
export class NotebookService extends Context.Service<NotebookService, NotebookOperations>()(
  "@repo/alchemy-vfs-demo/NotebookService"
) {
  static readonly Live = Layer.effect(this, make)
}
