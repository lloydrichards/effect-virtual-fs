import { NfsServerLimits } from "@effect-vfs/nfs/NfsServer"
import * as ByteSize from "effect/ByteSize"

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

// The app claims R2's durability tier only for a verified Cloudflare endpoint.
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

const loseR2ReplyOnce = Bun.env["NFS_FAULT_LOST_R2_REPLY_ONCE"] === "1"

const loseHttpReplyOnce = Bun.env["NFS_FAULT_LOST_HTTP_REPLY_ONCE"] === "1"

const httpFaultSkipWrites = uint("NFS_FAULT_HTTP_SKIP_WRITES", 0, 100)

if (loseR2ReplyOnce && loseHttpReplyOnce) throw new Error("Choose only one NFS fault mode")

const imageLimit = ByteSize.mebibytes(16)

export const config = {
  endpoint,
  bucket,
  imageKey,
  accessKeyId,
  secretAccessKey,
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
