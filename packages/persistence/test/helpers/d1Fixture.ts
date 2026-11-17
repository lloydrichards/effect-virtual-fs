/* oxlint-disable effecttsgo/async-function -- D1 binding methods are native Promise boundaries; hooks control real Miniflare statements. */
import { LiveVolume, type VfsError } from "@effect-vfs/core"
import * as D1Client from "@effect/sql-d1/D1Client"
import { ByteSize, Cause, Context, Effect, Exit, FileSystem, Layer, Path, Schema, Scope } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import type { SqlClient } from "effect/sql/SqlClient"
import * as D1Store from "../../src/D1LiveImageStore.js"
import type { Fixture, Phase } from "./liveImageStoreContract.js"

type D1PreparedStatement = ReturnType<D1Client.D1ClientConfig["db"]["prepare"]>

export const localDatabase = Effect.fnUntraced(
  function*(script = "export default { fetch() { return new Response('D1 qualification') } }") {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped()
    const { Miniflare, convertV4MiniflareOptions } = yield* Effect.promise(() => import("miniflare"))

    const mf = yield* Effect.acquireRelease(
      Effect.sync(() =>
        new Miniflare(convertV4MiniflareOptions({
          modules: true,
          script,
          compatibilityDate: "2026-11-09",
          d1Databases: ["DB"],
          d1Persist: path.join(directory, "d1"),
          host: "127.0.0.2",
          port: 15760,
          inspectorPort: 15761
        }))
      ),
      (mf) => Effect.promise(() => mf.dispose())
    )

    const db: D1Client.D1ClientConfig["db"] = yield* Effect.promise(() => mf.getD1Database("DB"))

    const migration = yield* fs.readFileString(
      yield* path.fromFileUrl(new URL("../../migrations/d1/001_live_images.sql", import.meta.url)).pipe(Effect.orDie)
    )

    yield* Effect.promise(() =>
      db.batch(migration.split(";").map((sql) => sql.trim()).filter((sql) => sql !== "").map((sql) => db.prepare(sql)))
    )

    return { db, mf }
  }
)

export const d1Fixture = Effect.gen(function*() {
  const { db, mf } = yield* localDatabase()
  const context = yield* Effect.context()
  const hooks = new Map<Phase, Effect.Effect<void, VfsError.StoreFailure>>()
  let writes = 0
  let reads = 0
  let statements = 0
  let corruptReceipt: "generation" | "envelope" | undefined
  let corruptBlob: ReadonlyArray<number> | string | undefined

  const phase = (name: Phase, signal: AbortSignal) => {
    if (name === "write") writes++

    if (name === "read") reads++
    const hook = hooks.get(name)
    hooks.delete(name)

    return Effect.runPromiseExitWith(context)(hook ?? Effect.void, { signal }).then((exit) => {
      if (Exit.isFailure(exit) && !signal.aborted) throw Cause.squash(exit.cause)
    })
  }

  const wrap = (statement: D1PreparedStatement, sql: string, signal: AbortSignal): D1PreparedStatement => ({
    bind: (...params) => wrap(statement.bind(...params), sql, signal),
    first: statement.first.bind(statement),
    run: statement.run.bind(statement),
    raw: statement.raw.bind(statement),
    all: async <T>() => {
      const writing = sql.startsWith("INSERT") || sql.startsWith("UPDATE")
      const reading = sql.startsWith("SELECT generation")

      if (writing) await phase("write", signal)

      if (reading) await phase("read", signal)
      const response = await statement.all<T>()

      if (writing) await phase("ack", signal)

      if (writing && corruptReceipt !== undefined) {
        const fault = corruptReceipt
        corruptReceipt = undefined

        if (fault === "envelope") {
          // Deliberately violate the native success literal to test boundary decoding.
          Object.defineProperty(response, "success", { value: false })

          return response
        }

        return { ...response, results: response.results.map((row) => ({ ...row, generation: 42 })) }
      }

      if (reading && corruptBlob !== undefined) {
        const image = corruptBlob
        corruptBlob = undefined

        return { ...response, results: response.results.map((row) => ({ ...row, image })) }
      }

      return response
    }
  })

  const bindingFor = (signal: AbortSignal): D1Client.D1ClientConfig["db"] => ({
    prepare: (sql) => {
      statements++

      return wrap(db.prepare(sql), sql, signal)
    },
    batch: db.batch.bind(db),
    exec: db.exec.bind(db),
    dump: db.dump.bind(db),
    withSession: db.withSession.bind(db)
  })

  // oxlint-disable-next-line effecttsgo/abort-controller-in-effect -- Shared native binding hooks drain before fixture shutdown.
  const sharedController = new AbortController()
  yield* Effect.addFinalizer(() => Effect.sync(() => sharedController.abort()))

  const sharedClient = yield* D1Client.make({ db: bindingFor(sharedController.signal) }).pipe(
    Effect.provide(Reactivity.layer)
  )

  const open = Effect.fnUntraced(
    function*(
      maxImageBytes = ByteSize.bytes(16),
      key = "contract",
      supplied?: D1Client.D1Client & SqlClient
    ) {
      const scope = yield* Scope.make()
      // oxlint-disable-next-line effecttsgo/abort-controller-in-effect -- Fixture shutdown releases native Promise barriers before draining the store.
      const controller = new AbortController()
      const drain = Scope.close(scope, Exit.void)
      const close = Effect.sync(() => controller.abort()).pipe(Effect.andThen(drain))
      yield* Effect.addFinalizer(() => close)

      const client = supplied ?? (yield* Scope.provide(
        D1Client.make({ db: bindingFor(controller.signal) }).pipe(Effect.provide(Reactivity.layer)),
        scope
      ))

      const context = yield* Layer.buildWithScope(
        D1Store.layer({ key, maxImageBytes }).pipe(Layer.provide(Layer.succeed(D1Client.D1Client, client))),
        scope
      )

      return { store: Context.get(context, LiveVolume.LiveImageStore), close, drain }
    }
  )

  const persisted = Effect.promise(() =>
    db.prepare("SELECT generation, image FROM effect_vfs_live_images WHERE volume_key = ?").bind("contract").all()
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          results: Schema.Array(Schema.Struct({ generation: Schema.Finite, image: Schema.Array(Schema.Finite) }))
        })
      )
    ),
    Effect.map(({ results }) =>
      results[0] === undefined
        ? undefined
        : { generation: results[0].generation, image: new Uint8Array(results[0].image) }
    ),
    Effect.orDie
  )

  const result = {
    hooks,
    open,
    persisted,
    operation: "D1LiveImageStore.loadOrCreate",
    writeCount: () => writes,
    readCount: () => reads,
    damage: (field, value) =>
      Effect.promise(() =>
        db.prepare(`UPDATE effect_vfs_live_images SET ${field} = ? WHERE volume_key = ?`).bind(value, "contract").run()
      ).pipe(Effect.asVoid)
  } satisfies Fixture

  return {
    ...result,
    db,
    mf,
    statementCount: () => statements,
    sharedClient,
    corruptReceipt: (value: "generation" | "envelope") => {
      corruptReceipt = value
    },
    corruptBlob: (value: ReadonlyArray<number> | string) => {
      corruptBlob = value
    }
  }
})
