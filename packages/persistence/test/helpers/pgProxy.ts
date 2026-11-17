/* oxlint-disable effecttsgo/async-function, effecttsgo/process-env, effecttsgo/schema-sync -- Native TCP callbacks parse complete binary frames and serialize forwarding through Promise queues. The environment optionally selects a listener port before acquisition. */
import type { VfsError } from "@effect-vfs/core"
import { Effect, Exit, Schema } from "effect"
import { createConnection, createServer, type Socket } from "node:net"

let proxyPort = Number(process.env["VFS_PG_PROXY_PORT"] ?? 0)

/** Frames PostgreSQL messages so tests can withhold ReadyForQuery after COMMIT. */
export const pgProxy = (
  url: string,
  phase: (name: "read" | "write" | "ack") => Effect.Effect<void, VfsError.StoreFailure>,
  rewriteReceipt: (packet: Buffer) => Buffer = (packet) => packet,
  onStartup: Effect.Effect<void> = Effect.void
) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly stop: () => void }>((resume) => {
      const target = new URL(url)
      const endpoint = { host: target.hostname, port: Number(target.port || 5432) }
      const sockets = new Set<Socket>()
      const controller = new AbortController()
      let cancelGate: (() => void) | undefined

      const server = createServer((downstream) => {
        const upstream = createConnection(endpoint)
        sockets.add(downstream)
        sockets.add(upstream)

        const close = () => {
          downstream.destroy()
          upstream.destroy()
        }

        downstream.on("error", close)
        upstream.on("error", close)
        downstream.on("close", () => {
          sockets.delete(downstream)
          upstream.destroy()
        })
        upstream.on("close", () => {
          sockets.delete(upstream)
          downstream.destroy()
        })
        let startup = true
        let request = Buffer.alloc(0)
        let response = Buffer.alloc(0)
        let writing = false
        let pendingError: Buffer | undefined
        let current = ""
        const prepared = new Map<string, string>()
        let requests = Promise.resolve()
        let responses = Promise.resolve()

        const pass = (name: "read" | "write" | "ack") => {
          const gate = new AbortController()
          cancelGate = () => gate.abort()

          return Effect.runPromiseExit(phase(name), { signal: AbortSignal.any([controller.signal, gate.signal]) }).then(
            (exit) => {
              cancelGate = undefined

              if (Exit.isSuccess(exit)) return true

              if (name === "ack") {
                if (gate.signal.aborted) return true
                close()
              } else {
                // Skip Execute and let the following Sync drain the Bind. This
                // models a server rejection without retiring the private session.
                const fields = Buffer.from(`SERROR\0C${gate.signal.aborted ? "57014" : "XX000"}\0Mproxy failure\0\0`)
                const packet = Buffer.alloc(fields.length + 5)
                packet[0] = 69
                packet.writeInt32BE(fields.length + 4, 1)
                fields.copy(packet, 5)
                pendingError = packet
              }

              return false
            }
          )
        }

        downstream.on("data", (chunk) => {
          request = Buffer.concat([request, Schema.decodeUnknownSync(Schema.Uint8Array)(chunk)])

          while (request.length >= (startup ? 4 : 5)) {
            const size = startup ? request.readInt32BE(0) : request.readInt32BE(1) + 1

            if (request.length < size) break
            const packet = request.subarray(0, size)
            request = request.subarray(size)

            if (startup && size === 16 && packet.readInt32BE(4) === 80877102 && cancelGate !== undefined) {
              cancelGate()
              downstream.end()
              upstream.destroy()
              continue
            }

            const first = startup
            startup = false
            requests = requests.then(async () => {
              const tag = first ? "startup" : String.fromCharCode(packet[0]!)

              if (first) {
                await Effect.runPromiseExit(onStartup, { signal: controller.signal })
              }

              if (tag === "P") {
                const end = packet.indexOf(0, 5)
                prepared.set(
                  packet.toString("utf8", 5, end),
                  packet.toString("utf8", end + 1, packet.indexOf(0, end + 1))
                )
              }

              if (tag === "B") {
                const start = packet.indexOf(0, 5) + 1
                current = prepared.get(packet.toString("utf8", start, packet.indexOf(0, start))) ?? ""
              }

              if (tag === "E") {
                writing = current.startsWith("INSERT") || current.startsWith("UPDATE")

                if (writing && !await pass("write")) return

                if (current.startsWith("SELECT generation") && !await pass("read")) return
              }

              if (!upstream.destroyed) upstream.write(packet)
            })
          }
        })
        upstream.on("data", (chunk) => {
          response = Buffer.concat([response, Schema.decodeUnknownSync(Schema.Uint8Array)(chunk)])

          while (response.length >= 5) {
            const size = response.readInt32BE(1) + 1

            if (response.length < size) break
            const packet = response.subarray(0, size)
            response = response.subarray(size)
            responses = responses.then(async () => {
              if (packet[0] === 90 && pendingError !== undefined) {
                downstream.write(pendingError)
                pendingError = undefined
              }

              if (packet[0] === 90 && writing) {
                writing = false

                if (!await pass("ack")) return
              }

              if (!downstream.destroyed) downstream.write(packet[0] === 68 && writing ? rewriteReceipt(packet) : packet)
            })
          }
        })
      })

      server.once("error", (cause) => resume(Effect.die(cause)))
      server.listen(proxyPort === 0 ? 0 : proxyPort++, "127.0.0.1", () => {
        const address = server.address()

        if (!Schema.is(Schema.Struct({ port: Schema.Finite }))(address)) return resume(Effect.die("missing proxy port"))
        target.hostname = "127.0.0.1"
        target.port = String(address.port)
        target.searchParams.set("sslmode", "disable")
        resume(Effect.succeed({
          url: target.toString(),
          stop: () => {
            controller.abort()

            for (const socket of sockets) socket.destroy()
            server.close()
          }
        }))
      })
    }),
    (proxy) => Effect.sync(proxy.stop)
  )
