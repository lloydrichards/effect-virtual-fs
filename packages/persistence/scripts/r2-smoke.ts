/* oxlint-disable effecttsgo/crypto-random-uuid, effecttsgo/global-console, effecttsgo/global-timers, effecttsgo/new-promise, effecttsgo/process-env -- Standalone CLI smoke harness uses runtime environment, timing, and terminal output. */
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { LiveVolume } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { ByteSize, Effect, Layer } from "effect"
import * as R2LiveImageStore from "../src/R2LiveImageStore.js"

const required = (name: string) => {
  const value = process.env[name]

  if (value === undefined || value === "") throw new Error(`${name} must be set`)

  return value
}

const endpoint = required("R2_ENDPOINT")

const bucket = required("R2_BUCKET")

const accessKeyId = required("R2_ACCESS_KEY_ID")

const secretAccessKey = required("R2_SECRET_ACCESS_KEY")

const key = `effect-vfs-smoke/${crypto.randomUUID()}`

const bytes = (value: string) => new TextEncoder().encode(value)

const text = (value: Uint8Array) => new TextDecoder().decode(value)

const s3 = new S3Client({
  region: "auto",
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
  maxAttempts: 1
})

const client = R2LiveImageStore.fromS3(s3, bucket)

const storeLayer = R2LiveImageStore.layer({ client, key, maxImageBytes: ByteSize.kilobytes(64) }).pipe(
  Layer.provide(NodeCrypto.layer)
)

console.log(`R2 smoke object: ${key}`)

let mayHaveWritten = false

try {
  console.log("Checking that the test key is absent")
  const missing = await Effect.runPromise(client.read(key))

  if (missing !== null) throw new Error("unique test key unexpectedly exists")

  console.log("Creating the initial image")
  mayHaveWritten = true
  await Effect.runPromise(
    Effect.gen(function*() {
      const store = yield* LiveVolume.LiveImageStore

      if (text(yield* store.loadOrCreate(bytes("initial"))) !== "initial") throw new Error("initial image mismatch")
    }).pipe(Effect.provide(storeLayer))
  )

  console.log("Reading the initial image and metadata")
  const initial = await Effect.runPromise(client.read(key))

  if (initial === null || initial.generation !== "0") throw new Error("initial object metadata mismatch")

  console.log("Checking create-only conditional rejection")

  const conflict = await Effect.runPromise(client.write(
    key,
    bytes("wrong"),
    "1",
    "unused",
    { ifNoneMatch: "*" }
  ))

  if (conflict !== null) throw new Error("R2 accepted a conflicting conditional write")

  // Leave space between setup and replacement so this smoke test isolates conditional behavior.
  await new Promise((resolve) => setTimeout(resolve, 1200))
  console.log("Reopening and committing a replacement image")
  console.log("Reopening the committed image")
  await Effect.runPromise(
    Effect.gen(function*() {
      const store = yield* LiveVolume.LiveImageStore

      if (text(yield* store.loadOrCreate(bytes("ignored"))) !== "initial") throw new Error("reopen mismatch")

      if ((yield* store.commit(bytes("updated"))) !== "committed") throw new Error("commit was not acknowledged")
    }).pipe(Effect.provide(storeLayer))
  )

  await Effect.runPromise(
    Effect.gen(function*() {
      const store = yield* LiveVolume.LiveImageStore

      if (text(yield* store.loadOrCreate(bytes("ignored"))) !== "updated") throw new Error("committed image mismatch")
    }).pipe(Effect.provide(storeLayer))
  )

  console.log("Checking stale ETag rejection")

  const stale = await Effect.runPromise(client.write(
    key,
    bytes("stale"),
    "2",
    "unused",
    { ifMatch: initial.etag }
  ))

  if (stale !== null) throw new Error("R2 accepted a stale ETag")

  console.log("R2 smoke test passed: create, conditional conflicts, commit, and reopen")
} finally {
  if (mayHaveWritten) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      console.log("Removed the test object")
    } catch (error) {
      console.error("Could not remove the test object:", error)
    }
  }

  s3.destroy()
}
