import { index, prefix, route, type RouteConfig } from "@react-router/dev/routes"
import { apiPages } from "./api-pages"

const routes = [
  index("content/index.mdx"),
  ...prefix(
    "api",
    apiPages.map(({ routePath, contentPath }) => route(routePath, contentPath))
  )
] satisfies RouteConfig

export default routes
