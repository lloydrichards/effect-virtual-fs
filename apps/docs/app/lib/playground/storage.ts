/* oxlint-disable effecttsgo/async-function -- IndexedDB transactions and SQLite WebAssembly initialization expose Promise APIs. */
import * as Schema from "effect/Schema"
import { createStore, del, get, keys, set } from "idb-keyval"
import sqliteURL from "sql.js/dist/sql-wasm-browser.wasm?url"

const store = createStore("effect-vfs-playground", "databases")

const key = "workspace.sqlite"

const sqlite = async () => {
  const { default: initSqlJs } = await import("sql.js")

  return initSqlJs({ locateFile: () => sqliteURL })
}

export async function hasSavedCheckpoint() {
  return (await keys(store)).includes(key)
}

export function deleteCheckpoint() {
  return del(key, store)
}

export async function saveCheckpoint(image: Uint8Array) {
  const SQL = await sqlite()
  const db = new SQL.Database()

  try {
    db.run("CREATE TABLE checkpoint (saved_at TEXT NOT NULL, image BLOB NOT NULL)")
    db.run("INSERT INTO checkpoint VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)", [image])
    await set(key, db.export(), store)
  } finally {
    db.close()
  }
}

export async function readCheckpoint() {
  const bytes = await get<Uint8Array>(key, store)

  if (!bytes) throw new Error("No checkpoint saved in this browser yet.")
  const SQL = await sqlite()
  const db = new SQL.Database(bytes)

  try {
    const [row] = db.exec("SELECT saved_at, length(image), image FROM checkpoint")[0]?.values ?? []

    const [savedAt, size, image] = await Schema.decodeUnknownPromise(
      Schema.Tuple([Schema.String, Schema.Finite, Schema.Uint8Array])
    )(row)

    return { savedAt, size, image }
  } finally {
    db.close()
  }
}
