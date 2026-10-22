import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["mounted/**/*.test.ts"],
    setupFiles: ["./mounted/runtime.ts"],
    execArgv: ["--experimental-vfs"],
    fileParallelism: false
  }
})
