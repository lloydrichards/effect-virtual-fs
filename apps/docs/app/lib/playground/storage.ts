import * as BrowserKeyValueStore from "@effect/platform-browser/BrowserKeyValueStore"
import * as IndexedDb from "@effect/platform-browser/IndexedDb"
import * as SqliteClient from "@effect/sql-sqlite-wasm/SqliteClient"
import { Effect, Layer, Schema } from "effect"
import { KeyValueStore } from "effect/persistence/KeyValueStore"

import { PlaygroundError } from "./error"

const key = "workspace.sqlite"

const storeLayer = BrowserKeyValueStore.layerIndexedDb({ database: "effect-vfs-checkpoints" }).pipe(
  Layer.provide(
    Layer.effect(
      IndexedDb.IndexedDb,
      Effect.sync(() => IndexedDb.make({ indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange }))
    )
  )
)

const checkpointLayer = Layer.merge(storeLayer, SqliteClient.layerMemory({}))

export const hasSavedCheckpoint = KeyValueStore.use((store) => store.has(key)).pipe(Effect.provide(storeLayer))

export const deleteCheckpoint = KeyValueStore.use((store) => store.remove(key)).pipe(Effect.provide(storeLayer))

export const saveCheckpoint = Effect.fnUntraced(function*(image: Uint8Array) {
  const sql = yield* SqliteClient.SqliteClient
  yield* sql`CREATE TABLE checkpoint (saved_at TEXT NOT NULL, image BLOB NOT NULL)`
  yield* sql`INSERT INTO checkpoint VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${image})`
  const bytes = yield* sql.export

  const store = yield* KeyValueStore
  yield* store.set(key, bytes)
}, Effect.provide(checkpointLayer))

export const readCheckpoint = Effect.gen(function*() {
  const store = yield* KeyValueStore
  const bytes = yield* store.getUint8Array(key)

  if (!bytes) return yield* new PlaygroundError({ message: "No checkpoint saved in this browser yet." })

  const sql = yield* SqliteClient.SqliteClient
  yield* sql.import(bytes)
  const [row] = yield* sql`SELECT saved_at AS savedAt, length(image) AS size, image FROM checkpoint`

  return yield* Schema.decodeUnknownEffect(Schema.Struct({
    savedAt: Schema.String,
    size: Schema.Finite,
    image: Schema.Uint8Array
  }))(row)
}).pipe(Effect.provide(checkpointLayer))
