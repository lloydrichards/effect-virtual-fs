import { preview } from "vite"
import { workshopIsolation } from "../../workshop-isolation.ts"

export const localHost = { host: "127.0.0.1", port: 0 }

export const previewDocs = () =>
  preview({
    configFile: false,
    plugins: [workshopIsolation],
    build: { outDir: "build/client" },
    preview: localHost,
    logLevel: "error"
  })
