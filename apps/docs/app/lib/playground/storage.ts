import * as SqliteClient from "@effect/sql-sqlite-wasm/SqliteClient"
import { Effect, Schema } from "effect"
import { createStore, del, get, keys, set } from "idb-keyval"

import { PlaygroundError } from "./error"

const store = createStore("effect-vfs-playground", "databases")

const key = "workspace.sqlite"

// Existing checkpoints use out-of-line keys and raw bytes in the databases object store.
const indexedDb = <A>(request: () => Promise<A>) =>
  Effect.tryPromise({ try: request, catch: PlaygroundError.fromCause })

const sqlite = SqliteClient.layerMemory({})

export const hasSavedCheckpoint = indexedDb(() => keys(store)).pipe(Effect.map((names) => names.includes(key)))

export const deleteCheckpoint = indexedDb(() => del(key, store))

export const saveCheckpoint = Effect.fnUntraced(function*(image: Uint8Array) {
  const sql = yield* SqliteClient.SqliteClient
  yield* sql`CREATE TABLE checkpoint (saved_at TEXT NOT NULL, image BLOB NOT NULL)`
  yield* sql`INSERT INTO checkpoint VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${image})`
  const bytes = yield* sql.export

  yield* indexedDb(() => set(key, bytes, store))
}, Effect.provide(sqlite))

export const readCheckpoint = Effect.gen(function*() {
  const bytes = yield* indexedDb(() => get<Uint8Array>(key, store))

  if (!bytes) return yield* new PlaygroundError({ message: "No checkpoint saved in this browser yet." })

  const sql = yield* SqliteClient.SqliteClient
  yield* sql.import(bytes)
  const [row] = yield* sql`SELECT saved_at AS savedAt, length(image) AS size, image FROM checkpoint`

  return yield* Schema.decodeUnknownEffect(Schema.Struct({
    savedAt: Schema.String,
    size: Schema.Finite,
    image: Schema.Uint8Array
  }))(row)
}).pipe(Effect.provide(sqlite))
