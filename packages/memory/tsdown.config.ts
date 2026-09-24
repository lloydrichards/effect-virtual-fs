import { defineConfig } from "tsdown"

export default defineConfig({
  dts: false,
  entry: ["src/index.ts", "src/MemoryFileSystem.ts", "src/TreeTransfer.ts"],
  deps: {
    neverBundle: ["effect"]
  },
  format: ["esm"],
  outExtensions: () => ({ js: ".js" }),
  sourcemap: false,
  target: "es2022"
})
