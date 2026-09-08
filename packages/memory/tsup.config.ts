import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: false,
  entry: ["src/index.ts", "src/MemoryFileSystem.ts"],
  external: ["effect"],
  format: ["esm"],
  sourcemap: false,
  target: "es2022"
})
