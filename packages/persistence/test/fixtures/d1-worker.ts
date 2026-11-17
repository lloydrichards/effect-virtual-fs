/* oxlint-disable effecttsgo/crypto-random-uuid -- Each qualification request uses a fresh key, so independent requests never share a live owner. */
import { LiveVolume } from "@effect-vfs/core"
import * as D1Client from "@effect/sql-d1/D1Client"
import { ByteSize, Effect, Layer, Schema } from "effect"
import * as Digest from "effect/crypto/Digest"
import * as D1 from "../../src/D1LiveImageStore.js"

const Receipt = Schema.Struct({
  success: Schema.Literal(true),
  results: Schema.Array(Schema.Struct({ generation: Schema.Finite })),
  meta: Schema.Struct({ served_by_primary: Schema.Literal(true) })
})

const qualify = Effect.fnUntraced(function*(db: D1Client.D1ClientConfig["db"], key: string) {
  const store = D1.layer({ key, maxImageBytes: ByteSize.mebibytes(1) }).pipe(
    Layer.provide(D1Client.layer({ db }))
  )

  const bytes = new Uint8Array(1_048_576)
  bytes[bytes.length - 1] = 255
  const check = (condition: boolean) => condition ? Effect.void : Effect.die("D1 qualification assertion failed")

  return yield* Effect.gen(function*() {
    yield* Effect.gen(function*() {
      const image = yield* LiveVolume.LiveImageStore
      yield* check(image.durability === "memory-only")
      const created = yield* image.loadOrCreate(new Uint8Array([99, 0, 255, 8]).subarray(1, 3))
      yield* check(created.length === 2 && created[0] === 0 && created[1] === 255)
      yield* check((yield* image.commit(bytes)) === "committed")
      yield* check((yield* image.commit(new Uint8Array(1_048_577))) === "rejected")
    }).pipe(Effect.provide(store))
    yield* Effect.gen(function*() {
      const image = yield* LiveVolume.LiveImageStore
      const loaded = yield* image.loadOrCreate(new Uint8Array())
      yield* check(loaded.length === bytes.length && loaded[loaded.length - 1] === 255)
      yield* check((yield* image.commit(new Uint8Array())) === "committed")
    }).pipe(Effect.provide(store))
    yield* Effect.gen(function*() {
      const image = yield* LiveVolume.LiveImageStore
      yield* check((yield* image.loadOrCreate(bytes)).length === 0)
    }).pipe(Effect.provide(store))

    const receipt = yield* Effect.promise(() =>
      db.prepare("SELECT generation FROM effect_vfs_live_images WHERE volume_key = ?").bind(key).all()
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Receipt)))

    yield* check(receipt.results.length === 1 && receipt.results[0]?.generation === 2)

    const stale = yield* Effect.promise(() =>
      db.prepare(
        "UPDATE effect_vfs_live_images SET generation = 3 WHERE volume_key = ? AND generation = 1 RETURNING generation"
      ).bind(key).all()
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Receipt)))

    yield* check(stale.results.length === 0)

    return { status: "passed", primary: true, imageBytes: bytes.length, generation: 2, durability: "memory-only" }
  }).pipe(
    Effect.ensuring(
      Effect.promise(() => db.prepare("DELETE FROM effect_vfs_live_images WHERE volume_key = ?").bind(key).run())
    )
  )
}, Effect.provide(Digest.layerWebCrypto))

export default {
  fetch(_request: Request, env: { readonly DB: D1Client.D1ClientConfig["db"] }): Promise<Response> {
    return Effect.runPromise(qualify(env.DB, `qualification-${crypto.randomUUID()}`)).then(
      (report) => Response.json(report),
      (error) => new Response(String(error), { status: 500 })
    )
  }
}
