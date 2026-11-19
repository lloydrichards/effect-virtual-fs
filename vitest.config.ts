import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import { sharedTestProjects } from "./tools/checks/repository.mjs"

const project = (name: string, directory: string) => ({
  test: {
    name,
    root: fileURLToPath(new URL(directory, import.meta.url)),
    include: ["test/**/*.test.ts"],
    benchmark: { include: ["benchmarks/**/*.bench.ts"] }
  }
})

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.reference/**"],
    // All projects run under Bun so the root test script can use one Vitest process.
    projects: sharedTestProjects.map(({ directory, name }) => {
      const config = project(name, `./${directory}/`)

      if (name === "nfs") config.test.include.push("benchmarks/*.test.ts")

      return config
    })
  }
})
