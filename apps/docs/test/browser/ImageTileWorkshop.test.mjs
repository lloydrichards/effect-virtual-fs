/* oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/process-env -- The standalone browser test drives Playwright and Vite through their native Node APIs. */
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { localHost, previewDocs } from "./preview.ts"

const withWorkshop = async (run) => {
  const url = process.env.WORKSHOP_URL

  const server = url ? undefined : process.env.WORKSHOP_DEV
    ? await (await createServer({ server: localHost, logLevel: "error" })).listen()
    : await previewDocs()

  const files = await mkdtemp(path.join(tmpdir(), "image-tiles-"))
  const address = server?.httpServer?.address()
  assert.ok(url || (address && Object.hasOwn(address, "port")))

  try {
    const browser = await chromium.launch(
      process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
    )

    try {
      const page = await browser.newPage({ acceptDownloads: true })
      page.setDefaultTimeout(45_000)
      const base = url ?? `http://127.0.0.1:${address.port}`
      const guideUrl = new URL("/examples/image-tile-workshop", base).href
      const workshop = page.getByRole("region", { name: "Image tile workshop" })
      const inspector = page.getByRole("complementary", { name: "Tile inspector" })
      const errors = []
      page.on("pageerror", (error) => errors.push(error.message))

      const download = async (filename) => {
        const [file] = await Promise.all([
          page.waitForEvent("download", { timeout: 6000 }),
          page.getByRole("button", { name: "Download PNG" }).click()
        ]).catch(async (error) => {
          throw new Error(await page.locator("body").innerText(), { cause: error })
        })

        assert.equal(file.suggestedFilename(), "result.png")
        const target = path.join(files, filename)
        await file.saveAs(target)

        return readFile(target)
      }

      await run({
        browser,
        page,
        base,
        guideUrl,
        workshop,
        inspector,
        download,
        errors,
        localPreview: !url && !process.env.WORKSHOP_DEV
      })
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  } finally {
    await server?.close()
    await rm(files, { recursive: true, force: true })
  }
}

const renderSample = async (page, errors) => {
  await page.getByRole("button", { name: "Render", exact: true }).click().catch(async (error) => {
    throw new Error([await page.locator("body").innerText(), ...errors.map(String)].join("\n"), { cause: error })
  })
  await page.getByText("12 of 12 tiles visible", { exact: true }).waitFor({ timeout: 20_000 }).catch(
    async (error) => {
      throw new Error(await page.locator("body").innerText(), { cause: error })
    }
  )
  assert.match(await page.getByLabel("Render details").innerText(), /SharedArrayBuffer/)
}

const workerHandoff = async ({ page, inspector, download, errors }) => {
  await renderSample(page, errors)
  const before = await download("before.png")
  assert.equal(before.subarray(1, 4).toString(), "PNG")

  const emptyHeight = (await inspector.boundingBox()).height
  await page.getByRole("button", { name: "Tile 6, Visible", exact: true }).click()
  assert.equal((await inspector.boundingBox()).height, emptyHeight)
  await inspector.getByText("Tile history", { exact: true }).click()
  await inspector.getByText("Version 1 · Worker 3").waitFor()
  assert.equal(await inspector.getByText("/tiles/2-2.png").count(), 1)
  await inspector.getByRole("button", { name: "Rebuild tile" }).click()
  await inspector.getByText("Worker 3 → Worker 1.", { exact: false }).waitFor()
  assert.equal(await inspector.getByText("Version 1 · Worker 3").count(), 1)
  await inspector.getByText("Committed · awaiting compositor").waitFor()
  assert.equal(await inspector.getByText("Version 1 · Worker 3").count(), 1)
  await inspector.getByText("Version 2 · Worker 1").waitFor()
  assert.equal(await inspector.getByText("Compositor opened version 2", { exact: false }).count(), 1)
  assert.deepEqual(await download("after.png"), before)

  return before
}

void test("smoke: the Workshop hands a tile to another worker and exports the image", () =>
  withWorkshop(async (fixture) => {
    await fixture.page.goto(fixture.guideUrl)
    assert.equal(await fixture.page.evaluate(() => crossOriginIsolated), true)
    await workerHandoff(fixture)
  }))

void test("the Workshop applies selected effects and swaps exported tile positions", () =>
  withWorkshop(async (fixture) => {
    const { page, workshop, inspector, download } = fixture
    await page.goto(fixture.guideUrl)
    const before = await workerHandoff(fixture)
    const details = page.getByLabel("Render details")
    assert.equal(
      await details.getByRole("progressbar", { name: "Compositor tiles applied" }).getAttribute("value"),
      "1"
    )
    await page.getByRole("button", { name: "Tile 7, Visible", exact: true }).click({ modifiers: ["Shift"] })
    await page.getByRole("button", { name: "Invert colors", exact: true }).click()
    await inspector.getByRole("button", { name: "Rebuild 2 tiles" }).click()
    await inspector.getByText("Version 2 · Worker 2", { exact: true }).waitFor()
    await page.getByText("2/2 applied", { exact: true }).waitFor()
    const inverted = await download("inverted.png")
    assert.notDeepEqual(inverted, before)

    const tile6 = workshop.getByRole("button", { name: "Tile 6, Visible", exact: true })
    const tile7 = workshop.getByRole("button", { name: "Tile 7, Visible", exact: true })
    await tile6.click()
    assert.equal(await tile7.getAttribute("aria-pressed"), "false")
    const position = await tile6.getAttribute("style")
    const swap = inspector.getByRole("combobox", { name: "Swap with position" })
    await swap.selectOption("0")
    await page.waitForFunction(() => document.querySelector("[aria-label=\"Tile 6, Visible\"]").style.left === "0%")
    const swapped = await download("swapped.png")
    assert.notDeepEqual(swapped, inverted)
    await swap.selectOption("5")
    await page.waitForFunction(
      (style) => document.querySelector("[aria-label=\"Tile 6, Visible\"]").getAttribute("style") === style,
      position
    )
    assert.deepEqual(await download("restored.png"), inverted)

    await workshop.getByText("Inspect virtual filesystem", { exact: true }).click()
    const tree = page.getByRole("list", { name: "Virtual filesystem" })
    await tree.getByText("result.png", { exact: true }).waitFor()
    await tree.getByRole("button", { name: "2-2.png v3" }).click()
    await inspector.getByText("Version 3 · Worker 2", { exact: true }).waitFor()
    assert.equal(await inspector.getByText("Invert colors", { exact: true }).count(), 1)
    const multiSelect = workshop.getByRole("button", { name: "Multi-select", exact: true })
    await multiSelect.click()
    await tile7.click()
    assert.equal(await tile6.getAttribute("aria-pressed"), "true")
    assert.equal(await tile7.getAttribute("aria-pressed"), "true")
    await multiSelect.click()
    const sepia = workshop.getByRole("button", { name: "Sepia", exact: true })
    await sepia.click()
    assert.equal(await sepia.getAttribute("aria-pressed"), "true")
    await inspector.getByRole("button", { name: "Rebuild 2 tiles" }).click()
    await inspector.getByText("Sepia", { exact: true }).waitFor()
    await page.getByText("2/2 applied", { exact: true }).waitFor()
    assert.notDeepEqual(await download("sepia.png"), inverted)
  }))

void test("the Workshop preserves odd-sized blur output when the tile grid changes", () =>
  withWorkshop(async ({
    page,
    guideUrl,
    workshop,
    inspector,
    download
  }) => {
    await page.goto(guideUrl)
    await page.getByRole("button", { name: "Blur", exact: true }).click()

    const fixture = await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = 17
      canvas.height = 13
      const context = canvas.getContext("2d")

      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const value = (x * 41 + y * 23) % 256
          context.fillStyle = `rgb(${value}, ${value}, ${value})`
          context.fillRect(x, y, 1, 1)
        }
      }

      return canvas.toDataURL("image/png").split(",")[1]
    })

    await page.getByLabel("Open image file").setInputFiles({
      name: "uneven-grid.png",
      mimeType: "image/png",
      buffer: Buffer.from(fixture, "base64")
    })
    await page.getByText("uneven-grid.png", { exact: true }).waitFor()
    await page.getByText("12 of 12 tiles visible", { exact: true }).waitFor()
    const odd = await download("uneven.png")

    const decoded = await page.evaluate(async (base64) => {
      const image = new Image()
      image.src = "data:image/png;base64," + base64
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")
      context.drawImage(image, 0, 0)

      return {
        width: canvas.width,
        height: canvas.height,
        bytes: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data)
      }
    }, odd.toString("base64"))

    assert.equal(decoded.width, 17)
    assert.equal(decoded.height, 13)
    const clamp = (index, size) => Math.max(0, Math.min(size - 1, index))
    const expected = []

    for (let y = 0; y < 13; y++) {
      for (let x = 0; x < 17; x++) {
        let sum = 0

        for (let dy = -6; dy <= 6; dy++) {
          for (let dx = -6; dx <= 6; dx++) {
            sum += (clamp(x + dx, 17) * 41 + clamp(y + dy, 13) * 23) % 256
          }
        }

        const value = Math.round(sum / 169)
        expected.push(value, value, value, 255)
      }
    }

    assert.deepEqual(decoded.bytes, expected)

    await workshop.getByText("Render settings", { exact: true }).click()
    await workshop.getByRole("combobox", { name: "Workers" }).selectOption("2")
    await workshop.getByRole("combobox", { name: "Tile grid" }).selectOption("2x2")
    await workshop.getByRole("button", { name: "Render", exact: true }).click()
    await workshop.getByText("4 of 4 tiles visible", { exact: true }).waitFor()
    assert.equal(await workshop.getByRole("progressbar", { name: /tiles published/ }).count(), 2)
    assert.deepEqual(await download("retiled.png"), odd)
    await workshop.getByRole("button", { name: "Tile 4, Visible", exact: true }).click()
    await inspector.getByText("/tiles/2-2.png").waitFor()
    await inspector.getByRole("button", { name: "Rebuild tile" }).click()
    await inspector.getByText("Version 2 · Worker 1").waitFor()

    await workshop.getByRole("combobox", { name: "Workers" }).selectOption("4")
    await workshop.getByRole("combobox", { name: "Tile grid" }).selectOption("6x4")
    await workshop.getByRole("button", { name: "Render", exact: true }).click()
    await workshop.getByText("24 of 24 tiles visible", { exact: true }).waitFor()
    assert.equal(await workshop.getByRole("progressbar", { name: /tiles published/ }).count(), 4)
    assert.deepEqual(await download("larger-grid.png"), odd)
    await workshop.getByRole("button", { name: "Load sample" }).click()
    assert.equal(await workshop.getByText("Evening ridgeline", { exact: true }).count(), 1)
    assert.equal(await workshop.getByRole("button", { name: "Download PNG" }).isDisabled(), true)
  }))

void test("the Workshop isolates its route and preserves the prerendered layout", () =>
  withWorkshop(async ({
    browser,
    page,
    base,
    guideUrl,
    workshop,
    localPreview
  }) => {
    await page.goto(base, { waitUntil: "networkidle" })
    assert.equal(await page.evaluate(() => crossOriginIsolated), false)

    await Promise.all([
      page.waitForURL(guideUrl, { waitUntil: "networkidle" }),
      page.getByRole("link", { name: "Image Tile Workshop", exact: true }).first().click()
    ])
    assert.equal(await page.evaluate(() => crossOriginIsolated), true)
    const steps = page.getByRole("heading", { name: "Follow the worker handoff" })
    await steps.waitFor()
    assert.equal(
      await workshop.evaluate((element) =>
        Boolean(
          element.compareDocumentPosition(document.getElementById("follow-the-worker-handoff")) &
            Node.DOCUMENT_POSITION_FOLLOWING
        )
      ),
      true
    )

    if (localPreview) {
      const prerendered = await browser.newPage({ javaScriptEnabled: false })

      try {
        await prerendered.goto(guideUrl)
        const initialWorkshop = prerendered.getByRole("region", { name: "Image tile workshop" })
        const initialSteps = prerendered.getByRole("heading", { name: "Follow the worker handoff" })
        await Promise.all([
          prerendered.evaluate(() => document.fonts.ready.then(() => {})),
          page.evaluate(() => document.fonts.ready.then(() => {}))
        ])
        assert.equal(await initialWorkshop.getByRole("button", { name: "Render", exact: true }).isDisabled(), true)
        assert.equal(await workshop.getByRole("button", { name: "Render", exact: true }).isEnabled(), true)
        assert.ok(Math.abs((await initialSteps.boundingBox()).y - (await steps.boundingBox()).y) < 1)
      } finally {
        await prerendered.close()
      }
    }

    assert.equal(page.url(), guideUrl)

    await Promise.all([
      page.waitForURL("**/getting-started", { waitUntil: "domcontentloaded" }),
      page.getByRole("link", { name: "Getting Started", exact: true }).first().click()
    ])
    assert.equal(await page.evaluate(() => crossOriginIsolated), false)

    const legacy = await page.request.get(guideUrl + "/run", { maxRedirects: 0 })
    assert.equal(legacy.status(), 308)
    assert.equal(legacy.headers()["location"], "/examples/image-tile-workshop")
  }))
