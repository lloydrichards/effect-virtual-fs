import { preview } from "vite"
import type { TestProject } from "vitest/node"
import { workshopIsolation } from "../../workshop-isolation.ts"

// oxlint-disable-next-line effecttsgo/async-function -- Vitest global setup owns the local Vite preview.
export default async (project: TestProject) => {
  const server = await preview({
    configFile: false,
    plugins: [workshopIsolation],
    build: { outDir: "build/client" },
    preview: { host: "127.0.0.1", port: 0 },
    logLevel: "error"
  })

  const base = server.resolvedUrls?.local[0]

  if (!base) {
    await server.close()
    throw new Error("Docs preview server did not start")
  }

  project.provide("docsUrl", base)

  return () => server.close()
}
