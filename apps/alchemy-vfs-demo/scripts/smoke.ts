/* oxlint-disable effecttsgo/async-function, effecttsgo/global-console, effecttsgo/global-console-in-effect, effecttsgo/global-fetch, effecttsgo/process-env, eslint/no-console -- This CLI drives independent HTTP requests and reports their results. */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import assert from "node:assert/strict"

const url = Bun.env.NOTEBOOK_URL

const token = Bun.env.NOTEBOOK_TOKEN

if (!url || !token) throw new Error("NOTEBOOK_URL and NOTEBOOK_TOKEN are required in .env")

const base = `${url.replace(/\/$/, "")}/notebooks`

const authorization = { Authorization: `Bearer ${token}` }

const Notebook = Schema.Struct({
  id: Schema.String,
  files: Schema.Array(Schema.String),
  content: Schema.String,
  durability: Schema.String
})

const unauthorized = await fetch(base)

assert.equal(unauthorized.status, 401)

const created = await fetch(base, { method: "POST", headers: authorization })

assert.equal(created.status, 201)

const notebook = await Effect.runPromise(Schema.decodeUnknownEffect(Notebook)(await created.json()))

try {
  assert.deepEqual(notebook.files, ["/published/hello.txt"])

  const reopened = await fetch(`${base}/${notebook.id}`, { headers: authorization })

  assert.equal(reopened.status, 200)
  assert.deepEqual(await Effect.runPromise(Schema.decodeUnknownEffect(Notebook)(await reopened.json())), notebook)
} finally {
  const deleted = await fetch(`${base}/${notebook.id}`, { method: "DELETE", headers: authorization })

  assert.equal(deleted.status, 200)
}

const missing = await fetch(`${base}/${notebook.id}`, { headers: authorization })

assert.equal(missing.status, 404)

console.log("Live Worker check passed: 401, create, reopen, delete, 404")
