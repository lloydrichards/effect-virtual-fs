import { NfsServerLimits } from "@effect-vfs/nfs/NfsServer"
import * as ByteSize from "effect/ByteSize"
import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const imageLimit = ByteSize.mebibytes(16)

class DemoConfigurationError extends Data.TaggedError("DemoConfigurationError")<{ readonly message: string }> {}

const endpoint = Config.schema(
  Schema.String.check(Schema.isPattern(/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\/?$/)),
  "R2_ENDPOINT"
)

const imageKey = Config.schema(
  Schema.String.check(Schema.isPattern(/^effect-vfs-nfs-test\/.+$/)),
  "R2_IMAGE_KEY"
)

const portNumber = (name: string, fallback: number) => Config.Int(name).pipe(Config.withDefault(fallback))

export const loadConfig = Effect.fn("R2Demo.loadConfig")(function*() {
  const bindAddress = yield* Config.String("NFS_BIND_ADDRESS").pipe(Config.withDefault("127.0.0.1"))
  const allowedPeer = yield* Config.String("NFS_ALLOWED_PEER").pipe(Config.withDefault(""))
  const port = yield* portNumber("NFS_PORT", 2049)
  const allowedUid = yield* portNumber("NFS_ALLOWED_UID", process.getuid?.() ?? 0)
  const loseR2ReplyOnce = (yield* Config.String("NFS_FAULT_LOST_R2_REPLY_ONCE").pipe(Config.withDefault("0"))) === "1"

  const loseHttpReplyOnce =
    (yield* Config.String("NFS_FAULT_LOST_HTTP_REPLY_ONCE").pipe(Config.withDefault("0"))) === "1"

  const httpFaultSkipWrites = yield* portNumber("NFS_FAULT_HTTP_SKIP_WRITES", 0)

  if (port < 1 || port > 65_535) {
    return yield* new DemoConfigurationError({ message: "NFS_PORT must be from 1 to 65535" })
  }

  if (allowedUid < 0 || allowedUid > 0xffff_ffff) {
    return yield* new DemoConfigurationError({ message: "NFS_ALLOWED_UID must be a uint32" })
  }

  if (httpFaultSkipWrites < 0 || httpFaultSkipWrites > 100) {
    return yield* new DemoConfigurationError({ message: "NFS_FAULT_HTTP_SKIP_WRITES must be from 0 to 100" })
  }

  if (bindAddress === "0.0.0.0" || bindAddress === "::") {
    return yield* new DemoConfigurationError({ message: "NFS_BIND_ADDRESS must name one interface" })
  }

  if (bindAddress !== "127.0.0.1" && bindAddress !== "::1" && allowedPeer === "") {
    return yield* new DemoConfigurationError({
      message: "NFS_ALLOWED_PEER is required for a non-loopback bind address"
    })
  }

  if (loseR2ReplyOnce && loseHttpReplyOnce) {
    return yield* new DemoConfigurationError({ message: "Choose only one NFS fault mode" })
  }

  return {
    endpoint: yield* endpoint,
    bucket: yield* Config.NonEmptyString("R2_BUCKET"),
    imageKey: yield* imageKey,
    accessKeyId: yield* Config.Redacted("R2_ACCESS_KEY_ID"),
    secretAccessKey: yield* Config.Redacted("R2_SECRET_ACCESS_KEY"),
    allowedUid,
    port,
    bindAddress,
    allowedPeers: new Set(["127.0.0.1", "::1", bindAddress, ...(allowedPeer ? [allowedPeer] : [])]),
    loseR2ReplyOnce,
    loseHttpReplyOnce,
    httpFaultSkipWrites,
    imageLimit,
    limits: NfsServerLimits.default,
    volumeOptions: {
      maxImageBytes: imageLimit,
      volume: {
        maxEntries: 1_000,
        maxBytes: ByteSize.mebibytes(8),
        maxFileBytes: ByteSize.mebibytes(4),
        maxPathBytes: ByteSize.bytes(1_024)
      }
    }
  }
})

export type R2DemoConfig = Effect.Success<ReturnType<typeof loadConfig>>
