import { Effect, Schema } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import { createStore, del, get, keys, set } from "idb-keyval"

import { PlaygroundError } from "./error"

const store = createStore("effect-vfs-playground", "databases")

const key = "workspace.sqlite"

const database = Effect.gen(function*() {
  const { makeMemory } = yield* Effect.tryPromise({
    try: () => import("@effect/sql-sqlite-wasm/SqliteClient"),
    catch: PlaygroundError.fromCause
  })

  return yield* makeMemory({})
}).pipe(Effect.provide(Reactivity.layer))

export const hasSavedCheckpoint = Effect.tryPromise({ try: () => keys(store), catch: PlaygroundError.fromCause }).pipe(
  Effect.map((names) => names.includes(key))
)

export const deleteCheckpoint = Effect.tryPromise({ try: () => del(key, store), catch: PlaygroundError.fromCause })

export const saveCheckpoint = Effect.fnUntraced(function*(image: Uint8Array) {
  const sql = yield* database
  yield* sql`CREATE TABLE checkpoint (saved_at TEXT NOT NULL, image BLOB NOT NULL)`
  yield* sql`INSERT INTO checkpoint VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${image})`
  const bytes = yield* sql.export

  yield* Effect.tryPromise({ try: () => set(key, bytes, store), catch: PlaygroundError.fromCause })
}, Effect.scoped)

export const readCheckpoint = Effect.gen(function*() {
  const bytes = yield* Effect.tryPromise({ try: () => get<Uint8Array>(key, store), catch: PlaygroundError.fromCause })

  if (!bytes) return yield* new PlaygroundError({ message: "No checkpoint saved in this browser yet." })

  const sql = yield* database
  yield* sql.import(bytes)
  const [row] = yield* sql`SELECT saved_at AS savedAt, length(image) AS size, image FROM checkpoint`

  return yield* Schema.decodeUnknownEffect(Schema.Struct({
    savedAt: Schema.String,
    size: Schema.Finite,
    image: Schema.Uint8Array
  }))(row)
}).pipe(Effect.scoped)
