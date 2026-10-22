import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    setupFiles: ["./mounted/runtime.ts"],
    execArgv: ["--experimental-vfs"],
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: "mounted",
          include: ["mounted/**/*.test.ts"],
          exclude: ["mounted/Lifetime.test.ts"]
        }
      },
      {
        extends: true,
        test: {
          name: "ownership",
          include: ["mounted/Lifetime.test.ts"],
          execArgv: ["--experimental-vfs", "--expose-internals"]
        }
      }
    ]
  }
})
