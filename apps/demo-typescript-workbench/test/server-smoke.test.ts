/* oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/global-fetch -- The smoke test drives the Node server and static assets with native APIs. */
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import { test } from "node:test"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { WorkbenchRpc } from "../src/workbench/domain.ts"

void test("serves the built workbench and compiles and runs its starter program over HTTP", {
  timeout: 90_000
}, async () => {
  // Vite serves the shell on PORT and proxies RPC to PORT + 2.
  const probe = createServer().listen(0, "127.0.0.1")
  await once(probe, "listening")
  const address = probe.address()
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node returns a TCP address or a Unix socket path.
  assert.ok(address && typeof address !== "string")
  probe.close()
  await once(probe, "close")

  const origin = `http://127.0.0.1:${address.port}`
  const env = { ...process.env, PORT: String(address.port) }

  const child = spawn("node", [
    "--experimental-vfs",
    fileURLToPath(new URL("../src/workbench/server.ts", import.meta.url)),
    "--production"
  ], { env, stdio: "inherit" })

  const exited = once(child, "exit")

  try {
    const startup = AbortSignal.timeout(15_000)

    while (
      !(await fetch(origin + "/rpc", { signal: AbortSignal.any([startup, AbortSignal.timeout(1_000)]) })
        .then((response) => response.status === 404 || response.status === 405)
        .catch(() => false))
    ) {
      assert.ok(
        child.exitCode === null && child.signalCode === null && !startup.aborted,
        "Workbench RPC server did not start"
      )
      await setTimeout(50)
    }

    const shell = await fetch(origin, { signal: AbortSignal.timeout(5_000) })
    assert.equal(shell.status, 200)
    const html = await shell.text()
    assert.match(html, /<title>TypeScript workbench · Effect VFS<\/title>/)
    const entry = html.match(/<script[^>]*src="(\/assets\/[^"]+\.js)"/)?.[1]
    assert.ok(entry)
    assert.equal((await fetch(origin + entry, { signal: AbortSignal.timeout(5_000) })).status, 200)

    const protocol = RpcClient.layerProtocolHttp({ url: origin + "/rpc" }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(RpcSerialization.layerNdjson)
    )

    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const rpc = yield* RpcClient.make(WorkbenchRpc)
        const initial = yield* rpc.command({ action: "view", generation: 0, revision: 0, edits: [], role: "compiler" })

        const compiled = yield* rpc.command({
          action: "compile",
          generation: initial.generation,
          revision: initial.revision,
          edits: [],
          role: "compiler"
        })

        assert.equal(compiled.build?.status, "success")

        const ran = yield* rpc.command({
          action: "run",
          generation: compiled.generation,
          revision: compiled.revision,
          edits: [],
          role: "compiler"
        })

        assert.match(ran.output.map((item) => item.text).join(""), /1. Edit TypeScript/)
      })).pipe(Effect.provide(protocol), Effect.timeout("60 seconds"))
    )
  } finally {
    child.kill("SIGTERM")
    await Promise.race([exited, setTimeout(3_000, undefined, { ref: false })])

    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")

    await exited
  }
})
