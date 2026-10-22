// Each loader case gets a fresh process because Node routing and module caches are global.
/* eslint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { create, MemoryProvider } from "node:vfs"
import * as fs from "node:fs"
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto"
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import { NodeVirtualProvider } from "@effect-vfs/node"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"

const scope = Scope.makeUnsafe()

const volume = await Effect.runPromise(Vfs.make({ execution: "sync" }).pipe(Effect.provide(NodeCrypto.layer)))

const provider = await Effect.runPromise(NodeVirtualProvider.bind(volume).pipe(Effect.provideService(Scope.Scope, scope)))

const routing = create(provider)

const root = routing.mount()

const require = createRequire(import.meta.url)

const kind = process.argv[2]

try {
  if (kind === "routing") {
    const stock = create(new MemoryProvider())
    const stockRoot = stock.mount()

    try {
      for (const prefix of [root, stockRoot]) {
        fs.writeFileSync(`${prefix}/file`, "regular")
        assert.throws(() => fs.statSync(`${prefix}/file/child`), { code: "ENOENT" })
      }

      assert.throws(() => provider.statSync("/file/child"), { code: "ENOTDIR" })
    } finally {
      stock.unmount()
    }
  } else if (kind === "registry") {
    // Test-only access to the pinned runtime's registry proves removal, rather than inferring it from EBADF.
    const { getVirtualFd } = require("internal/vfs/fd")

    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(`${root}/held`, "owned")
      const fd = fs.openSync(`${root}/held`, "r+")
      const handle = await fs.promises.open(`${root}/held`, "r+")
      const promiseFd = handle.fd
      fs.unlinkSync(`${root}/held`)
      assert.ok(getVirtualFd(fd))
      assert.ok(getVirtualFd(promiseFd))
      fs.closeSync(fd)
      await handle.close()
      assert.equal(getVirtualFd(fd), undefined)
      assert.equal(getVirtualFd(promiseFd), undefined)
      assert.equal((await Effect.runPromise(volume.usage)).usedBytes, 0n)
    }
  } else {
    provider.mkdirSync("/app")
    provider.mkdirSync("/app/node_modules")
    provider.mkdirSync("/app/node_modules/local-dep")
    provider.writeFileSync("/app/node_modules/local-dep/package.json", JSON.stringify({ name: "local-dep", main: "index.cjs" }))
    provider.writeFileSync("/app/node_modules/local-dep/index.cjs", "module.exports = 40")

    if (kind === "cjs") {
      provider.writeFileSync("/app/entry.cjs", "module.exports = require('local-dep') + 2")
      const entry = `${root}/app/entry.cjs`
      assert.equal(require(entry), 42)
      provider.writeFileSync("/app/entry.cjs", "module.exports = 43")
      assert.equal(require(entry), 42)
      delete require.cache[entry]
      assert.equal(require(entry), 43)
      provider.writeFileSync("/app/boundary.cjs", "module.exports = require('effect')")
      assert.throws(() => require(`${root}/app/boundary.cjs`), { code: "MODULE_NOT_FOUND" })
      routing.unmount()
      assert.equal(require.cache[entry], undefined)
      assert.throws(() => require(entry))
      assert.equal(routing.mount(), root)
      assert.equal(require(entry), 43)
    } else {
      provider.writeFileSync("/app/entry.mjs", "import value from 'local-dep'; export default value + 2")
      const entry = pathToFileURL(`${root}/app/entry.mjs`).href
      assert.equal((await import(entry)).default, 42)
      provider.writeFileSync("/app/entry.mjs", "export default 43")
      assert.equal((await import(entry)).default, 42)
      assert.equal((await import(`${entry}?generation=2`)).default, 43)
      provider.writeFileSync("/app/boundary.mjs", "import 'effect'")
      await assert.rejects(import(pathToFileURL(`${root}/app/boundary.mjs`).href), { code: "ERR_MODULE_NOT_FOUND" })
      routing.unmount()
      await assert.rejects(import(entry))
      assert.equal(routing.mount(), root)
      assert.equal((await import(entry)).default, 43)
    }
  }
} finally {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  routing.unmount()
}

process.stdout.write(JSON.stringify({ kind, node: process.version, os: process.platform, arch: process.arch, result: "passed" }) + "\n")
