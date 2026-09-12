import { MDXProvider } from "@mdx-js/react"
import { useEffect, useState } from "react"
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useMatches
} from "react-router"
import { AppSidebar } from "~/components/app-sidebar"
import { DocFooter } from "~/components/doc-footer"
import { GithubIcon } from "~/components/icons"
import { TableOfContents } from "~/components/table-of-contents"
import { ThemeToggle } from "~/components/theme-toggle"
import { proseComponents } from "~/components/tokens/prose-components"
import { Button } from "~/components/ui/button"
import { SidebarProvider, SidebarTrigger, useSidebar } from "~/components/ui/sidebar"
import type { TOCItem } from "~/lib/remark-toc-export"
import type { Route } from "./+types/root"
import "./app.css"

export const meta: Route.MetaFunction = () => [
  { title: "Effect VirtualFileSystem" },
  {
    name: "description",
    content: "In-memory virtual filesystem packages for Effect programs."
  }
]

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }
]

const themeScript = `
(function() {
  var theme = localStorage.getItem('theme');
  if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
})();
`

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Meta />
        <Links />
      </head>
      <body>
        <SidebarProvider>
          <AppSidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <SiteHeader />
            <main className="w-full flex-1 px-5 py-9 sm:px-8 lg:py-12 xl:px-14 xl:pr-[15rem]">
              {children}
            </main>
          </div>
        </SidebarProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  const matches = useMatches()
  const location = useLocation()
  const lastMatch = matches[matches.length - 1]
  // biome-ignore lint/suspicious/noExplicitAny: React Router's useMatches handle is untyped
  const routeToc: TOCItem[] = (lastMatch?.handle as any)?.toc ?? []
  const [toc, setToc] = useState(routeToc)

  useEffect(() => {
    const headings = Array.from(
      document.querySelectorAll<HTMLElement>(
        "main h2[id], main h3[id], main h4[id]"
      )
    )
    setToc(
      headings.map((heading) => ({
        id: heading.id,
        value: heading.textContent?.trim() ?? heading.id,
        depth: Number(heading.tagName.slice(1))
      }))
    )
  }, [location.pathname])

  const hasToc = toc.length > 0
  return (
    <MDXProvider components={proseComponents}>
      {hasToc && <TableOfContents toc={toc} />}
      <div className="mx-auto w-full max-w-[70ch]">
        <Outlet />
        <DocFooter />
      </div>
      {hasToc && <TableOfContents toc={toc} desktopOnly />}
    </MDXProvider>
  )
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!"
  let details = "An unexpected error occurred."
  let stack: string | undefined
  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error"
    details = error.status === 404
      ? "The requested page could not be found."
      : error.statusText || details
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message
    stack = error.stack
  }
  return (
    <main className="container mx-auto p-4 pt-16">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full overflow-x-auto p-4">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  )
}

function SiteHeader() {
  const { state, isMobile } = useSidebar()
  const sidebarVisible = state === "expanded" && !isMobile
  return (
    <header className="sticky top-0 z-10 flex items-center gap-3 border-border/60 border-b bg-background/85 px-5 py-3.5 backdrop-blur-xl sm:px-8">
      <SidebarTrigger className="size-11 md:size-8" />
      {!sidebarVisible && (
        <Link
          to="/"
          className="font-heading text-base font-semibold tracking-[-0.035em]"
        >
          effect-virtual-fs
        </Link>
      )}
      <div className="flex-1" />
      <Button
        render={
          <a
            href="https://github.com/lloydrichards/effect-virtual-fs"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
          />
        }
        variant="ghost"
        size="icon"
        className="size-11 text-muted-foreground hover:text-foreground md:size-8"
      >
        <GithubIcon />
      </Button>
      <ThemeToggle />
    </header>
  )
}
