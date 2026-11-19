import { expect, test } from "bun:test"
import { chromium } from "playwright-core"
import { previewDocs } from "./preview.ts"

// oxlint-disable-next-line effecttsgo/async-function -- Playwright and the preview server return Promises.
test("smoke: the built docs serve prerendered landing, guide, and API pages", async () => {
  const server = await previewDocs()

  try {
    const base = server.resolvedUrls?.local[0]

    if (!base) throw new Error("Docs preview server did not start")

    const browser = await chromium.launch()

    try {
      const page = await browser.newPage({ javaScriptEnabled: false })

      for (
        const [route, heading] of [
          ["/", "Effect VirtualFileSystem"],
          ["/getting-started/", "Getting started"],
          ["/api/memory/memory-file-system/", "MemoryFileSystem.ts overview"]
        ] as const
      ) {
        const response = await page.goto(new URL(route, base).href)
        expect(response?.status()).toBe(200)
        const title = page.getByRole("heading", { level: 1 })
        expect((await title.textContent())?.trim()).toBe(heading)

        const styles = await page.locator("link[rel=\"stylesheet\"]").evaluateAll((links) =>
          links.map((link) => link.getAttribute("href"))
        )

        expect(styles.length).toBeGreaterThan(0)

        for (const href of styles) {
          if (href === null) throw new Error("Stylesheet has no href on " + route)
          const stylesheet = await page.request.get(new URL(href, base).href)
          expect(stylesheet.status()).toBe(200)
          expect(stylesheet.headers()["content-type"]).toContain("text/css")
        }
      }
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
  }
}, 30_000)
