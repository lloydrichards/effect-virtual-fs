/* oxlint-disable effecttsgo/async-function, effecttsgo/crypto-random-uuid, effecttsgo/global-console, effecttsgo/global-console-in-effect, effecttsgo/new-promise, effecttsgo/node-builtin-import, effecttsgo/process-env -- Standalone CLI restart harness uses SDK promises, a child process, runtime environment, and terminal output. */
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { LiveVolume } from "@effect-vfs/core"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { ByteSize, Effect, Layer } from "effect"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as R2LiveImageStore from "../src/R2LiveImageStore.js"

const required = (name: string) => {
  const value = process.env[name]

  if (value === undefined || value === "") throw new Error(`${name} must be set`)

  return value
}

const bucket = required("R2_BUCKET")

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

const options = {
  maxImageBytes: ByteSize.kilobytes(64),
  volume: {
    maxEntries: 100,
    maxBytes: ByteSize.kilobytes(32),
    maxFileBytes: ByteSize.kilobytes(16),
    maxPathBytes: ByteSize.bytes(1024)
  }
}

const bytes = (value: string) => new TextEncoder().encode(value)

const text = (value: Uint8Array) => new TextDecoder().decode(value)

const runChild = async (mode: string, key: string) => {
  const layer = R2LiveImageStore.layer({
    client: R2LiveImageStore.fromS3(s3, bucket),
    key,
    maxImageBytes: options.maxImageBytes
  }).pipe(Layer.provide(NodeCrypto.layer))

  await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const volume = yield* LiveVolume.open(options)
      const caller = yield* volume.caller()

      if (mode === "write") {
        yield* caller.mkdir("/docs")
        yield* caller.writeFile("/docs/hello.txt", bytes("first process"), {
          access: "write",
          create: "exclusive"
        })
      } else if (mode === "update") {
        if (text(yield* caller.readFile("/docs/hello.txt")) !== "first process") {
          throw new Error("second process could not read the first process image")
        }

        yield* caller.writeFile("/docs/hello.txt", bytes("second process"), {
          access: "write",
          create: "never"
        })
      } else if (mode === "verify") {
        if (text(yield* caller.readFile("/docs/hello.txt")) !== "second process") {
          throw new Error("third process could not read the committed update")
        }
      } else {
        throw new Error(`unknown child mode: ${mode}`)
      }

      console.log(`${mode}: live volume contents verified`)
    })).pipe(Effect.provide(Layer.mergeAll(layer, NodeCrypto.layer)))
  )
}

const mode = process.argv[2]

if (mode !== undefined) {
  try {
    await runChild(mode, process.argv[3] ?? "")
  } finally {
    s3.destroy()
  }
} else {
  const key = `effect-vfs-smoke/volume-${crypto.randomUUID()}`
  console.log(`volume: ${key}`)

  try {
    for (const phase of ["write", "update", "verify"]) {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), phase, key], {
          env: process.env,
          stdio: "inherit"
        })

        child.once("error", reject)
        child.once("exit", resolve)
      })

      if (code !== 0) throw new Error(`${phase} process failed`)
    }

    console.log("R2 live volume passed across three fresh processes")
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    console.log("volume: removed test object")
    s3.destroy()
  }
}
