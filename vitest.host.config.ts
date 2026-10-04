import process from "node:process"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

process.stdout.write(
  `FileSystem host: platform-node-shared 4.0.0, Node ${process.version}, ${process.platform}/${process.arch}\n`
)

// Run both providers in a real Node process, separately from the Bun workspace suite.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL("./packages/memory/", import.meta.url)),
    include: ["test/HostFileSystem.test.ts", "test/MemoryFileSystem.test.ts"]
  }
})
