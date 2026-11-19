/* oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import -- Browser commands drive Playwright's top-level pages and read its downloaded artifact. */
import { readFile } from "node:fs/promises"
import type { Page } from "playwright"
import { expect } from "vitest"
import type { BrowserCommandContext } from "vitest/node"

const visit = async (
  context: BrowserCommandContext,
  base: string,
  route: string,
  run: (page: Page) => Promise<void>
) => {
  const page = await context.context.newPage()

  try {
    const response = await page.goto(new URL(route, base).href)
    expect(response?.ok()).toBe(true)
    await run(page)
  } finally {
    await page.close()
  }
}

export const staticPages = async (context: BrowserCommandContext, base: string) => {
  const browser = context.context.browser()

  if (!browser) throw new Error("Browser Mode did not provide Chromium")

  const isolated = await browser.newContext({ javaScriptEnabled: false })

  try {
    const page = await isolated.newPage()

    for (
      const [route, title] of [
        ["/", "Effect VirtualFileSystem"],
        ["/getting-started/", "Getting started"],
        ["/api/memory/memory-file-system/", "MemoryFileSystem.ts overview"]
      ] as const
    ) {
      expect((await page.goto(new URL(route, base).href))?.status()).toBe(200)

      expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe(title)

      if (route === "/") {
        const stylesheet = await page.locator("link[rel=\"stylesheet\"]").first().getAttribute("href")

        if (!stylesheet) throw new Error("Landing page stylesheet is missing")

        const asset = await page.request.get(new URL(stylesheet, base).href)
        expect(asset.status()).toBe(200)
        expect(asset.headers()["content-type"]).toContain("text/css")
      }
    }
  } finally {
    await isolated.close()
  }
}

export const playground = (context: BrowserCommandContext, base: string) =>
  visit(context, base, "/examples/virtual-build", async (page) => {
    const status = page.getByRole("status")
    const edit = (path: string) => page.getByLabel("Edit " + path)
    const run = page.getByRole("button", { name: "Build and run" })
    await status.filter({ hasText: "Starter files open in memory." }).waitFor()
    await edit("/src/value.js").fill("export const value = 37")
    await page.getByRole("button", { name: "Save checkpoint" }).click()
    await status.filter({ hasText: "Saved workspace.sqlite" }).waitFor()
    await page.reload()
    await page.getByRole("button", { name: "Reopen saved" }).click()
    await status.filter({ hasText: "Reopened the saved checkpoint." }).waitFor()
    await run.click()
    await page.getByLabel("Console output").filter({ hasText: "Reading: 37" }).waitFor()
  })

export const playgroundRecovery = (context: BrowserCommandContext, base: string) =>
  visit(context, base, "/examples/virtual-build", async (page) => {
    const editor = page.getByLabel("Edit /main.js")
    const run = page.getByRole("button", { name: "Build and run" })
    await page.getByRole("button", { name: "/main.js", exact: true }).click()
    await editor.fill("await new Promise(() => {})")
    await run.click()
    await page.getByRole("alert").filter({ hasText: "Execution timed out after 5 seconds." }).waitFor()
    await page.getByTitle("Playground bundle runner").waitFor({ state: "detached" })
    await editor.fill("console.log(\"Still running\")")
    await run.click()
    await page.getByLabel("Console output").filter({ hasText: "Still running" }).waitFor()
  })

const exportPng = async (page: Page) => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download PNG" }).click()
  ])

  expect(download.suggestedFilename()).toBe("result.png")

  return readFile(await download.path())
}

export const workshop = (context: BrowserCommandContext, base: string) =>
  visit(context, base, "/", async (page) => {
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false)
    await page.getByRole("link", { name: "Image Tile Workshop", exact: true }).first().click()
    await page.waitForURL(new URL("/examples/image-tile-workshop", base).href)
    await page.waitForFunction(() => crossOriginIsolated)
    await page.getByRole("button", { name: "Render", exact: true }).click()
    await page.getByText("12 of 12 tiles visible", { exact: true }).waitFor()
    const before = await exportPng(page)
    expect(before.subarray(1, 4).toString()).toBe("PNG")

    await page.getByRole("button", { name: "Tile 6, Visible", exact: true }).click()

    const inspector = page.getByRole("complementary", { name: "Tile inspector" })
    await inspector.getByText("Tile history", { exact: true }).click()
    await inspector.getByText("Version 1 · Worker 3").waitFor()
    await inspector.getByRole("button", { name: "Rebuild tile" }).click()
    await inspector.getByText("Version 2 · Worker 1").waitFor()
    expect(await exportPng(page)).toEqual(before)

    const legacy = await page.request.get(new URL("/examples/image-tile-workshop/run", base).href, { maxRedirects: 0 })
    expect(legacy.status()).toBe(308)
    expect(legacy.headers()["location"]).toBe("/examples/image-tile-workshop")
  })

export const workshopRetile = (context: BrowserCommandContext, base: string) =>
  visit(context, base, "/examples/image-tile-workshop", async (page) => {
    const fixture = await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = 17
      canvas.height = 13
      const drawing = canvas.getContext("2d")!
      drawing.fillStyle = "red"
      drawing.fillRect(0, 0, 8, 13)
      drawing.fillStyle = "blue"
      drawing.fillRect(8, 0, 9, 13)

      return canvas.toDataURL().split(",")[1]!
    })

    await page.getByRole("button", { name: "Normal", exact: true }).click()
    await page.getByLabel("Open image file").setInputFiles({
      name: "uneven-grid.png",
      mimeType: "image/png",
      buffer: Buffer.from(fixture, "base64")
    })
    await page.getByText("uneven-grid.png", { exact: true }).waitFor()
    await page.getByText("12 of 12 tiles visible", { exact: true }).waitFor()
    const normal = await exportPng(page)
    await page.getByRole("button", { name: "Blur", exact: true }).click()
    await page.getByRole("button", { name: "Render", exact: true }).click()
    await page.getByText("12 of 12 tiles visible", { exact: true }).waitFor()
    const blurred = await exportPng(page)
    expect(blurred).not.toEqual(normal)

    const workshop = page.getByRole("region", { name: "Image tile workshop" })
    await workshop.getByText("Render settings", { exact: true }).click()
    await page.getByRole("combobox", { name: "Tile grid" }).selectOption("2x2")
    await page.getByRole("button", { name: "Render", exact: true }).click()
    await page.getByText("4 of 4 tiles visible", { exact: true }).waitFor()
    expect(await exportPng(page)).toEqual(blurred)
  })
