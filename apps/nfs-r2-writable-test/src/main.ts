/** Local, single-gateway writable NFS experiment. Never publish this constructor as an NFS profile. */
import { S3Client } from "@aws-sdk/client-s3"
import { LiveVolume } from "@effect-vfs/core"
import { NfsServerLimits } from "@effect-vfs/nfs/NfsServer"
import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as ByteSize from "effect/ByteSize"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as SocketServer from "effect/unstable/socket/SocketServer"
import { makeExport } from "../../../packages/nfs/src/internal/export.js"
import { makeNfs4Handler } from "../../../packages/nfs/src/internal/nfs4.js"
import { startServer } from "../../../packages/nfs/src/internal/server.js"

const required = (name: string): string => {
  const value = Bun.env[name]

  if (value === undefined || value.length === 0) throw new Error(`${name} is required in .env`)

  return value
}

const uint = (name: string, fallback: number, max: number): number => {
  const raw = Bun.env[name]

  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)

  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer from 0 to ${max}`)
  }

  return value
}

const endpoint = required("R2_ENDPOINT")

if (!endpoint.startsWith("https://")) throw new Error("R2_ENDPOINT must use HTTPS")

const bucket = required("R2_BUCKET")

const imageKey = required("R2_IMAGE_KEY")

if (!imageKey.startsWith("effect-vfs-nfs-test/") || imageKey === "effect-vfs-nfs-test/") {
  throw new Error("R2_IMAGE_KEY must be a named object under effect-vfs-nfs-test/")
}

const accessKeyId = required("R2_ACCESS_KEY_ID")

const secretAccessKey = required("R2_SECRET_ACCESS_KEY")

const allowedUid = uint("NFS_ALLOWED_UID", process.getuid?.() ?? 0, 0xffff_ffff)

const port = uint("NFS_PORT", 2049, 65_535)

if (port === 0) throw new Error("NFS_PORT must be nonzero")

const debugAuth = Bun.env["NFS_DEBUG_AUTH"] === "1"

let authSamples = 0

const imageLimit = ByteSize.mebibytes(16)

const limits = NfsServerLimits.default

const volumeOptions = {
  maxImageBytes: imageLimit,
  volume: {
    maxEntries: 1_000,
    maxBytes: ByteSize.mebibytes(8),
    maxFileBytes: ByteSize.mebibytes(4),
    maxPathBytes: ByteSize.bytes(1_024)
  }
}

const peer = Effect.map(
  Effect.serviceOption(NodeSocket.NetSocket),
  Option.match({
    onNone: () => null,
    onSome: (socket) =>
      socket.remoteAddress === undefined || socket.remotePort === undefined
        ? null
        : { transport: "tcp" as const, address: socket.remoteAddress, port: socket.remotePort }
  })
)

const program = Effect.scoped(Effect.gen(function*() {
  const s3 = yield* Effect.acquireRelease(
    Effect.sync(() =>
      new S3Client({
        region: "auto",
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
        maxAttempts: 1
      })
    ),
    (client) => Effect.sync(() => client.destroy())
  )

  const store = R2LiveImageStore.layer({
    client: R2LiveImageStore.fromS3(s3, bucket),
    key: imageKey,
    maxImageBytes: imageLimit
  })

  const volume = yield* LiveVolume.open(volumeOptions).pipe(Effect.provide(store))
  const caller = yield* volume.caller()
  const crypto = yield* Crypto.Crypto
  const generation = yield* crypto.randomBytes(16)
  const identity = Result.getOrThrow(Encoding.decodeHex(volume.identity))
  const storageGeneration = Result.getOrThrow(Encoding.decodeHex(volume.incarnation))
  const exported = makeExport(caller, storageGeneration, limits, identity, volume)

  const handler = yield* makeNfs4Handler(exported, {
    generation,
    storageGeneration,
    leaseDurationSeconds: 30,
    callbackTimeout: "30 seconds",
    limits,
    securityFlavors: [1],
    now: Date.now,
    writable: true,
    callerFor: (call) =>
      Effect.gen(function*() {
        const allowed = call.connection.peer?.transport === "tcp" &&
          (call.connection.peer.address === "127.0.0.1" || call.connection.peer.address === "::1") &&
          Predicate.isTagged(call.credentials, "Sys") &&
          (call.credentials.uid === 0 || call.credentials.uid === allowedUid)

        if (debugAuth && authSamples++ < 20) {
          yield* Effect.log(
            `NFS auth: peer=${call.connection.peer?.address ?? "unknown"} flavor=${call.credentials._tag} uid=${
              Predicate.isTagged(call.credentials, "Sys") ? call.credentials.uid : "none"
            } allowed=${allowed}`
          )
        }

        return allowed ? caller : null
      })
  })

  const socket = yield* SocketServer.SocketServer
  yield* startServer(socket, { limits, peer }, handler)
  yield* Effect.log(`Experimental writable NFS test app listening on 127.0.0.1:${port}`)
  yield* Effect.log(`R2 bucket ${bucket}, image key ${imageKey}; allowed local UID ${allowedUid} and root`)
  yield* Effect.log("Use one gateway only. Unmount before stopping or restarting this process.")

  return yield* Effect.never
})).pipe(Effect.provide(Layer.merge(
  BunCrypto.layer,
  BunSocketServer.layer({ host: "127.0.0.1", port })
)))

BunRuntime.runMain(program)
