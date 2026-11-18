import type { Plugin, PreviewServer, ViteDevServer } from "vite"
import { formerWorkshopPage, workshopHeaders, workshopPage } from "./app/lib/workshop-route.ts"

function isolateWorkshop(server: ViteDevServer | PreviewServer) {
  server.middlewares.use((request, response, next) => {
    const pathname = request.url?.split("?")[0]?.replace(/\/$/, "")

    if (pathname === formerWorkshopPage) {
      response.statusCode = 308
      response.setHeader("Location", workshopPage)
      response.end()

      return
    }

    if (
      pathname === workshopPage ||
      pathname?.startsWith("/app/examples/image-tile-workshop/") ||
      pathname && /^\/assets\/(?:image|workshop)\.worker-[^/]+\.js$/.test(pathname)
    ) {
      for (const [name, value] of Object.entries(workshopHeaders)) response.setHeader(name, value)
    }

    next()
  })
}

export const workshopIsolation: Plugin = {
  name: "image-tile-workshop-isolation",
  configureServer: isolateWorkshop,
  configurePreviewServer(server) {
    isolateWorkshop(server)
    server.middlewares.use((request, _response, next) => {
      const [pathname, search] = request.url?.split("?") ?? []

      if (pathname === workshopPage) {
        request.url = pathname + "/index.html" + (search ? "?" + search : "")
      }

      next()
    })
  }
}
