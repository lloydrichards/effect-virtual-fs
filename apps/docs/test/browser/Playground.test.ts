import { expect, test } from "bun:test"
import { chromium, type Page } from "playwright-core"
import { previewDocs } from "./preview.ts"

// oxlint-disable-next-line effecttsgo/async-function -- Playwright and the preview server return Promises.
const withPlayground = async (run: (page: Page) => Promise<void>) => {
  // oxlint-disable-next-line effecttsgo/process-env -- Optionally qualify an existing docs preview.
  const previewUrl = process.env["DOCS_PREVIEW_URL"]

  const server = previewUrl ? undefined : await previewDocs()

  try {
    const url = previewUrl ?? server?.resolvedUrls?.local[0]

    if (!url) throw new Error("Docs preview server did not start")
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()
      const status = page.getByRole("status")

      const workspaceWorker = page.waitForEvent("worker", {
        predicate: (worker) => worker.url().includes("workspace.worker")
      })

      const response = await page.goto(new URL("examples/virtual-build", url).href)
      expect(response?.ok()).toBe(true)
      await workspaceWorker
      await status.filter({ hasText: "Starter files open in memory." }).waitFor({ timeout: 45_000 })
      await run(page)
    } finally {
      await browser.close()
    }
  } finally {
    await server?.close()
  }
}

const editor = (page: Page, path: string) => page.getByLabel("Edit " + path)

const build = (page: Page) => page.getByRole("button", { name: "Build and run" })

const runner = (page: Page) => page.locator("iframe[title=\"Playground bundle runner\"]")

test("smoke: the playground restores a checkpoint and runs the saved program", () =>
  // oxlint-disable-next-line effecttsgo/async-function -- Playwright uses Promise-based browser actions.
  withPlayground(async (page) => {
    const status = page.getByRole("status")
    await editor(page, "/src/value.js").fill("export const value = 37")
    await page.getByRole("button", { name: "Save checkpoint" }).click()
    await status.filter({ hasText: "Saved workspace.sqlite" }).waitFor()

    await page.reload()
    await editor(page, "/src/value.js").filter({ hasText: "20" }).waitFor()
    await page.getByRole("button", { name: "Reopen saved" }).click()
    await status.filter({ hasText: "Reopened the saved checkpoint." }).waitFor()
    await editor(page, "/src/value.js").filter({ hasText: "37" }).waitFor()

    await build(page).click()
    await page.getByLabel("Console output").filter({ hasText: "Reading: 37" }).waitFor()
    expect(await runner(page).count()).toBe(0)
  }), 60_000)

test("the playground removes timed-out runners and can run again", () =>
  // oxlint-disable-next-line effecttsgo/async-function -- Playwright uses Promise-based browser actions.
  withPlayground(async (page) => {
    await page.getByRole("button", { name: "/main.js", exact: true }).click()
    await editor(page, "/main.js").fill("await new Promise(() => {})")

    for (let run = 0; run < 2; run++) {
      await build(page).click()
      await runner(page).waitFor({ state: "attached" })
      await page.getByRole("alert").filter({ hasText: "Execution timed out after 5 seconds." }).waitFor()
      expect(await runner(page).count()).toBe(0)
    }

    await editor(page, "/main.js").fill("console.log(\"Still running\")")
    await build(page).click()
    await page.getByLabel("Console output").filter({ hasText: "Still running" }).waitFor()
    expect(await runner(page).count()).toBe(0)
  }), 90_000)
