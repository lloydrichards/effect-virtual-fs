import { expect, test } from "bun:test"
import { chromium } from "playwright-core"
import { preview } from "vite"

// oxlint-disable-next-line effecttsgo/async-function -- Playwright and the preview server return Promises.
test("the playground restores a checkpoint and cleans up completed and timed-out runners", async () => {
  // oxlint-disable-next-line effecttsgo/process-env -- Optionally qualify an existing docs preview.
  const previewUrl = process.env["DOCS_PREVIEW_URL"]

  const server = previewUrl ? undefined : await preview({
    configFile: false,
    build: { outDir: "build/client" },
    preview: { host: "127.0.0.1", port: 0 }
  })

  try {
    const url = previewUrl ?? server?.resolvedUrls?.local[0]

    if (!url) throw new Error("Docs preview server did not start")
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()
      const build = page.getByRole("button", { name: "Build and run" })
      const editor = (path: string) => page.getByLabel("Edit " + path)
      const status = page.getByRole("status")
      const runner = page.locator("iframe[title=\"Playground bundle runner\"]")

      const workspaceWorker = page.waitForEvent("worker", {
        predicate: (worker) => worker.url().includes("workspace.worker")
      })

      const response = await page.goto(new URL("examples/virtual-build", url).href)
      expect(response?.ok()).toBe(true)
      await workspaceWorker
      await status.filter({ hasText: "Starter files open in memory." }).waitFor({ timeout: 45_000 })
      await editor("/src/value.js").fill("export const value = 37")
      await page.getByRole("button", { name: "Save checkpoint" }).click()
      await status.filter({ hasText: "Saved workspace.sqlite" }).waitFor()

      await page.reload()
      await editor("/src/value.js").filter({ hasText: "20" }).waitFor()
      await page.getByRole("button", { name: "Reopen saved" }).click()
      await status.filter({ hasText: "Reopened the saved checkpoint." }).waitFor()
      await editor("/src/value.js").filter({ hasText: "37" }).waitFor()

      await build.click()
      await page.getByLabel("Console output").filter({ hasText: "Reading: 37" }).waitFor()
      expect(await runner.count()).toBe(0)

      await page.getByRole("button", { name: "/main.js", exact: true }).click()
      await editor("/main.js").fill("await new Promise(() => {})")

      for (let run = 0; run < 2; run++) {
        await build.click()
        await runner.waitFor({ state: "attached" })
        await page.getByRole("alert").filter({ hasText: "Execution timed out after 5 seconds." }).waitFor()
        expect(await runner.count()).toBe(0)
      }

      await editor("/main.js").fill("console.log(\"Still running\")")
      await build.click()
      await page.getByLabel("Console output").filter({ hasText: "Still running" }).waitFor()
      expect(await runner.count()).toBe(0)
    } finally {
      await browser.close()
    }
  } finally {
    await server?.close()
  }
}, 90_000)
