import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3"
import { LiveVolume, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, describe, it, vi } from "@effect/vitest"
import { ByteSize, Deferred, Effect, Layer } from "effect"
import * as R2LiveImageStore from "../src/R2LiveImageStore.js"

const bytes = (value: string) => new TextEncoder().encode(value)

const text = (value: Uint8Array) => new TextDecoder().decode(value)

const makeClient = () => {
  let object: R2LiveImageStore.ObjectRecord | null = null
  let revision = 0
  let loseNextReply = false

  const client: R2LiveImageStore.R2Client = {
    read: () => Effect.sync(() => object === null ? null : { ...object, bytes: new Uint8Array(object.bytes) }),
    write: (_key, image, generation, digest, condition) =>
      Effect.suspend(() => {
        if ("ifNoneMatch" in condition ? object !== null : object?.etag !== condition.ifMatch) {
          return Effect.succeed(null)
        }

        revision++
        object = { bytes: new Uint8Array(image), etag: `"${revision}"`, generation, digest }

        if (loseNextReply) {
          loseNextReply = false

          return Effect.fail(
            new Vfs.VfsError({ code: "Storage", operation: "FakeR2", cause: new Error("reply lost after write") })
          )
        }

        return Effect.succeed({ etag: object.etag })
      })
  }

  return {
    client,
    loseReply: () => {
      loseNextReply = true
    },
    damage: () => {
      if (object) object.bytes[0] = 0
    }
  }
}

const layer = (client: R2LiveImageStore.R2Client) =>
  R2LiveImageStore.layer({ client, key: "volume/live", maxImageBytes: ByteSize.kilobytes(64) }).pipe(
    Layer.provide(NodeCrypto.layer)
  )

describe("R2 live image store", () => {
  it.effect("reports power-loss durability only when the application qualifies the R2 transport", () =>
    Effect.gen(function*() {
      const remote = makeClient()

      const options = {
        maxImageBytes: ByteSize.kilobytes(64),
        volume: {
          maxEntries: 100,
          maxBytes: ByteSize.kilobytes(32),
          maxFileBytes: ByteSize.kilobytes(16),
          maxPathBytes: ByteSize.bytes(1024)
        }
      }

      const unqualifiedServices = Layer.merge(layer(remote.client), NodeCrypto.layer)

      const unqualified = yield* Effect.scoped(LiveVolume.open(options).pipe(Effect.provide(unqualifiedServices)))

      assert.strictEqual(unqualified.durability, "memory-only")

      const qualifiedStore = R2LiveImageStore.layer({
        client: remote.client,
        key: "volume/live",
        maxImageBytes: options.maxImageBytes,
        durability: "survives-power-loss"
      }).pipe(Layer.provide(NodeCrypto.layer))

      const qualifiedServices = Layer.merge(qualifiedStore, NodeCrypto.layer)
      const qualified = yield* Effect.scoped(LiveVolume.open(options).pipe(Effect.provide(qualifiedServices)))

      assert.strictEqual(qualified.durability, "survives-power-loss")
    }))

  it.effect("reopens the last acknowledged complete image", () =>
    Effect.gen(function*() {
      const remote = makeClient()
      yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* LiveVolume.LiveImageStore
          assert.strictEqual(text(yield* store.loadOrCreate(bytes("initial"))), "initial")
          assert.strictEqual(yield* store.commit(bytes("updated")), "committed")
        }).pipe(Effect.provide(layer(remote.client)))
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* LiveVolume.LiveImageStore
          assert.strictEqual(text(yield* store.loadOrCreate(bytes("ignored"))), "updated")
        }).pipe(Effect.provide(layer(remote.client)))
      )
    }))

  it.effect("freezes the old owner after a competing write", () =>
    Effect.scoped(Effect.gen(function*() {
      const remote = makeClient()
      const first = yield* LiveVolume.LiveImageStore.pipe(Effect.provide(layer(remote.client)))
      const second = yield* LiveVolume.LiveImageStore.pipe(Effect.provide(layer(remote.client)))
      yield* first.loadOrCreate(bytes("initial"))
      yield* second.loadOrCreate(bytes("ignored"))
      assert.strictEqual(yield* first.commit(bytes("winner")), "committed")
      assert.strictEqual(yield* second.commit(bytes("stale")), "unknown")
      assert.strictEqual(yield* second.commit(bytes("retry")), "unknown")
    })))

  it.effect("recovers a complete image after a lost commit reply", () =>
    Effect.gen(function*() {
      const remote = makeClient()
      yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* LiveVolume.LiveImageStore
          yield* store.loadOrCreate(bytes("old"))
          remote.loseReply()
          assert.strictEqual(yield* store.commit(bytes("new")), "unknown")
          assert.strictEqual(yield* store.commit(bytes("retry")), "unknown")
        }).pipe(Effect.provide(layer(remote.client)))
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* LiveVolume.LiveImageStore
          assert.strictEqual(text(yield* store.loadOrCreate(bytes("ignored"))), "new")
        }).pipe(Effect.provide(layer(remote.client)))
      )
    }))

  it.effect("rejects an image whose stored digest does not match", () =>
    Effect.gen(function*() {
      const remote = makeClient()
      yield* Effect.scoped(
        Effect.gen(function*() {
          yield* (yield* LiveVolume.LiveImageStore).loadOrCreate(bytes("good"))
        }).pipe(Effect.provide(layer(remote.client)))
      )
      remote.damage()

      const error = yield* Effect.flip(Effect.scoped(
        Effect.gen(function*() {
          return yield* (yield* LiveVolume.LiveImageStore).loadOrCreate(bytes("ignored"))
        }).pipe(Effect.provide(layer(remote.client)))
      ))

      assert.deepStrictEqual([error.code, error.operation], ["CorruptStore", "R2LiveImageStore.loadOrCreate"])
    }))

  it.effect("names the layer as the operation of a rejected option", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        LiveVolume.LiveImageStore.pipe(
          Effect.provide(
            R2LiveImageStore.layer({ client: makeClient().client, key: "", maxImageBytes: ByteSize.kilobytes(64) })
              .pipe(
                Layer.provide(NodeCrypto.layer)
              )
          )
        )
      )

      assert.deepStrictEqual([error.code, error.operation, error.field], [
        "InvalidArgument",
        "R2LiveImageStore.layer",
        "options"
      ])
    }))

  // A commit that was already writing when another one froze the store must not unfreeze it when it lands.
  it.effect("stays frozen when an earlier commit lands after a later one lost its reply", () =>
    Effect.scoped(Effect.gen(function*() {
      const held = yield* Deferred.make<void>()
      const lost = yield* Deferred.make<void>()
      let writes = 0
      let etag = 0

      const client: R2LiveImageStore.R2Client = {
        read: () => Effect.succeed(null),
        write: () =>
          Effect.suspend(() => {
            const write = writes++

            if (write === 1) return Deferred.await(held).pipe(Effect.as({ etag: `"${++etag}"` }))

            if (write === 2) {
              return Effect.fail(new Vfs.VfsError({ code: "Storage", operation: "FakeR2" })).pipe(
                Effect.ensuring(Deferred.succeed(lost, undefined))
              )
            }

            return Effect.succeed({ etag: `"${++etag}"` })
          })
      }

      const store = yield* LiveVolume.LiveImageStore.pipe(Effect.provide(layer(client)))
      yield* store.loadOrCreate(bytes("initial"))
      const release = Deferred.await(lost).pipe(Effect.andThen(Deferred.succeed(held, undefined)))

      const [early, late] = yield* Effect.all([store.commit(bytes("early")), store.commit(bytes("late")), release], {
        concurrency: "unbounded"
      })

      assert.deepStrictEqual([early, late], ["committed", "unknown"])
      assert.strictEqual(yield* store.commit(bytes("after")), "unknown")
    })))

  it.effect("sends an ETag condition through the S3 client", () =>
    Effect.gen(function*() {
      const commands: Array<PutObjectCommand> = []

      const fake = new S3Client({
        region: "auto",
        endpoint: "https://example.invalid",
        credentials: {
          accessKeyId: "test",
          secretAccessKey: "test"
        }
      })

      vi.spyOn(fake, "send").mockImplementation((command) => {
        if (command instanceof GetObjectCommand) {
          return Promise.resolve({
            Body: { transformToByteArray: () => Promise.resolve(bytes("stored")) },
            ETag: "\"first\"",
            Metadata: { generation: "0", digest: "test" }
          })
        }

        if (command instanceof PutObjectCommand) {
          commands.push(command)

          return Promise.resolve({ ETag: "\"second\"" })
        }

        throw new Error("unexpected S3 command")
      })

      const client = R2LiveImageStore.fromS3(fake, "bucket")
      assert.strictEqual(text((yield* client.read("key"))!.bytes), "stored")
      yield* client.write("key", bytes("next"), "1", "digest", { ifMatch: "\"first\"" })
      assert.strictEqual(commands[0]?.input.IfMatch, "\"first\"")
      assert.strictEqual(commands[0]?.input.Metadata?.["generation"], "1")
      fake.destroy()
    }))

  it.effect("treats a missing key as absent but keeps a missing bucket as an error", () =>
    Effect.gen(function*() {
      const fake = new S3Client({
        region: "auto",
        endpoint: "https://example.invalid",
        credentials: {
          accessKeyId: "test",
          secretAccessKey: "test"
        }
      })

      const send = vi.spyOn(fake, "send")
      send.mockRejectedValue(
        new S3ServiceException({
          name: "NoSuchKey",
          $fault: "client",
          $metadata: { httpStatusCode: 404 }
        })
      )
      assert.strictEqual(yield* R2LiveImageStore.fromS3(fake, "bucket").read("key"), null)

      send.mockRejectedValue(
        new S3ServiceException({
          name: "NoSuchBucket",
          $fault: "client",
          $metadata: { httpStatusCode: 404 }
        })
      )
      const error = yield* Effect.flip(R2LiveImageStore.fromS3(fake, "bucket").read("key"))
      assert.strictEqual(error.cause instanceof S3ServiceException && error.cause.name, "NoSuchBucket")
      assert.strictEqual(error.operation, "R2LiveImageStore.fromS3")
      fake.destroy()
    }))
})
