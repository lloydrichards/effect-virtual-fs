import path from "node:path"

const root = path.resolve(import.meta.dirname, "../build/client")

const origin = "https://docs.invalid"

const pages = new Map<string, { ids: Set<string>; links: Set<string> }>()

for await (const file of new Bun.Glob("**/index.html").scan(root)) {
  const route = "/" + file.slice(0, -"index.html".length)
  const ids = new Set<string>()
  const links = new Set<string>()
  const html = Bun.file(path.join(root, file))

  await new HTMLRewriter()
    .on("[id]", {
      element: (element) => {
        const id = element.getAttribute("id")

        if (id !== null) ids.add(id)
      }
    })
    .on("a[href]", {
      element: (element) => {
        const href = element.getAttribute("href")

        if (href !== null) links.add(href)
      }
    })
    .transform(new Response(html))
    .text()

  pages.set(route, { ids, links })
}

if (!pages.has("/")) throw new Error("Build the docs before checking the prerendered site")

const failures: Array<string> = []

for (const [route, page] of pages) {
  const source = new URL(route, origin)

  for (const href of page.links) {
    const target = new URL(href, source)

    if (target.origin !== origin) continue

    const targetPath = decodeURIComponent(target.pathname)

    const targetRoute = targetPath.endsWith("/index.html")
      ? targetPath.slice(0, -"index.html".length)
      : targetPath.endsWith("/")
      ? targetPath
      : targetPath + "/"

    const targetPage = pages.get(targetRoute)

    if (targetPage) {
      if (target.hash && !targetPage.ids.has(decodeURIComponent(target.hash.slice(1)))) {
        failures.push(`${route}: missing fragment in ${href}`)
      }
    } else if (!(await Bun.file(path.join(root, targetPath)).exists())) {
      failures.push(`${route}: missing target for ${href}`)
    }
  }
}

if (failures.length > 0) {
  throw new Error("Invalid internal documentation links:\n" + failures.sort().join("\n"))
}

console.log(`Internal links and fragments are valid across ${pages.size} prerendered pages.`)
