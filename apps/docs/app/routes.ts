import { index, prefix, route, type RouteConfig } from "@react-router/dev/routes"
import { apiPages } from "./api-pages"
import { contentPages } from "./content-pages"

const routes = [
  index("content/index.mdx"),
  ...contentPages.map(({ routePath, contentPath }) => route(routePath, contentPath)),
  ...prefix(
    "api",
    apiPages.map(({ routePath, contentPath }) => route(routePath, contentPath))
  )
] satisfies RouteConfig

export default routes
