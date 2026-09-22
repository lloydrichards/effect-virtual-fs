import { LiveVolume } from "@effect-vfs/core"
import { NfsServer } from "@effect-vfs/nfs/NfsServer"
import * as R2LiveImageStore from "@effect-vfs/persistence/R2LiveImageStore"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { R2DemoConfig } from "./config.js"
import { makeR2Client } from "./r2-client.js"

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

/** Opens the R2 image and listens until the owning Effect scope closes. */
export const gateway = Effect.fn("R2Demo.gateway")(function*(config: R2DemoConfig) {
  const client = yield* makeR2Client(config)

  const store = R2LiveImageStore.layer({
    client,
    key: config.imageKey,
    maxImageBytes: config.imageLimit,
    // This assertion relies on Cloudflare's successful-write contract for the verified endpoint.
    durability: "survives-power-loss"
  })

  const volume = yield* LiveVolume.open(config.volumeOptions).pipe(Effect.provide(store))

  yield* NfsServer.make({
    volume,
    writable: true,
    limits: config.limits,
    peer,
    allowNonLoopback: true,
    policy: ({ credential, peer: clientPeer }) =>
      clientPeer.transport === "tcp" && config.allowedPeers.has(clientPeer.address) &&
        credential.flavor === "sys" && (credential.uid === 0 || credential.uid === config.allowedUid)
        ? { uid: 0, gid: 0, groups: [], privileged: true }
        : null
  })

  yield* Effect.log(`Experimental writable NFS test app listening on ${config.bindAddress}:${config.port}`)
  yield* Effect.log(
    `R2 bucket ${config.bucket}, image key ${config.imageKey}; allowed UID ${config.allowedUid} and root`
  )

  if (config.loseR2ReplyOnce) {
    yield* Effect.log("Test fault armed: lose the first successful conditional R2 write reply")
  }

  if (config.loseHttpReplyOnce) {
    yield* Effect.log(
      `Test fault armed: skip ${config.httpFaultSkipWrites} successful conditional R2 writes, then lose one HTTP reply`
    )
  }
})
