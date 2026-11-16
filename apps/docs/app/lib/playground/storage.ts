import { Effect, Schema } from "effect"
import { createStore, del, get, keys, set } from "idb-keyval"
import sqliteURL from "sql.js/dist/sql-wasm-browser.wasm?url"

import { PlaygroundError } from "./error"

const store = createStore("effect-vfs-playground", "databases")

const key = "workspace.sqlite"

const database = Effect.fnUntraced(function*(bytes?: Uint8Array) {
  const SQL = yield* Effect.tryPromise({
    try: () => import("sql.js").then(({ default: init }) => init({ locateFile: () => sqliteURL })),
    catch: PlaygroundError.fromCause
  })

  return yield* Effect.acquireRelease(
    Effect.try({ try: () => new SQL.Database(bytes), catch: PlaygroundError.fromCause }),
    (db) => Effect.sync(() => db.close())
  )
})

export const hasSavedCheckpoint = Effect.tryPromise({ try: () => keys(store), catch: PlaygroundError.fromCause }).pipe(
  Effect.map((names) => names.includes(key))
)

export const deleteCheckpoint = Effect.tryPromise({ try: () => del(key, store), catch: PlaygroundError.fromCause })

export const saveCheckpoint = Effect.fnUntraced(function*(image: Uint8Array) {
  const db = yield* database()

  const bytes = yield* Effect.try({
    try: () => {
      db.run("CREATE TABLE checkpoint (saved_at TEXT NOT NULL, image BLOB NOT NULL)")
      db.run("INSERT INTO checkpoint VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)", [image])

      return db.export()
    },
    catch: PlaygroundError.fromCause
  })

  yield* Effect.tryPromise({ try: () => set(key, bytes, store), catch: PlaygroundError.fromCause })
}, Effect.scoped)

export const readCheckpoint = Effect.gen(function*() {
  const bytes = yield* Effect.tryPromise({ try: () => get<Uint8Array>(key, store), catch: PlaygroundError.fromCause })

  if (!bytes) return yield* new PlaygroundError({ message: "No checkpoint saved in this browser yet." })

  const db = yield* database(bytes)

  const row = yield* Effect.try({
    try: () => db.exec("SELECT saved_at, length(image), image FROM checkpoint")[0]?.values[0],
    catch: PlaygroundError.fromCause
  })

  const [savedAt, size, image] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.String, Schema.Finite, Schema.Uint8Array])
  )(row)

  return { savedAt, size, image }
}).pipe(Effect.scoped)
