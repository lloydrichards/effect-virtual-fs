// Run against emitted models.js; no declared filesystem capability is executed.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const M = await import(pathToFileURL(process.argv[2]).href)
const decode = (schema, value) => Schema.decodeUnknownSync(schema)(value)
const rejects = (schema, value) => assert.throws(() => decode(schema, value))
const identity = { uid: 0, gid: 0, groups: [1], privileged: false }
assert.deepEqual(decode(M.Identity, identity), identity)
for (const uid of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
  rejects(M.Identity, { ...identity, uid })
}
rejects(M.Identity, { ...identity, groups: [-1] })
rejects(M.VolumeOptions, { maxStoredBytes: -1n })
rejects(M.RootCallerOptions, { umask: 0o1000 })
assert.deepEqual(decode(M.TimeUpdate, { kind: "value", nanoseconds: -1n }), {
  kind: "value", nanoseconds: -1n
})
rejects(M.TimeUpdate, { kind: "value" })
rejects(M.TimeUpdate, { kind: "invalid" })
const metadata = {
  kind: "file", ino: 1n, nlink: 1, size: 0n, uid: 0, gid: 0, mode: 0o644,
  atimeNs: 0n, mtimeNs: 0n, ctimeNs: 0n, birthtimeNs: 0n
}
assert.deepEqual(decode(M.Metadata, metadata), metadata)
rejects(M.Metadata, { ...metadata, size: -1n })
rejects(M.Metadata, { ...metadata, mode: 0o10000 })
const fixture = { entries: [
  { kind: "hardLink", path: "/alias", target: "/file" },
  { kind: "file", path: "/file", bytes: new Uint8Array([1]) }
] }
assert.deepEqual(decode(M.StringFixture, fixture), fixture)
rejects(M.StringFixture, { entries: [{ kind: "file", path: "/file", bytes: "text" }] })
// Shape validation deliberately does not resolve references.
assert.doesNotThrow(() => decode(M.StringFixture, { entries: [fixture.entries[0]] }))
const markdown = await readFile(process.argv[3], "utf8")
const encoded = [...markdown.matchAll(/```json\n([\s\S]*?)```/g)]
  .map((match) => JSON.parse(match[1])).find((value) => value.format === "effect-vfs")
assert.ok(encoded, "snapshot documentation must contain a JSON image")
// Exercise the public model decoder so nested excess properties cannot be stripped.
const decodeImage = (value) => Effect.runSync(M.decodeSnapshotImage(value))
const rejectImage = (value) => assert.throws(() => decodeImage(value))
const withFileData = (data) => ({ ...encoded, records: encoded.records.map((record) =>
  record.kind === "file" ? { ...record, data } : record) })
for (const data of ["Zh==", "Zm9=", "Zg", "Zg=", "Zg===", "Zg==\n", " Zg==", "_w=="]) {
  rejectImage(withFileData(data))
}
for (const data of ["", "Zg==", "Zm8=", "Zm9v", "/w=="]) {
  assert.deepEqual(Schema.encodeSync(M.SnapshotImage)(decodeImage(withFileData(data))), withFileData(data))
}
for (const timestamp of ["01", "-0", "+1", " 1", "1\n", "1.0", "1e3"]) {
  rejectImage({ ...encoded, records: encoded.records.map((record) => ({
    ...record, metadata: { ...record.metadata, atimeNs: timestamp }
  })) })
}
for (const timestamp of ["0", "1", "-1"]) {
  const value = { ...encoded, records: encoded.records.map((record) => ({
    ...record, metadata: { ...record.metadata, atimeNs: timestamp }
  })) }
  assert.deepEqual(Schema.encodeSync(M.SnapshotImage)(decodeImage(value)), value)
}
rejectImage({ ...encoded, unknown: true })
for (let index = 0; index < encoded.records.length; index++) {
  for (const mutate of [
    (record) => ({ ...record, unknown: true }),
    (record) => ({ ...record, metadata: { ...record.metadata, unknown: true } })
  ]) {
    rejectImage({ ...encoded, records: encoded.records.map((record, i) => i === index ? mutate(record) : record) })
  }
}
rejectImage({ ...encoded, records: encoded.records.map((record) => record.kind === "directory"
  ? { ...record, entries: record.entries.map((entry) => ({ ...entry, unknown: true })) } : record) })
const decoded = decodeImage(encoded)
assert.deepEqual(Schema.encodeSync(M.SnapshotImage)(decoded), encoded)
assert.equal(typeof decoded.records[0].metadata.birthtimeNs, "bigint")
assert.ok(decoded.records.find((record) => record.kind === "file").data instanceof Uint8Array)
rejects(M.SnapshotImage, { ...encoded, version: 2 })
rejects(Schema.Uint8ArrayFromBase64, "@@@@")
// These probes record why field codecs alone cannot enforce canonical input.
assert.deepEqual(decode(Schema.Uint8ArrayFromBase64, "Zh=="), new Uint8Array([102]))
assert.equal(decode(Schema.BigIntFromString, "01"), 1n)
for (const error of [
  new M.FsError({ code: "NotFound", operation: "stat", path: "/missing" }),
  new M.ConfigurationError({ field: "maxEntries" }),
  new M.ImageError({ code: "InvalidStructure" })
]) {
  assert.ok(error instanceof Error)
  const handled = Effect.gen(function* () { return yield* error }).pipe(
    Effect.catchTag(error._tag, (caught) => Effect.succeed(caught))
  )
  assert.equal(Effect.runSync(handled), error)
}
console.log("Model checks passed: constraints, fixtures, snapshot roundtrip, codec limits, tagged errors.")
