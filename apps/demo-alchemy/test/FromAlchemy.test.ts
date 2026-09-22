import { LiveVolume } from "@effect-vfs/core"
import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import { makeReadWrite, R2Error } from "alchemy/Cloudflare/R2"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { ByteSize, Effect, Layer } from "effect"
import { fromAlchemy } from "../src/from-alchemy.js"

const bytes = (value: string) => new TextEncoder().encode(value)

const text = (value: Uint8Array) => new TextDecoder().decode(value)

const fixture = () => {
  let record: { bytes: Uint8Array; etag: string; customMetadata: Record<string, string> } | null = null
  let revision = 0
  let failNext = false
  let emptyEtagNext = false
  const observed: Array<{ onlyIf: unknown; customMetadata: unknown }> = []

  const asR2Error = (cause: unknown) =>
    new R2Error({
      message: "R2 fixture failure",
      cause: cause instanceof Error ? cause : new Error(String(cause))
    })

  const raw = {
    // oxlint-disable-next-line effecttsgo/async-function -- Mimics the native R2 binding Promise API.
    get: async () =>
      record === null ? null : {
        ...record,
        body: new ReadableStream(),
        bytes: () => Effect.succeed(new Uint8Array(record!.bytes))
      },
    // oxlint-disable-next-line effecttsgo/async-function -- Mimics the native R2 binding Promise API.
    put: async (_key: string, image: Uint8Array, options: {
      onlyIf: { etagMatches?: string; etagDoesNotMatch?: string }
      customMetadata: Record<string, string>
    }) => {
      observed.push(options)

      if (options.onlyIf.etagDoesNotMatch === "*" && record !== null) return null

      if (options.onlyIf.etagMatches !== undefined && record?.etag !== options.onlyIf.etagMatches) return null

      if (failNext) {
        failNext = false
        throw new Error("transport unavailable")
      }

      if (emptyEtagNext) {
        emptyEtagNext = false

        return { bytes: new Uint8Array(image), etag: "", customMetadata: options.customMetadata }
      }

      record = { bytes: new Uint8Array(image), etag: String(++revision), customMetadata: options.customMetadata }

      return { ...record }
    },
    // oxlint-disable-next-line effecttsgo/async-function -- Mimics the native R2 binding Promise API.
    delete: async () => {
      record = null
    }
  }

  const wrap = (object: Awaited<ReturnType<typeof raw.get>> | Awaited<ReturnType<typeof raw.put>>) => {
    if (object === null || "body" in object) return object

    const image = object.bytes

    return { ...object, bytes: () => Effect.succeed(new Uint8Array(image)) }
  }

  // SAFETY: These helpers implement the methods makeReadWrite calls in this test.
  // Its remaining helper fields are unused by get and put.
  const helpers = {
    raw: Effect.succeed(raw),
    use: <T>(fn: (bucket: typeof raw) => Promise<T>) => Effect.tryPromise({ try: () => fn(raw), catch: asR2Error }),
    tryPromise: <T>(fn: () => Promise<T>) => Effect.tryPromise({ try: fn, catch: asR2Error }),
    wrapR2Object: wrap,
    wrapR2ObjectOrBody: wrap
  }

  // SAFETY: The fixture supplies the get/put helpers used by this test path.
  const bucket = makeReadWrite(helpers as never)

  return {
    bucket,
    observed,
    fail: () => {
      failNext = true
    },
    emptyEtag: () => {
      emptyEtagNext = true
    }
  }
}

// SAFETY: makeReadWrite does not read RuntimeContext in this in-memory test.
const clientFrom = (bucket: ReturnType<typeof fixture>["bucket"]) =>
  fromAlchemy(bucket).pipe(Effect.provideService(RuntimeContext, RuntimeContext.of({} as never)))

const storeLayer = (client: R2LiveImageStore.R2Client) =>
  R2LiveImageStore.layer({ client, key: "volume/live", maxImageBytes: ByteSize.kilobytes(64) }).pipe(
    Layer.provide(NodeCrypto.layer)
  )

describe("Alchemy native R2 live image adapter", () => {
  it.effect("forwards metadata and conditional writes, then reopens the image", () =>
    Effect.gen(function*() {
      const remote = fixture()
      const client = yield* clientFrom(remote.bucket)
      assert.strictEqual(yield* client.read("volume/live"), null)

      yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* LiveVolume.LiveImageStore
          assert.strictEqual(text(yield* store.loadOrCreate(bytes("first"))), "first")
          assert.strictEqual(yield* store.commit(bytes("second")), "committed")
        }).pipe(Effect.provide(storeLayer(client)))
      )

      assert.deepStrictEqual(remote.observed.map(({ onlyIf }) => onlyIf), [
        { etagDoesNotMatch: "*" },
        { etagMatches: "1" }
      ])
      const saved = yield* client.read("volume/live")
      assert.strictEqual(saved?.etag, "\"2\"")
      assert.strictEqual(saved?.generation, "1")
      assert.match(saved?.digest ?? "", /^[0-9a-f]{64}$/)
      assert.deepStrictEqual(remote.observed[1]?.customMetadata, {
        generation: saved?.generation,
        digest: saved?.digest
      })

      yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* LiveVolume.LiveImageStore
          assert.strictEqual(text(yield* store.loadOrCreate(bytes("ignored"))), "second")
        }).pipe(Effect.provide(storeLayer(client)))
      )

      yield* client.remove("volume/live")
      assert.strictEqual(yield* client.read("volume/live"), null)
    }))

  it.effect("distinguishes a rejected condition from a storage failure", () =>
    Effect.gen(function*() {
      const remote = fixture()
      const client = yield* clientFrom(remote.bucket)
      assert.deepStrictEqual(yield* client.write("key", bytes("one"), "0", "digest", { ifNoneMatch: "*" }), {
        etag: "\"1\""
      })
      assert.strictEqual(yield* client.write("key", bytes("two"), "1", "digest", { ifNoneMatch: "*" }), null)
      assert.strictEqual(yield* client.write("key", bytes("two"), "1", "digest", { ifMatch: "\"old\"" }), null)
      remote.fail()
      const error = yield* Effect.flip(client.write("key", bytes("two"), "1", "digest", { ifMatch: "\"1\"" }))
      assert.strictEqual(error.code, "Storage")

      remote.emptyEtag()
      const invalidEtag = yield* Effect.flip(client.write("key", bytes("two"), "1", "digest", { ifMatch: "\"1\"" }))
      assert.strictEqual(invalidEtag.code, "Storage")
    }))
})
