import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import { sharedTestProjects } from "./tools/checks/repository.mjs"

const project = (name: string, directory: string) => ({
  test: {
    name,
    root: fileURLToPath(new URL(directory, import.meta.url)),
    include: name === "nfs" ? ["test/**/*.test.ts", "benchmarks/*.test.ts"] : ["test/**/*.test.ts"],
    exclude: ["test/HostFileSystem.test.ts"],
    benchmark: { include: ["benchmarks/**/*.bench.ts"] }
  }
})

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.reference/**"],
    // All projects run under Bun so the root test script can use one Vitest process.
    projects: sharedTestProjects.map(({ directory, name }) => project(name, `./${directory}/`))
  }
})
