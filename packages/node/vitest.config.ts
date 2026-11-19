import { defineConfig } from "vitest/config"

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["test/**/*.test.ts"],
    benchmark: { include: ["benchmarks/**/*.bench.ts"] },
    execArgv: ["--experimental-vfs"]
  }
})
