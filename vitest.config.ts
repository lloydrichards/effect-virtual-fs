import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const project = (name: string, directory: string) => ({
  test: {
    name,
    root: fileURLToPath(new URL(directory, import.meta.url)),
    include: ["test/**/*.test.ts"]
  }
})

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.reference/**"],
    // All projects run under Bun so the root test script can use one Vitest process.
    projects: [
      project("core", "./packages/core/"),
      project("memory", "./packages/memory/"),
      project("nfs", "./packages/nfs/"),
      project("persistence", "./packages/persistence/"),
      project("demo-overlay", "./apps/demo-overlay/"),
      project("scratchpad", "./apps/scratchpad/"),
      project("virtual-build", "./apps/virtual-build/")
    ]
  }
})
