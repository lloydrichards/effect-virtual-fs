import { defineConfig } from "tsdown"

const dependencies = {
  alwaysBundle: [/^@effect-vfs\/effect-preview(?:\/|$)/],
  neverBundle: [/^effect(?:\/|$)/]
}

export default defineConfig({
  // The capacity runner uses the internal model to pause admission on the measured volume.
  entry: ["src/*.ts", "src/internal/model.ts"],
  deps: { ...dependencies, dts: dependencies },
  dts: true,
  format: ["esm"],
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  tsconfig: "tsconfig.build.json",
  copy: [{ from: "../effect-preview/LICENSE", rename: "LICENSE.effect-preview" }]
})
