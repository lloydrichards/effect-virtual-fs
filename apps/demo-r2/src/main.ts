/** Local, single-gateway writable NFS experiment. Never publish this constructor as an NFS profile. */
import { S3Client } from "@aws-sdk/client-s3"
import { LiveVolume } from "@effect-vfs/core"
import { NfsServer, NfsServerLimits } from "@effect-vfs/nfs/NfsServer"
import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

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

if (!/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(new URL(endpoint).hostname)) {
  throw new Error("R2_ENDPOINT must be a Cloudflare R2 S3 endpoint")
}

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

const bindAddress = Bun.env["NFS_BIND_ADDRESS"] || "127.0.0.1"

if (bindAddress === "0.0.0.0" || bindAddress === "::") {
  throw new Error("NFS_BIND_ADDRESS must name one interface, not a wildcard")
}

const allowedPeer = Bun.env["NFS_ALLOWED_PEER"]

if (bindAddress !== "127.0.0.1" && bindAddress !== "::1" && !allowedPeer) {
  throw new Error("NFS_ALLOWED_PEER is required for a non-loopback bind address")
}

const allowedPeers = new Set(["127.0.0.1", "::1", bindAddress, ...(allowedPeer ? [allowedPeer] : [])])

const loseR2ReplyOnce = Bun.env["NFS_FAULT_LOST_R2_REPLY_ONCE"] === "1"

const loseHttpReplyOnce = Bun.env["NFS_FAULT_LOST_HTTP_REPLY_ONCE"] === "1"

const httpFaultSkipWrites = uint("NFS_FAULT_HTTP_SKIP_WRITES", 0, 100)

if (loseR2ReplyOnce && loseHttpReplyOnce) throw new Error("Choose only one NFS fault mode")

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

  let lostHttpReply = false
  let successfulConditionalWrites = 0

  const faultS3 = loseHttpReplyOnce
    ? yield* Effect.acquireRelease(
      Effect.sync(() =>
        new S3Client({
          region: "auto",
          endpoint,
          credentials: { accessKeyId, secretAccessKey },
          forcePathStyle: true,
          maxAttempts: 1,
          requestHandler: {
            // oxlint-disable-next-line effecttsgo/async-function -- AWS SDK request handlers use promises.
            handle: async (
              request: Parameters<typeof s3.config.requestHandler.handle>[0],
              options: Parameters<typeof s3.config.requestHandler.handle>[1]
            ) => {
              const result = await s3.config.requestHandler.handle(request, options)

              const conditional = Object.keys(request.headers).some((name) => name.toLowerCase() === "if-match")

              if (
                request.method === "PUT" && conditional && !lostHttpReply &&
                result.response.statusCode >= 200 && result.response.statusCode < 300
              ) {
                successfulConditionalWrites++

                if (successfulConditionalWrites > httpFaultSkipWrites) {
                  lostHttpReply = true
                  throw new Error("test fault: lost successful R2 HTTP response")
                }
              }

              return result
            },
            destroy: () => {}
          }
        })
      ),
      (client) => Effect.sync(() => client.destroy())
    )
    : s3

  const remote = R2LiveImageStore.fromS3(faultS3, bucket)
  let lostReply = false

  const client: R2LiveImageStore.R2Client = loseR2ReplyOnce
    ? {
      read: remote.read,
      write: (key, image, generation, digest, condition) =>
        Effect.flatMap(remote.write(key, image, generation, digest, condition), (result) => {
          if (!lostReply && "ifMatch" in condition && result !== null) {
            lostReply = true

            return Effect.fail(
              new LiveVolume.LiveVolumeError({
                code: "Storage",
                cause: new Error("test fault: R2 accepted a write but its reply was lost")
              })
            )
          }

          return Effect.succeed(result)
        })
    }
    : remote

  const store = R2LiveImageStore.layer({
    client,
    key: imageKey,
    maxImageBytes: imageLimit,
    durability: "survives-power-loss"
  })

  const volume = yield* LiveVolume.open(volumeOptions).pipe(Effect.provide(store))

  yield* NfsServer.make({
    volume,
    writable: true,
    limits,
    peer,
    allowNonLoopback: true,
    policy: ({ credential, peer: clientPeer }) =>
      clientPeer.transport === "tcp" && allowedPeers.has(clientPeer.address) &&
        credential.flavor === "sys" && (credential.uid === 0 || credential.uid === allowedUid)
        ? { uid: 0, gid: 0, groups: [], privileged: true }
        : null
  })
  yield* Effect.log(`Experimental writable NFS test app listening on ${bindAddress}:${port}`)
  yield* Effect.log(`R2 bucket ${bucket}, image key ${imageKey}; allowed UID ${allowedUid} and root`)

  if (loseR2ReplyOnce) yield* Effect.log("Test fault armed: lose the first successful conditional R2 write reply")

  if (loseHttpReplyOnce) {
    yield* Effect.log(
      `Test fault armed: skip ${httpFaultSkipWrites} successful conditional R2 writes, then lose one HTTP reply`
    )
  }

  yield* Effect.log("Use one gateway only. Unmount before stopping or restarting this process.")

  return yield* Effect.never
})).pipe(Effect.provide(Layer.merge(
  BunCrypto.layer,
  BunSocketServer.layer({ host: bindAddress, port })
)))

BunRuntime.runMain(program)
