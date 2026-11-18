import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3"
import { LiveVolume } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, it, vi } from "@effect/vitest"
import { ByteSize, Cause, Context, Effect, Exit, Fiber, Layer, Scope } from "effect"
import * as Digest from "effect/crypto/Digest"
import * as Hex from "effect/encoding/Hex"
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Exercise the native Node S3 response body and its cleanup.
import { Readable } from "node:stream"
import * as R2LiveImageStore from "../src/R2LiveImageStore.js"
import { fromS3 } from "../src/R2S3Transport.js"
import * as R2Store from "../src/R2Store.js"

it("shares the same store and adapter across R2 entrypoints", () => {
  assert.strictEqual(R2LiveImageStore.Client, R2Store.Client)
  assert.strictEqual(R2LiveImageStore.layer, R2Store.layer)
  assert.strictEqual(R2LiveImageStore.fromS3, fromS3)
})

const bytes = (value: string) => new TextEncoder().encode(value)

const makeClient = () => {
  let object: R2LiveImageStore.ObjectRecord | null = null
  let revision = 0

  const client: R2LiveImageStore.R2Client = {
    read: () => Effect.sync(() => object === null ? null : { ...object, bytes: new Uint8Array(object.bytes) }),
    write: (_key, image, generation, digest, condition) =>
      Effect.suspend(() => {
        if ("ifNoneMatch" in condition ? object !== null : object?.etag !== condition.ifMatch) {
          return Effect.succeed(null)
        }

        revision++
        object = { bytes: new Uint8Array(image), etag: `"${revision}"`, generation, digest }

        return Effect.succeed({ etag: object.etag })
      })
  }

  return { client }
}

const layer = (client: R2LiveImageStore.R2Client) =>
  R2LiveImageStore.layer({ key: "volume/live", maxImageBytes: ByteSize.kilobytes(64) }).pipe(
    Layer.provide(Layer.succeed(R2LiveImageStore.Client, client))
  )

const promiseGate = <A>() => {
  let release!: (value: A) => void

  // oxlint-disable-next-line effecttsgo/new-promise -- Keep the fake SDK request pending at its native Promise boundary.
  const promise = new Promise<A>((resolve) => {
    release = resolve
  })

  return { promise, release }
}

const makeS3Fixture = Effect.fnUntraced(function*() {
  const sdk = new S3Client({
    region: "auto",
    endpoint: "https://example.invalid",
    credentials: { accessKeyId: "test", secretAccessKey: "test" }
  })

  const destroy = vi.spyOn(sdk, "destroy")
  yield* Effect.addFinalizer(() => Effect.sync(() => sdk.destroy()))
  const records = new Map<string, R2LiveImageStore.ObjectRecord>()
  let beforeWrite: ((write: () => { ETag: string }) => Promise<{ ETag: string }>) | undefined
  let revision = 0

  const send = vi.spyOn(sdk, "send").mockImplementation((command) => {
    if (command instanceof GetObjectCommand) {
      const record = records.get(command.input.Key!)

      return record === undefined
        ? Promise.reject(
          new S3ServiceException({
            name: "NoSuchKey",
            $fault: "client",
            $metadata: { httpStatusCode: 404 }
          })
        )
        : Promise.resolve({
          Body: new Blob([new Uint8Array(record.bytes)]).stream(),
          ETag: record.etag,
          Metadata: { generation: record.generation, digest: record.digest }
        })
    }

    if (command instanceof PutObjectCommand) {
      const write = () => {
        const { Body, IfMatch, IfNoneMatch, Key, Metadata } = command.input
        const current = records.get(Key!)

        if (IfNoneMatch === "*" ? current !== undefined : current?.etag !== IfMatch) {
          throw new S3ServiceException({
            name: "PreconditionFailed",
            $fault: "client",
            $metadata: { httpStatusCode: 412 }
          })
        }

        const etag = String(++revision)
        assert.instanceOf(Body, Uint8Array)
        records.set(Key!, {
          bytes: new Uint8Array(Body),
          etag,
          generation: Metadata?.["generation"],
          digest: Metadata?.["digest"]
        })

        return { ETag: etag }
      }

      return beforeWrite !== undefined && command.input.Key === "main"
        ? beforeWrite(write)
        : Promise.resolve().then(write)
    }

    throw new Error("unexpected S3 command")
  })

  const transport = R2LiveImageStore.fromS3(sdk, "bucket")

  const open = Effect.fnUntraced(function*(key = "main", maxImageBytes = ByteSize.kibibytes(64)) {
    const scope = yield* Scope.make()
    const close = Scope.close(scope, Exit.void)
    yield* Effect.addFinalizer(() => close)

    const context = yield* Layer.buildWithScope(
      R2LiveImageStore.layer({ key, maxImageBytes }).pipe(
        Layer.provide(Layer.succeed(R2LiveImageStore.Client, transport))
      ),
      scope
    )

    return { store: Context.get(context, LiveVolume.LiveImageStore), close }
  })

  const holdWrite = (appliedBeforeRelease = false) => {
    const entered = promiseGate<void>()
    const release = promiseGate<void>()
    beforeWrite = (write) => {
      beforeWrite = undefined
      const result = appliedBeforeRelease ? write() : undefined
      entered.release()

      return release.promise.then(() => result ?? write())
    }

    return {
      await: Effect.promise(() => entered.promise),
      release: Effect.sync(() => release.release())
    }
  }

  return { open, holdWrite, destroy, send }
})

const volumeOptions = { maxImageBytes: ByteSize.kibibytes(64), volume: {} }

it.layer(NodeCrypto.layer)("R2 live image store", (it) => {
  for (const responsePending of [false, true]) {
    it.effect(
      responsePending
        ? "drains an undelivered S3 acknowledgement after a direct commit is interrupted"
        : "drains a delayed S3 write after a direct commit is interrupted",
      () =>
        Effect.gen(function*() {
          const s3 = yield* makeS3Fixture()
          const owner = yield* s3.open()
          const other = yield* s3.open("other")
          yield* owner.store.loadOrCreate(bytes("before"))
          yield* other.store.loadOrCreate(bytes("other"))
          const held = s3.holdWrite(responsePending)
          const input = bytes("after")

          yield* Effect.gen(function*() {
            const writing = yield* Effect.forkChild(owner.store.commit(input))
            yield* held.await
            yield* Fiber.interrupt(writing)
            assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(writing)))
            const writes = s3.send.mock.calls.length
            assert.strictEqual(yield* owner.store.commit(bytes("blocked")), "unknown")
            assert.strictEqual(s3.send.mock.calls.length, writes)

            // A transport may consume the request body after its caller returns.
            input.fill(0)
            const closing = yield* Effect.forkChild(owner.close, { startImmediately: true })

            yield* Effect.gen(function*() {
              assert.isUndefined(closing.pollUnsafe())
              assert.strictEqual(yield* other.store.commit(bytes("still open")), "committed")
              assert.isUndefined(closing.pollUnsafe())
              assert.strictEqual(s3.destroy.mock.calls.length, 0)
            }).pipe(Effect.ensuring(held.release))

            yield* Fiber.join(closing)
            const replacement = yield* s3.open()
            assert.deepStrictEqual(yield* replacement.store.loadOrCreate(bytes("ignored")), bytes("after"))
            assert.strictEqual(yield* replacement.store.commit(bytes("replacement")), "committed")
            yield* replacement.close
            assert.deepStrictEqual(
              yield* (yield* s3.open()).store.loadOrCreate(bytes("ignored")),
              bytes("replacement")
            )
          }).pipe(Effect.ensuring(held.release))
        })
    )
  }

  it.effect("drains create-only S3 initialization when LiveVolume.open is interrupted", () =>
    Effect.gen(function*() {
      const s3 = yield* makeS3Fixture()
      const owner = yield* s3.open()
      const held = s3.holdWrite()

      yield* Effect.gen(function*() {
        const opening = yield* Effect.forkChild(
          LiveVolume.open(volumeOptions).pipe(
            Effect.provideService(LiveVolume.LiveImageStore, owner.store),
            Effect.scoped
          )
        )

        yield* held.await
        const command = s3.send.mock.calls.at(-1)?.[0]
        assert.instanceOf(command, PutObjectCommand)
        assert.strictEqual(command.input.IfNoneMatch, "*")
        yield* Fiber.interrupt(opening)
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(opening)))
        const closing = yield* Effect.forkChild(owner.close, { startImmediately: true })

        yield* Effect.sync(() => assert.isUndefined(closing.pollUnsafe())).pipe(Effect.ensuring(held.release))
        yield* Fiber.join(closing)

        const replacement = yield* s3.open()

        const volume = yield* LiveVolume.open(volumeOptions).pipe(
          Effect.provideService(LiveVolume.LiveImageStore, replacement.store)
        )

        assert.strictEqual((yield* (yield* volume.caller()).stat("/")).kind, "directory")
        assert.strictEqual(s3.send.mock.calls.filter(([command]) => command instanceof PutObjectCommand).length, 1)
      }).pipe(Effect.ensuring(held.release))
    }))

  it.effect("drains a pending S3 response body after its reader is interrupted", () =>
    Effect.gen(function*() {
      const s3 = yield* makeS3Fixture()
      const owner = yield* s3.open()
      const readingBody = promiseGate<void>()
      const body = promiseGate<Uint8Array>()
      s3.send.mockImplementationOnce(() =>
        Promise.resolve({
          Body: new ReadableStream({
            pull(controller) {
              readingBody.release()

              return body.promise.then((chunk) => {
                controller.enqueue(chunk)
                controller.close()
              })
            }
          }, { highWaterMark: 0 })
        })
      )
      const release = Effect.sync(() => body.release(bytes("body")))

      yield* Effect.gen(function*() {
        const reading = yield* Effect.forkChild(owner.store.loadOrCreate(bytes("initial")))
        yield* Effect.promise(() => readingBody.promise)
        yield* Fiber.interrupt(reading)
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(reading)))
        const closing = yield* Effect.forkChild(owner.close, { startImmediately: true })

        yield* Effect.sync(() => assert.isUndefined(closing.pollUnsafe())).pipe(Effect.ensuring(release))
        yield* Fiber.join(closing)
        assert.strictEqual(s3.send.mock.calls.length, 1)
      }).pipe(Effect.ensuring(release))
    }))

  it.effect("passes the original store limit to a custom bounded transport", () =>
    Effect.gen(function*() {
      const options = { key: "main", maxImageBytes: ByteSize.bytes(4) }
      const { client } = makeClient()
      const read = vi.fn(client.read)
      const readBounded = vi.fn((_key: string, _limit: ByteSize.ByteSize) => Effect.succeed(null))

      const context = yield* Layer.build(
        R2LiveImageStore.layer(options).pipe(
          Layer.provide(Layer.succeed(R2LiveImageStore.Client, { ...client, read, readBounded }))
        )
      )

      options.maxImageBytes = ByteSize.bytes(10)

      const store = Context.get(context, LiveVolume.LiveImageStore)
      assert.deepStrictEqual(yield* store.loadOrCreate(bytes("a")), bytes("a"))
      assert.deepStrictEqual(readBounded.mock.calls, [["main", ByteSize.bytes(4)]])
      assert.strictEqual(read.mock.calls.length, 0)
    }))

  it.effect("releases a known oversized S3 body without consuming it", () =>
    Effect.gen(function*() {
      const s3 = yield* makeS3Fixture()
      const owner = yield* s3.open("main", ByteSize.bytes(4))
      const read = vi.fn()
      const transformToByteArray = vi.fn(() => Promise.resolve(bytes("abcde")))
      const body = Object.assign(new Readable({ read }), { transformToByteArray })
      s3.send.mockImplementationOnce(() => Promise.resolve({ Body: body, ContentLength: 5 }))

      const error = yield* Effect.flip(owner.store.loadOrCreate(bytes("a")))

      assert.deepStrictEqual([error.code, error.operation], ["CorruptStore", "R2LiveImageStore.loadOrCreate"])
      assert.strictEqual(read.mock.calls.length, 0)
      assert.strictEqual(transformToByteArray.mock.calls.length, 0)
      assert.isTrue(body.destroyed)
      assert.strictEqual(s3.send.mock.calls.length, 1)
    }))

  for (const contentLength of [undefined, 2]) {
    it.effect(`stops and cancels an oversized S3 stream with ContentLength ${contentLength}`, () =>
      Effect.gen(function*() {
        const s3 = yield* makeS3Fixture()
        const owner = yield* s3.open("main", ByteSize.bytes(4))
        const cancel = vi.fn()
        let consumed = 0

        const body = new ReadableStream({
          pull(controller) {
            const chunk = bytes("ab")
            consumed += chunk.length
            controller.enqueue(chunk)
          },
          cancel
        }, { highWaterMark: 0 })

        s3.send.mockImplementationOnce(() => Promise.resolve({ Body: body, ContentLength: contentLength }))

        const error = yield* Effect.flip(owner.store.loadOrCreate(bytes("a")))

        assert.deepStrictEqual([error.code, error.operation], ["CorruptStore", "R2LiveImageStore.loadOrCreate"])
        assert.strictEqual(consumed, 6)
        assert.strictEqual(cancel.mock.calls.length, 1)
        assert.isFalse(body.locked)
        assert.strictEqual(s3.send.mock.calls.length, 1)
      }))
  }

  it.effect("accepts exact-limit and empty chunked S3 images", () =>
    Effect.gen(function*() {
      const s3 = yield* makeS3Fixture()
      const digest = yield* Digest.Digest

      for (const chunks of [[bytes("ab"), bytes("cd")], []]) {
        const image = bytes(chunks.length === 0 ? "" : "abcd")
        const hash = Hex.encode(yield* digest.digest(Digest.sha256, image))
        const owner = yield* s3.open("main", ByteSize.bytes(4))
        const body = Readable.from(chunks, { objectMode: false })
        s3.send.mockImplementationOnce(() =>
          Promise.resolve({
            Body: body,
            ETag: "version",
            Metadata: { generation: "0", digest: hash }
          })
        )

        assert.deepStrictEqual(yield* owner.store.loadOrCreate(bytes("a")), image)
        assert.isTrue(body.readableEnded)
        yield* owner.close
      }
    }))

  it.effect("keeps a settled but unacknowledged S3 write uncertain", () =>
    Effect.gen(function*() {
      const s3 = yield* makeS3Fixture()
      const owner = yield* s3.open()
      yield* owner.store.loadOrCreate(bytes("before"))
      s3.send.mockRejectedValueOnce(new Error("network failure"))
      assert.strictEqual(yield* owner.store.commit(bytes("attempt")), "unknown")
      const requests = s3.send.mock.calls.length

      assert.strictEqual(yield* owner.store.commit(bytes("retry")), "unknown")
      assert.strictEqual(s3.send.mock.calls.length, requests)
      yield* owner.close
    }))

  it.effect("does not start a PUT through a retained store after its scope closes", () =>
    Effect.gen(function*() {
      const s3 = yield* makeS3Fixture()
      const owner = yield* s3.open()
      yield* owner.store.loadOrCreate(bytes("saved"))
      yield* owner.close
      const requests = s3.send.mock.calls.length

      assert.isTrue(Exit.hasInterrupts(yield* Effect.exit(owner.store.commit(bytes("late")))))
      assert.strictEqual(s3.send.mock.calls.length, requests)
      assert.deepStrictEqual(yield* (yield* s3.open()).store.loadOrCreate(bytes("ignored")), bytes("saved"))
    }))

  it.effect("retains LiveVolume mutation masking while an S3 write is pending", () =>
    Effect.gen(function*() {
      const s3 = yield* makeS3Fixture()
      const owner = yield* s3.open()

      const volume = yield* LiveVolume.open(volumeOptions).pipe(
        Effect.provideService(LiveVolume.LiveImageStore, owner.store)
      )

      const caller = yield* volume.caller()
      const held = s3.holdWrite()

      yield* Effect.gen(function*() {
        const writing = yield* Effect.forkChild(caller.mkdir("/applied"))
        yield* held.await
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(writing), { startImmediately: true })

        yield* Effect.sync(() => assert.isUndefined(interrupting.pollUnsafe())).pipe(Effect.ensuring(held.release))
        yield* Fiber.join(interrupting)
        assert.strictEqual((yield* caller.stat("/applied")).kind, "directory")
        yield* caller.mkdir("/still available")
      }).pipe(Effect.ensuring(held.release))
    }))

  it.effect("keeps owners independent while borrowing one supplied transport", () =>
    Effect.gen(function*() {
      const objects = new Map<string, R2LiveImageStore.ObjectRecord>()
      let revision = 0
      let released = false

      const client: R2LiveImageStore.R2Client = {
        read: (key) => Effect.sync(() => objects.get(key) ?? null),
        write: (key, image, generation, digest, condition) =>
          Effect.sync(() => {
            const stored = objects.get(key)

            if ("ifNoneMatch" in condition ? stored !== undefined : stored?.etag !== condition.ifMatch) return null
            const etag = String(++revision)
            objects.set(key, { bytes: new Uint8Array(image), generation, digest, etag })

            return { etag }
          })
      }

      const clientScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(clientScope, Exit.void))

      const supplied = yield* Layer.buildWithScope(
        Layer.effect(
          R2LiveImageStore.Client,
          Effect.acquireRelease(Effect.succeed(client), () =>
            Effect.sync(() => {
              released = true
            }))
        ),
        clientScope
      )

      const open = Effect.fnUntraced(function*(key: string) {
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

        const context = yield* Layer.buildWithScope(
          R2LiveImageStore.layer({ key, maxImageBytes: ByteSize.bytes(16) }).pipe(
            Layer.provide(Layer.succeed(R2LiveImageStore.Client, Context.get(supplied, R2LiveImageStore.Client)))
          ),
          scope
        )

        return { store: Context.get(context, LiveVolume.LiveImageStore), close: Scope.close(scope, Exit.void) }
      })

      const a = yield* open("a")
      const b = yield* open("b")
      assert.deepStrictEqual(yield* a.store.loadOrCreate(bytes("a")), bytes("a"))
      assert.deepStrictEqual(yield* b.store.loadOrCreate(bytes("b")), bytes("b"))
      yield* a.close
      assert.isFalse(released)
      assert.strictEqual(yield* b.store.commit(bytes("updated")), "committed")
      const reopened = yield* open("a")
      assert.deepStrictEqual(yield* reopened.store.loadOrCreate(bytes("ignored")), bytes("a"))
      yield* reopened.close
      yield* b.close
      assert.isFalse(released)
      yield* Scope.close(clientScope, Exit.void)
      assert.isTrue(released)
    }))

  for (const synchronousThrow of [false, true]) {
    it.effect(`should preserve pre-write digest ${synchronousThrow ? "throws" : "defects"} without disabling the live volume`, () =>
      Effect.gen(function*() {
        const digest = yield* Digest.Digest
        const remote = makeClient()
        let failed = false
        let writes = 0
        const defect = new Error("digest failed before write")

        const client = {
          ...remote.client,
          write: (...args: Parameters<R2LiveImageStore.R2Client["write"]>) => {
            writes++

            return remote.client.write(...args)
          }
        }

        const context = yield* Layer.build(layer(client)).pipe(
          Effect.provideService(Digest.Digest, {
            ...digest,
            digest: (algorithm, bytes) => {
              if (failed && synchronousThrow) throw defect

              return failed ? Effect.die(defect) : digest.digest(algorithm, bytes)
            }
          })
        )

        const volume = yield* LiveVolume.open(volumeOptions).pipe(Effect.provide(context))
        const caller = yield* volume.caller()
        const before = writes
        failed = true
        const result = yield* Effect.exit(caller.mkdir("/failed"))
        assert.isTrue(Exit.isFailure(result))

        if (Exit.isFailure(result)) assert.strictEqual(Cause.squash(result.cause), defect)
        assert.strictEqual(writes, before)
        assert.strictEqual((yield* Effect.flip(caller.stat("/failed"))).code, "NotFound")
        failed = false
        yield* caller.mkdir("/retry")
        assert.strictEqual((yield* caller.stat("/retry")).kind, "directory")
      }))
  }

  it.effect("should report power-loss durability when the application qualifies the R2 transport", () =>
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

      const unqualified = yield* Effect.scoped(LiveVolume.open(options).pipe(Effect.provide(layer(remote.client))))

      assert.strictEqual(unqualified.durability, "memory-only")

      const qualifiedStore = R2LiveImageStore.layer({
        key: "volume/live",
        maxImageBytes: options.maxImageBytes,
        durability: "survives-power-loss"
      }).pipe(Layer.provide(Layer.succeed(R2LiveImageStore.Client, remote.client)))

      const qualified = yield* Effect.scoped(LiveVolume.open(options).pipe(Effect.provide(qualifiedStore)))

      assert.strictEqual(qualified.durability, "survives-power-loss")
    }))

  it.effect("should name the layer in the error when an option is invalid", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        LiveVolume.LiveImageStore.pipe(
          Effect.provide(
            R2LiveImageStore.layer({ key: "", maxImageBytes: ByteSize.kilobytes(64) }).pipe(
              Layer.provide(Layer.succeed(R2LiveImageStore.Client, makeClient().client))
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

  for (const generation of [undefined, "", "01", "+1", "1.0", "1e0", "-1", "9007199254740992"]) {
    it.effect(`should reject noncanonical stored generation ${generation}`, () =>
      Effect.gen(function*() {
        const client: R2LiveImageStore.R2Client = {
          read: () =>
            Effect.succeed({
              bytes: new Uint8Array(),
              etag: "version",
              generation,
              digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            }),
          write: () => Effect.succeed(null)
        }

        const error = yield* LiveVolume.LiveImageStore.pipe(
          Effect.flatMap((store) => Effect.flip(store.loadOrCreate(bytes("initial")))),
          Effect.provide(layer(client))
        )

        assert.deepStrictEqual([error.code, error.operation], ["CorruptStore", "R2LiveImageStore.loadOrCreate"])
      }))
  }
})
