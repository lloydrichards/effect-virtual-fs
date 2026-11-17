import { defineConfig } from "oxlint"

export default defineConfig({
  jsPlugins: [{ name: "anti-slop", specifier: "./anti-slop/index.ts" }],
  categories: { correctness: "off" },
  rules: {
    "anti-slop/no-known-value-widening": "warn",
    "anti-slop/no-unknown-parameters": "warn"
  }
})
