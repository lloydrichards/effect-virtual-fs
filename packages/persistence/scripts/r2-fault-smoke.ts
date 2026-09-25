/* oxlint-disable effecttsgo/async-function, effecttsgo/crypto-random-uuid, effecttsgo/global-console, effecttsgo/global-timers, effecttsgo/new-promise, effecttsgo/process-env -- Standalone CLI fault harness uses SDK promises, runtime environment, timing, and terminal output. */
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { LiveVolume, VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { ByteSize, Effect, Layer } from "effect"
import * as R2LiveImageStore from "../src/R2LiveImageStore.js"

const required = (name: string) => {
  const value = process.env[name]

  if (value === undefined || value === "") throw new Error(`${name} must be set`)

  return value
}

const s3 = new S3Client({
  region: "auto",
  endpoint: required("R2_ENDPOINT"),
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY")
  },
  forcePathStyle: true,
  maxAttempts: 1
})

const bucket = required("R2_BUCKET")

const remote = R2LiveImageStore.fromS3(s3, bucket)

const bytes = (value: string) => new TextEncoder().encode(value)

const text = (value: Uint8Array) => new TextDecoder().decode(value)

const pause = () => new Promise((resolve) => setTimeout(resolve, 1200))

const makeStore = (key: string, client: R2LiveImageStore.R2Client = remote) =>
  Effect.runPromise(LiveVolume.LiveImageStore.pipe(Effect.provide(
    R2LiveImageStore.layer({ client, key, maxImageBytes: ByteSize.kilobytes(64) }).pipe(
      Layer.provide(NodeCrypto.layer)
    )
  )))

const withObject = async (name: string, run: (key: string) => Promise<void>) => {
  const key = `effect-vfs-smoke/${name}-${crypto.randomUUID()}`
  console.log(`${name}: ${key}`)

  try {
    await run(key)
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    console.log(`${name}: removed test object`)
  }
}

try {
  await withObject("lost-reply", async (key) => {
    let dropped = false

    const client: R2LiveImageStore.R2Client = {
      read: remote.read,
      write: (objectKey, image, generation, digest, condition) =>
        Effect.flatMap(remote.write(objectKey, image, generation, digest, condition), (result) => {
          if (generation === "1" && result !== null && !dropped) {
            dropped = true

            return Effect.fail(
              new Vfs.VfsError({
                code: "Storage",
                operation: "R2Fault",
                cause: new Error("injected lost response after R2 accepted the write")
              })
            )
          }

          return Effect.succeed(result)
        })
    }

    const first = await makeStore(key, client)
    await Effect.runPromise(first.loadOrCreate(bytes("old")))
    await pause()

    if (await Effect.runPromise(first.commit(bytes("new"))) !== "unknown") {
      throw new Error("lost response was not reported as unknown")
    }

    if (!dropped || await Effect.runPromise(first.commit(bytes("retry"))) !== "unknown") {
      throw new Error("store accepted a retry after an uncertain result")
    }

    const reopened = await makeStore(key)

    if (text(await Effect.runPromise(reopened.loadOrCreate(bytes("ignored")))) !== "new") {
      throw new Error("reopen did not recover the acknowledged R2 image")
    }

    console.log("lost-reply: uncertain response froze the owner; reopen recovered the new image")
  })

  await withObject("lost-http-response", async (key) => {
    let dropped = false

    const faultS3 = new S3Client({
      region: "auto",
      endpoint: required("R2_ENDPOINT"),
      credentials: {
        accessKeyId: required("R2_ACCESS_KEY_ID"),
        secretAccessKey: required("R2_SECRET_ACCESS_KEY")
      },
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: {
        handle: async (
          request: Parameters<typeof s3.config.requestHandler.handle>[0],
          options: Parameters<typeof s3.config.requestHandler.handle>[1]
        ) => {
          const result = await s3.config.requestHandler.handle(request, options)

          const generation = Object.entries(request.headers).find(([name]) =>
            name.toLowerCase() === "x-amz-meta-generation"
          )?.[1]

          if (
            request.method === "PUT" && generation === "1" && !dropped &&
            result.response.statusCode >= 200 && result.response.statusCode < 300
          ) {
            dropped = true
            throw new Error("injected lost HTTP response after R2 acknowledged the write")
          }

          return result
        },
        destroy: () => {}
      }
    })

    try {
      const first = await makeStore(key, R2LiveImageStore.fromS3(faultS3, bucket))
      await Effect.runPromise(first.loadOrCreate(bytes("old")))
      await pause()

      if (await Effect.runPromise(first.commit(bytes("new"))) !== "unknown") {
        throw new Error("lost HTTP response was not reported as unknown")
      }

      if (!dropped || await Effect.runPromise(first.commit(bytes("retry"))) !== "unknown") {
        throw new Error("store accepted a retry after a lost HTTP response")
      }

      const reopened = await makeStore(key)

      if (text(await Effect.runPromise(reopened.loadOrCreate(bytes("ignored")))) !== "new") {
        throw new Error("reopen did not recover the write after a lost HTTP response")
      }

      console.log("lost-http-response: owner froze; reopen recovered the new image")
    } finally {
      faultS3.destroy()
    }
  })

  await withObject("two-owners", async (key) => {
    const first = await makeStore(key)
    await Effect.runPromise(first.loadOrCreate(bytes("original")))
    const second = await makeStore(key)
    await Effect.runPromise(second.loadOrCreate(bytes("ignored")))
    await pause()

    if (await Effect.runPromise(first.commit(bytes("winner"))) !== "committed") {
      throw new Error("first owner did not commit")
    }

    if (await Effect.runPromise(second.commit(bytes("stale"))) !== "unknown") {
      throw new Error("stale owner was not fenced")
    }

    if (await Effect.runPromise(second.commit(bytes("retry"))) !== "unknown") {
      throw new Error("stale owner accepted a retry")
    }

    const reopened = await makeStore(key)

    if (text(await Effect.runPromise(reopened.loadOrCreate(bytes("ignored")))) !== "winner") {
      throw new Error("stale owner replaced the winning image")
    }

    console.log("two-owners: stale writer was fenced; reopen recovered the winner")
  })

  await withObject("concurrent-writers", async (key) => {
    const first = await makeStore(key)
    await Effect.runPromise(first.loadOrCreate(bytes("original")))
    const second = await makeStore(key)
    await Effect.runPromise(second.loadOrCreate(bytes("ignored")))
    await pause()

    const outcomes = await Promise.all([
      Effect.runPromise(first.commit(bytes("first"))),
      Effect.runPromise(second.commit(bytes("second")))
    ])

    if (outcomes.filter((outcome) => outcome === "committed").length !== 1) {
      throw new Error(`expected exactly one acknowledged concurrent write; got ${outcomes.join(", ")}`)
    }

    const reopened = await makeStore(key)
    const recovered = text(await Effect.runPromise(reopened.loadOrCreate(bytes("ignored"))))
    const winner = outcomes[0] === "committed" ? "first" : "second"

    if (recovered !== winner) throw new Error("concurrent loser replaced the acknowledged winner")
    console.log(`concurrent-writers: outcomes=${outcomes.join(",")}, recovered=${recovered}`)
  })

  await withObject("rapid-write", async (key) => {
    const store = await makeStore(key)
    await Effect.runPromise(store.loadOrCreate(bytes("original")))
    let lastCommitted = "original"
    let attempted = "original"
    let unknown = false

    for (let index = 1; index <= 8; index++) {
      attempted = `revision-${index}`
      const started = performance.now()
      const outcome = await Effect.runPromise(store.commit(bytes(attempted)))
      const elapsedMs = Math.round(performance.now() - started)
      console.log(`rapid-write: commit=${index}, outcome=${outcome}, elapsedMs=${elapsedMs}`)

      if (outcome === "unknown") {
        unknown = true
        break
      }

      if (outcome !== "committed") throw new Error(`rapid write ${index} was rejected`)
      lastCommitted = attempted
    }

    const reopened = await makeStore(key)
    const recovered = text(await Effect.runPromise(reopened.loadOrCreate(bytes("ignored"))))

    if (recovered !== lastCommitted && (!unknown || recovered !== attempted)) {
      throw new Error("rapid write left an incomplete image")
    }

    console.log(`rapid-write: recovered=${recovered}`)
  })
} finally {
  s3.destroy()
}
