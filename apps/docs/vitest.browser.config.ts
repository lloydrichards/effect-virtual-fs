import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"
import {
  playground,
  playgroundRecovery,
  staticPages,
  workshop,
  workshopImageFailure,
  workshopRetile,
  workshopTimeout
} from "./test/browser/commands.ts"

export default defineConfig({
  test: {
    include: ["test/browser/*.browser.test.ts"],
    globalSetup: ["./test/browser/preview.ts"],
    attachmentsDir: ".cache/browser-test-attachments",
    testTimeout: 60_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      commands: {
        staticPages,
        playground,
        playgroundRecovery,
        workshop,
        workshopImageFailure,
        workshopRetile,
        workshopTimeout
      }
    }
  }
})
